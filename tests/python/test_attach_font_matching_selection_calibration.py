from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable, Mapping
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "attach_font_matching_selection_calibration.py"
SPEC = importlib.util.spec_from_file_location(
    "attach_font_matching_selection_calibration_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
ATTACH = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ATTACH
SPEC.loader.exec_module(ATTACH)


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(ATTACH.json_bytes(value, pretty=True))


def descriptor(path: Path) -> dict[str, Any]:
    return ATTACH._artifact_descriptor(path, file_name=path.name)


class Fixture:
    def __init__(self, root: Path, *, candidate_count: int = 2) -> None:
        self.root = root
        self.runtime = root / "runtime-source"
        self.output = root / "runtime-attached"
        self.calibration = root / ATTACH.SELECTION_CALIBRATION_FILE
        self.candidate_ids = tuple(
            f"font-{index:02d}" for index in range(candidate_count)
        )
        self.catalog_registry_sha = ATTACH.sha256_bytes(b"catalog-registry")
        self.model_version = "font-matching-runtime-v1-fixture"
        self.runtime.mkdir(parents=True)
        self._write_runtime()
        self._write_calibration()

    def _write_runtime(self) -> None:
        payloads = {
            ATTACH.ENCODER_FILE: b"encoder-onnx",
            ATTACH.RANKER_FILE: b"ranker-onnx",
            ATTACH.PROTOTYPE_FILE: b"prototype-features",
        }
        for name, payload in payloads.items():
            (self.runtime / name).write_bytes(payload)
        active_catalog = ATTACH.seal_record(
            {
                "candidate_count": len(self.candidate_ids),
                "candidate_ids": list(self.candidate_ids),
                "candidate_order_sha256": ATTACH._ordered_values_sha256(
                    self.candidate_ids
                ),
                "candidates": [],
                "catalog_version": "fixture-catalog-v1",
                "excluded_candidates": [],
                "locale": "ko",
                "record_type": ATTACH.ACTIVE_CATALOG_RECORD_TYPE,
                "schema_version": ATTACH.ACTIVE_CATALOG_SCHEMA_VERSION,
                "source_records": {},
            }
        )
        write_json(self.runtime / ATTACH.ACTIVE_CATALOG_FILE, active_catalog)
        artifacts = {
            name: descriptor(self.runtime / name) for name in ATTACH.BASE_ASSET_FILES
        }
        contract = ATTACH.seal_record(
            {
                "artifacts": artifacts,
                "catalog": {
                    "active_catalog_record_sha256": active_catalog["record_sha256"],
                    "candidate_count": len(self.candidate_ids),
                    "candidate_ids": list(self.candidate_ids),
                    "candidate_order_sha256": ATTACH._ordered_values_sha256(
                        self.candidate_ids
                    ),
                    "catalog_registry_sha256": self.catalog_registry_sha,
                    "catalog_version": active_catalog["catalog_version"],
                },
                "encoder": {"onnx_sha256": artifacts[ATTACH.ENCODER_FILE]["sha256"]},
                "head": {"onnx_sha256": artifacts[ATTACH.RANKER_FILE]["sha256"]},
                "model_version": self.model_version,
                "record_type": ATTACH.RUNTIME_RECORD_TYPE,
                "schema_version": ATTACH.RUNTIME_SCHEMA_VERSION,
            }
        )
        write_json(self.runtime / ATTACH.CONTRACT_FILE, contract)
        self._rewrite_marker()

    def _rewrite_marker(self) -> None:
        names = (ATTACH.CONTRACT_FILE, *ATTACH.BASE_ASSET_FILES)
        write_json(
            self.runtime / ATTACH.MARKER_FILE,
            {
                "artifacts": {
                    name: ATTACH.sha256_file(self.runtime / name) for name in names
                },
                "owner": ATTACH.RUNTIME_OWNER,
                "safe_replace": True,
                "schema_version": ATTACH.RUNTIME_SCHEMA_VERSION,
            },
        )

    def calibration_record(self) -> dict[str, Any]:
        contract = json.loads(
            (self.runtime / ATTACH.CONTRACT_FILE).read_text(encoding="utf-8")
        )
        artifacts = contract["artifacts"]
        continuous_features = list(ATTACH.CONTINUOUS_FEATURE_NAMES)
        feature_names = [
            *continuous_features,
            *(f"candidate_id::{candidate_id}" for candidate_id in self.candidate_ids),
        ]

        def point(
            *, eligible: int, accepted: int, hits: int, none: int
        ) -> dict[str, Any]:
            return {
                "enabled": True,
                "selection_score_threshold": 0.4,
                "coverage_target": 0.9,
                "coverage_floor_passed": True,
                "precision_target": 0.75,
                "precision_target_passed": True,
                "risk_lcb": 0.8,
                "cohort_count": eligible + none,
                "accepted_count": accepted,
                "eligible_count": eligible,
                "normal_sample_count": eligible,
                "normal_accepted_count": accepted,
                "none_sample_count": none,
                "none_false_accept_count": 0,
                "none_abstained_count": none,
                "hit_count": hits,
                "miss_count": accepted - hits,
                "coverage": accepted / eligible,
                "acceptable_at1": hits / accepted,
                "preferred_at1": (hits - 2) / accepted,
                "overall_decision_accuracy": (hits + none) / (eligible + none),
                "none_abstention_rate": 1.0,
            }

        operating_points = {
            "body": point(eligible=40, accepted=36, hits=32, none=2),
            "variant": point(eligible=25, accepted=23, hits=20, none=3),
            "global": point(eligible=65, accepted=59, hits=52, none=5),
        }
        fold_cs = [0.5, 1.0, 1.0, 2.0]
        return ATTACH.seal_record(
            {
                "bindings": {
                    "model_version": self.model_version,
                    "candidate_order_sha256": ATTACH._ordered_values_sha256(
                        self.candidate_ids
                    ),
                    "encoder_sha256": artifacts[ATTACH.ENCODER_FILE]["sha256"],
                    "ranker_sha256": artifacts[ATTACH.RANKER_FILE]["sha256"],
                    "prototype_features_sha256": artifacts[ATTACH.PROTOTYPE_FILE][
                        "sha256"
                    ],
                    "catalog_registry_record_sha256": ATTACH.sha256_bytes(
                        b"catalog-registry-record"
                    ),
                    "catalog_registry_sha256": self.catalog_registry_sha,
                    "frozen_split_map_sha256": ATTACH.sha256_bytes(b"frozen-split"),
                    "master_manifest_sha256": ATTACH.sha256_bytes(b"master"),
                    "master_report_sha256": ATTACH.sha256_bytes(b"master-report"),
                    "master_split_map_sha256": ATTACH.sha256_bytes(b"master-split"),
                    "finals_sha256": ATTACH.sha256_bytes(b"finals"),
                    "runtime_contract_sha256": ATTACH.sha256_file(
                        self.runtime / ATTACH.CONTRACT_FILE
                    ),
                },
                "candidate_ids": list(self.candidate_ids),
                "feature_names": feature_names,
                "feature_contract": dict(ATTACH.FEATURE_CONTRACT),
                "leakage_audit": {
                    "allowed_split": "val",
                    "allowed_work_count": 4,
                    "allowed_sample_count": 70,
                    "candidate_row_count": 140,
                    "excluded_unrenderable_candidate_rows": 2,
                    "non_val_label_rows_parsed": 0,
                    "test_rows_used_for_fit": 0,
                    "train_rows_used_for_fit": 0,
                    "pseudo_label_rows_used_for_fit": 0,
                    "gold_final_rows_used_for_fit": 70,
                    "work_group_oof": True,
                    "nested_hyperparameter_selection": True,
                    "split_component_isolation_passed": True,
                    "normalized_glyph_isolation_passed": True,
                    "source_page_isolation_passed": True,
                },
                "logistic": {
                    "c": 1.0,
                    "coef": [0.01] * len(feature_names),
                    "intercept": 0.1,
                },
                "oof_report": {
                    "candidate_log_loss": 0.42,
                    "candidate_roc_auc": 0.81,
                    "folds": [
                        {
                            "held_out_work_id_sha256": ATTACH.sha256_bytes(
                                f"work-{index}".encode("utf-8")
                            ),
                            "C": 1.0,
                            "candidate_row_count": 35,
                            "candidate_log_loss": 0.4 + (index * 0.01),
                        }
                        for index, selected_c in enumerate(fold_cs)
                    ],
                    "nested_operating_evaluation": operating_points,
                    "full_oof": operating_points,
                    "selected_C_values": fold_cs,
                    "final_C": 1.0,
                    "fit_implementation": dict(ATTACH.FIT_IMPLEMENTATION),
                },
                "operating_points": operating_points,
                "record_type": ATTACH.SELECTION_CALIBRATION_RECORD_TYPE,
                "scaler": {
                    "mean": [0.0] * len(feature_names),
                    "scale": [1.0] * len(feature_names),
                },
                "schema_version": ATTACH.SELECTION_CALIBRATION_SCHEMA_VERSION,
                "training_boundary": {
                    "split": "val",
                    "sample_count": 70,
                    "work_count": 4,
                    "work_ids_sha256": ATTACH.sha256_bytes(b"work-ids"),
                    "sample_ids_sha256": ATTACH.sha256_bytes(b"sample-ids"),
                    "candidate_rows_sha256": ATTACH.sha256_bytes(b"candidate-rows"),
                    "none_sample_count": 5,
                    "supervision": {
                        "tier": "gold_final_only",
                        "allowed_resolution_kinds": ["adjudicated", "primary"],
                        "gold_final_sample_count": 70,
                        "pseudo_label_sample_count": 0,
                        "pseudo_labels_forbidden": True,
                    },
                },
            }
        )

    def _write_calibration(self) -> None:
        write_json(self.calibration, self.calibration_record())

    def mutate_calibration(self, mutation: Callable[[dict[str, Any]], None]) -> None:
        value = json.loads(self.calibration.read_text(encoding="utf-8"))
        value.pop("record_sha256", None)
        mutation(value)
        write_json(self.calibration, ATTACH.seal_record(value))

    def attach(self, *, qa_only: bool = False) -> Mapping[str, Any]:
        return ATTACH.attach_selection_calibration(
            runtime_dir=self.runtime,
            selection_calibration=self.calibration,
            output_dir=self.output,
            qa_only_allow_failed_quality_gate=qa_only,
        )


def hybrid_routing() -> dict[str, Any]:
    return {
        "schema_version": "font-matching-hybrid-score-routing-v1",
        "candidate_scores_compatibility_alias": "body_candidate_scores",
        "body_candidate_output": "body_candidate_scores",
        "variant_candidate_output": "variant_candidate_scores",
        "body_roles": ["dialogue", "narration", "thought"],
        "variant_roles": [
            "whisper",
            "aside_balloon_edge",
            "emphasis_dialogue",
            "shout",
            "sfx_impact",
            "sfx_motion",
            "sfx_ambient",
            "sfx_emotion",
            "sfx_comic",
            "sign_ui_title",
            "other",
        ],
        "unknown_role_fallback": "variant_candidate_scores",
        "role_source": "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
        "selection_feature_source": (
            "selected_candidate_scores_with_legacy256_visual_features"
        ),
        "selection_feature_dim": 256,
        "row_specific_rules": False,
    }


class AttachSelectionCalibrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = Fixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_attaches_into_new_bundle_and_reseals_contract_and_marker(self) -> None:
        source_snapshot = {
            path.name: path.read_bytes() for path in self.fixture.runtime.iterdir()
        }
        old_contract_sha = ATTACH.sha256_file(
            self.fixture.runtime / ATTACH.CONTRACT_FILE
        )

        result = self.fixture.attach()

        self.assertEqual(result["status"], "ready")
        self.assertFalse(result["qa_only"])
        self.assertTrue(result["release_approved"])
        self.assertEqual(
            {path.name for path in self.fixture.output.iterdir()},
            set(ATTACH.ATTACHED_BUNDLE_FILES),
        )
        self.assertEqual(
            {path.name: path.read_bytes() for path in self.fixture.runtime.iterdir()},
            source_snapshot,
        )
        self.assertEqual(
            (self.fixture.output / ATTACH.SELECTION_CALIBRATION_FILE).read_bytes(),
            self.fixture.calibration.read_bytes(),
        )
        contract = json.loads(
            (self.fixture.output / ATTACH.CONTRACT_FILE).read_text(encoding="utf-8")
        )
        ATTACH.validate_record_seal(contract, location="test contract")
        self.assertNotEqual(
            ATTACH.sha256_file(self.fixture.output / ATTACH.CONTRACT_FILE),
            old_contract_sha,
        )
        self.assertEqual(set(contract["artifacts"]), set(ATTACH.ATTACHED_ASSET_FILES))
        marker = json.loads(
            (self.fixture.output / ATTACH.MARKER_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(
            set(marker["artifacts"]),
            {ATTACH.CONTRACT_FILE, *ATTACH.ATTACHED_ASSET_FILES},
        )
        self.assertEqual(set(marker), ATTACH.MARKER_KEYS)
        ATTACH.validate_attached_runtime_bundle(output_dir=self.fixture.output)

    def test_attaches_student22_calibration_with_dynamic_feature_inventory(
        self,
    ) -> None:
        fixture = Fixture(Path(self.temp.name) / "student22", candidate_count=22)

        result = fixture.attach()

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["candidate_count"], 22)
        attached = ATTACH.validate_attached_runtime_bundle(output_dir=fixture.output)
        self.assertEqual(attached["candidate_count"], 22)

    def test_attaches_active21_calibration_with_pixel_shared_route_audit(
        self,
    ) -> None:
        fixture = Fixture(Path(self.temp.name) / "active21", candidate_count=21)
        fixture.mutate_calibration(
            lambda value: value["leakage_audit"].update(
                {
                    "hybrid_score_route_source": (
                        "pixel_shared_scores_role_downstream_only"
                    )
                }
            )
        )

        result = fixture.attach()

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["candidate_count"], 21)
        attached = ATTACH.validate_attached_runtime_bundle(output_dir=fixture.output)
        self.assertEqual(attached["candidate_count"], 21)

    def test_preserves_v2_hybrid_schema_owner_and_routing(self) -> None:
        contract_path = self.fixture.runtime / ATTACH.CONTRACT_FILE
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract.pop("record_sha256")
        contract["schema_version"] = ATTACH.RUNTIME_SCHEMA_VERSION_V2
        contract["hybrid_score_routing"] = hybrid_routing()
        contract["runtime_batching"] = {
            "encoder_batch_size": 2,
            "ranker_batch_size": 16,
            "parity_qualified": True,
        }
        write_json(contract_path, ATTACH.seal_record(contract))
        self.fixture._rewrite_marker()
        marker_path = self.fixture.runtime / ATTACH.MARKER_FILE
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["owner"] = ATTACH.RUNTIME_OWNER_V2
        marker["schema_version"] = ATTACH.RUNTIME_SCHEMA_VERSION_V2
        write_json(marker_path, marker)
        self.fixture._write_calibration()

        result = self.fixture.attach()

        self.assertEqual(result["status"], "ready")
        attached_marker = json.loads(
            (self.fixture.output / ATTACH.MARKER_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(attached_marker["owner"], ATTACH.RUNTIME_OWNER_V2)
        self.assertEqual(
            attached_marker["schema_version"], ATTACH.RUNTIME_SCHEMA_VERSION_V2
        )
        attached_contract = json.loads(
            (self.fixture.output / ATTACH.CONTRACT_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(attached_contract["hybrid_score_routing"], hybrid_routing())

    def test_source_exact_inventory_and_marker_hash_are_required(self) -> None:
        (self.fixture.runtime / "unexpected.txt").write_text(
            "user file", encoding="utf-8"
        )
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError, "exact inventory"
        ):
            self.fixture.attach()
        self.assertFalse(self.fixture.output.exists())
        (self.fixture.runtime / "unexpected.txt").unlink()
        (self.fixture.runtime / ATTACH.PROTOTYPE_FILE).write_bytes(b"tampered")
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError, "artifact hash mismatch"
        ):
            self.fixture.attach()
        self.assertFalse(self.fixture.output.exists())

    def test_calibration_candidate_model_and_asset_bindings_fail_closed(self) -> None:
        mutations = {
            "candidate order": lambda value: value["candidate_ids"].reverse(),
            "model/hash binding": lambda value: value["bindings"].update(
                {"ranker_sha256": "f" * 64}
            ),
            "runtime model": lambda value: value["bindings"].update(
                {"model_version": "wrong-model"}
            ),
            "source contract": lambda value: value["bindings"].update(
                {"runtime_contract_sha256": "e" * 64}
            ),
        }
        for index, (message, mutation) in enumerate(mutations.items()):
            with self.subTest(message=message):
                fixture = Fixture(Path(self.temp.name) / f"binding-{index}")
                fixture.mutate_calibration(mutation)
                with self.assertRaisesRegex(
                    ATTACH.SelectionCalibrationAttachError,
                    "candidate order mismatch|model/hash binding mismatch",
                ):
                    fixture.attach()
                self.assertFalse(fixture.output.exists())

    def test_coverage_floor_and_global_fallback_are_sealed(self) -> None:
        def lower_global_coverage(value: dict[str, Any]) -> None:
            for points in (
                value["operating_points"],
                value["oof_report"]["full_oof"],
            ):
                point = points["global"]
                point.update(
                    {
                        "accepted_count": 58,
                        "normal_accepted_count": 58,
                        "hit_count": 50,
                        "miss_count": 8,
                        "coverage": 58 / 65,
                        "coverage_floor_passed": False,
                        "overall_decision_accuracy": 55 / 70,
                    }
                )

        cases = {
            "coverage target": lambda value: value["operating_points"]["global"].update(
                {"coverage_target": 0.89}
            ),
            "actual OOF coverage": lower_global_coverage,
            "missing global": lambda value: value["operating_points"].pop("global"),
        }
        for index, (message, mutation) in enumerate(cases.items()):
            with self.subTest(message=message):
                fixture = Fixture(Path(self.temp.name) / f"coverage-{index}")
                fixture.mutate_calibration(mutation)
                with self.assertRaises(ATTACH.SelectionCalibrationAttachError):
                    fixture.attach()
                self.assertFalse(fixture.output.exists())

    def test_precision_target_miss_is_blocked_before_attachment(self) -> None:
        def mark_precision_miss(value: dict[str, Any]) -> None:
            for points in (
                value["operating_points"],
                value["oof_report"]["full_oof"],
                value["oof_report"]["nested_operating_evaluation"],
            ):
                for point in points.values():
                    point["precision_target"] = 0.99
                    point["precision_target_passed"] = False
                    point["risk_lcb"] = 0.1

        self.fixture.mutate_calibration(mark_precision_miss)
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError,
            "deployment precision gate failed",
        ):
            self.fixture.attach()
        self.assertFalse(self.fixture.output.exists())

    def test_qa_only_attachment_bypasses_only_preferred_and_precision_gates(
        self,
    ) -> None:
        def fail_release_quality(value: dict[str, Any]) -> None:
            for points in (
                value["operating_points"],
                value["oof_report"]["full_oof"],
                value["oof_report"]["nested_operating_evaluation"],
            ):
                for point in points.values():
                    point["precision_target"] = 0.99
                    point["precision_target_passed"] = False
                    point["risk_lcb"] = 0.1
                points["global"]["preferred_at1"] = 0.44
                points["variant"]["preferred_at1"] = 0.49

        self.fixture.mutate_calibration(fail_release_quality)

        result = self.fixture.attach(qa_only=True)

        self.assertTrue(result["qa_only"])
        self.assertFalse(result["release_approved"])
        marker = json.loads(
            (self.fixture.output / ATTACH.MARKER_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(set(marker), ATTACH.QA_ONLY_MARKER_KEYS)
        self.assertIs(marker["qa_only"], True)
        self.assertIs(marker["release_approved"], False)
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError,
            "QA-only runtime requires explicit validation permission",
        ):
            ATTACH.validate_attached_runtime_bundle(output_dir=self.fixture.output)
        validated = ATTACH.validate_attached_runtime_bundle(
            output_dir=self.fixture.output, allow_qa_only=True
        )
        self.assertTrue(validated["qa_only"])
        self.assertFalse(validated["release_approved"])

    def test_qa_only_attachment_keeps_structural_binding_coverage_and_leakage_gates(
        self,
    ) -> None:
        cases = {
            "structure": lambda value: value["scaler"].update({"scale": [0.2]}),
            "binding": lambda value: value["bindings"].update(
                {"ranker_sha256": "f" * 64}
            ),
            "coverage": lambda value: value["operating_points"]["global"].update(
                {"coverage_floor_passed": False}
            ),
            "leakage": lambda value: value["leakage_audit"].update(
                {"test_rows_used_for_fit": 1}
            ),
        }
        for index, (label, mutation) in enumerate(cases.items()):
            with self.subTest(label=label):
                fixture = Fixture(Path(self.temp.name) / f"qa-guard-{index}")
                fixture.mutate_calibration(mutation)
                with self.assertRaises(ATTACH.SelectionCalibrationAttachError):
                    fixture.attach(qa_only=True)
                self.assertFalse(fixture.output.exists())

    def test_qa_only_cli_flags_are_explicit_and_command_scoped(self) -> None:
        attach_args = ATTACH.build_parser().parse_args(
            [
                "attach",
                "--runtime-dir",
                str(self.fixture.runtime),
                "--selection-calibration",
                str(self.fixture.calibration),
                "--output-dir",
                str(self.fixture.output),
                "--qa-only-allow-failed-quality-gate",
            ]
        )
        validate_args = ATTACH.build_parser().parse_args(
            [
                "validate",
                "--output-dir",
                str(self.fixture.output),
                "--allow-qa-only-runtime",
            ]
        )
        self.assertTrue(attach_args.qa_only_allow_failed_quality_gate)
        self.assertTrue(validate_args.allow_qa_only_runtime)

    def test_qa_only_attachment_accepts_an_explicitly_qa_only_source(self) -> None:
        marker_path = self.fixture.runtime / ATTACH.MARKER_FILE
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker.update({"qa_only": True, "release_approved": False})
        write_json(marker_path, marker)

        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError,
            "QA-only runtime requires explicit validation permission",
        ):
            ATTACH._validate_base_bundle(self.fixture.runtime)

        result = self.fixture.attach(qa_only=True)
        self.assertTrue(result["qa_only"])
        self.assertFalse(result["release_approved"])
        self.assertTrue(
            ATTACH._validate_base_bundle(
                self.fixture.runtime, allow_qa_only=True
            )["marker"]["qa_only"]
        )

    def test_rank_preserving_v2_round_trips_through_canonical_validator(self) -> None:
        source = json.loads(self.fixture.calibration.read_text(encoding="utf-8"))
        v2 = ATTACH.seal_record(
            {
                "bindings": source["bindings"],
                "candidate_ids": source["candidate_ids"],
                "confidence_calibration": {
                    "c": 1.0,
                    "coef": [0.1, 0.2],
                    "feature_names": ["top1_raw_score", "top1_raw_margin"],
                    "intercept": 0.0,
                    "schema_version": "font-matching-rank-preserving-confidence-v1",
                    "sigmoid": "1/(1+exp(-z))",
                },
                "leakage_audit": source["leakage_audit"],
                "oof_report": source["oof_report"],
                "operating_points": source["operating_points"],
                "ranking_policy": {
                    "candidate_reranking": False,
                    "confidence_model": "top1_score_margin_platt",
                    "mode": "preserve_runtime_candidate_order",
                },
                "record_type": ATTACH.SELECTION_CALIBRATION_RECORD_TYPE,
                "schema_version": ATTACH.SELECTION_CALIBRATION_SCHEMA_VERSION_V2,
                "training_boundary": source["training_boundary"],
            }
        )
        write_json(self.fixture.calibration, v2)
        validator = mock.Mock()
        validator.validate_calibration.side_effect = lambda value: dict(value)

        with mock.patch.object(
            ATTACH,
            "_load_rank_preserving_calibration_validator",
            return_value=validator,
        ):
            result = self.fixture.attach()
            validated = ATTACH.validate_attached_runtime_bundle(
                output_dir=self.fixture.output
            )

        self.assertFalse(result["qa_only"])
        self.assertEqual(validated["candidate_count"], 2)
        self.assertGreaterEqual(validator.validate_calibration.call_count, 4)
        self.assertGreaterEqual(validator.require_deployment_quality.call_count, 4)
        self.assertEqual(
            (self.fixture.output / ATTACH.SELECTION_CALIBRATION_FILE).read_bytes(),
            self.fixture.calibration.read_bytes(),
        )

    def test_variant_preferred_accuracy_miss_is_blocked(self) -> None:
        def lower_variant_preferred(value: dict[str, Any]) -> None:
            for points in (
                value["operating_points"],
                value["oof_report"]["full_oof"],
                value["oof_report"]["nested_operating_evaluation"],
            ):
                points["variant"]["preferred_at1"] = 0.49

        self.fixture.mutate_calibration(lower_variant_preferred)
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError, "preferred@1"
        ):
            self.fixture.attach()
        self.assertFalse(self.fixture.output.exists())

    def test_calibration_dimensions_and_test_fit_boundary_fail_closed(self) -> None:
        cases = {
            "dimensions": lambda value: value["scaler"].update({"scale": [0.2]}),
            "test leakage": lambda value: value["leakage_audit"].update(
                {"test_rows_used_for_fit": 1}
            ),
            "unknown field": lambda value: value.update({"unsealed_extension": {}}),
        }
        for index, (message, mutation) in enumerate(cases.items()):
            with self.subTest(message=message):
                fixture = Fixture(Path(self.temp.name) / f"schema-{index}")
                fixture.mutate_calibration(mutation)
                with self.assertRaises(ATTACH.SelectionCalibrationAttachError):
                    fixture.attach()
                self.assertFalse(fixture.output.exists())

    def test_existing_output_is_preserved(self) -> None:
        self.fixture.output.mkdir()
        sentinel = self.fixture.output / "user-file.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError, "already exists"
        ):
            self.fixture.attach()
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_staging_failure_does_not_publish_or_modify_source(self) -> None:
        source_snapshot = {
            path.name: path.read_bytes() for path in self.fixture.runtime.iterdir()
        }
        original = ATTACH._validate_attached_bundle

        def fail_staging(
            path: Path, *, allow_qa_only: bool = False
        ) -> Mapping[str, Any]:
            if path.name.startswith(f".{self.fixture.output.name}.staging-"):
                raise ATTACH.SelectionCalibrationAttachError("staging rejected")
            return original(path, allow_qa_only=allow_qa_only)

        with mock.patch.object(
            ATTACH, "_validate_attached_bundle", side_effect=fail_staging
        ):
            with self.assertRaisesRegex(
                ATTACH.SelectionCalibrationAttachError, "staging rejected"
            ):
                self.fixture.attach()
        self.assertFalse(self.fixture.output.exists())
        self.assertFalse(
            list(
                self.fixture.output.parent.glob(
                    f".{self.fixture.output.name}.staging-*"
                )
            )
        )
        self.assertEqual(
            {path.name: path.read_bytes() for path in self.fixture.runtime.iterdir()},
            source_snapshot,
        )

    def test_calibration_record_seal_is_required(self) -> None:
        value = json.loads(self.fixture.calibration.read_text(encoding="utf-8"))
        value["logistic"]["intercept"] = 123.0
        write_json(self.fixture.calibration, value)
        with self.assertRaisesRegex(
            ATTACH.SelectionCalibrationAttachError, "record seal mismatch"
        ):
            self.fixture.attach()


if __name__ == "__main__":
    unittest.main()
