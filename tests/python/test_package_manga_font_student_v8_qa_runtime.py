from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping
from unittest import mock

from scripts import package_manga_font_student_v8_qa_runtime as package


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(package.attach.json_bytes(value, pretty=True))


def routing() -> dict[str, Any]:
    return {
        "body_candidate_output": "body_candidate_scores",
        "body_roles": ["dialogue", "narration", "thought"],
        "candidate_scores_compatibility_alias": "body_candidate_scores",
        "role_source": "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
        "row_specific_rules": False,
        "schema_version": "font-matching-hybrid-score-routing-v1",
        "selection_feature_dim": 256,
        "selection_feature_source": (
            "selected_candidate_scores_with_legacy256_visual_features"
        ),
        "unknown_role_fallback": "variant_candidate_scores",
        "variant_candidate_output": "variant_candidate_scores",
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
    }


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.graph = root / "graph"
        self.release = root / "release"
        self.evaluation = root / "visual-holdout-evaluation.json"
        self.base = root / "v8-base"
        self.qa = root / "v8-qa"
        self.candidate_ids = tuple(
            f"font-{index:02d}" for index in range(20)
        ) + ("single-day",)
        self._write_catalogs()
        self._write_graph()
        self._write_template_contract()
        self._write_evaluation()

    def _catalog(self) -> dict[str, Any]:
        return package.attach.seal_record(
            {
                "candidate_count": len(self.candidate_ids),
                "candidate_ids": list(self.candidate_ids),
                "candidate_order_sha256": package.attach._ordered_values_sha256(  # noqa: SLF001
                    self.candidate_ids
                ),
                "catalog_version": "fixture-active21",
                "record_type": package.attach.ACTIVE_CATALOG_RECORD_TYPE,
                "schema_version": package.attach.ACTIVE_CATALOG_SCHEMA_VERSION,
            }
        )

    def _write_catalogs(self) -> None:
        catalog = self._catalog()
        write_json(self.graph / package.attach.ACTIVE_CATALOG_FILE, catalog)
        write_json(self.release / package.attach.ACTIVE_CATALOG_FILE, catalog)

    def _write_graph(self) -> None:
        (self.graph / package.attach.ENCODER_FILE).write_bytes(b"v8-encoder")
        (self.graph / package.attach.RANKER_FILE).write_bytes(b"v8-ranker")
        (self.graph / package.attach.PROTOTYPE_FILE).write_bytes(b"v8-prototypes")
        report = package.attach.seal_record(
            {
                "artifacts": {
                    name: {
                        "byte_size": (self.graph / name).stat().st_size,
                        "sha256": package.attach.sha256_file(self.graph / name),
                    }
                    for name in package.RUNTIME_ASSETS
                },
                "authority": {
                    "automatic_mutation_allowed": False,
                    "quality_gate_authority": False,
                    "state": "qa_only_unattached_graph_bundle",
                },
                "candidate_ids": list(self.candidate_ids),
                "family_score_contract": {
                    "body_and_variant_share_exact_scores": False,
                    "candidate_scores_compatibility_alias": "body_candidate_scores",
                    "role_logits": "pixel_query_role_family_adapter",
                },
                "inputs": {
                    "adapter_checkpoint_sha256": "8" * 64,
                    "adapter_manifest_sha256": "a" * 64,
                    "v7_checkpoint_sha256": "b" * 64,
                },
                "parity": {
                    "body_variant_max_abs_delta": 0.25,
                    "role_logit_max_span": 0.5,
                },
                "record_type": (
                    "manga_font_student_v8_role_family_onnx_graph_report"
                ),
                "schema_version": package.graph_export.SCHEMA_VERSION,
            }
        )
        write_json(self.graph / package.graph_export.REPORT_FILE, report)
        marker = package.attach.seal_record(
            {
                "artifacts": {
                    name: package.attach.sha256_file(self.graph / name)
                    for name in package.graph_export.OUTPUT_FILES
                    - {package.graph_export.MARKER_FILE}
                },
                "owner": package.graph_export.OWNER,
                "safe_replace": True,
                "schema_version": package.graph_export.SCHEMA_VERSION,
            }
        )
        write_json(self.graph / package.graph_export.MARKER_FILE, marker)

    def _write_template_contract(self) -> None:
        catalog = json.loads(
            (self.release / package.attach.ACTIVE_CATALOG_FILE).read_text(
                encoding="utf-8"
            )
        )
        contract = package.attach.seal_record(
            {
                "artifacts": {},
                "calibration": {
                    "calibration_split": "val",
                    "none_threshold": 0.5,
                    "temperature": 1.0,
                },
                "catalog": {
                    "active_catalog_record_sha256": catalog["record_sha256"],
                    "candidate_count": len(self.candidate_ids),
                    "candidate_ids": list(self.candidate_ids),
                    "candidate_order_sha256": (
                        package.attach._ordered_values_sha256(self.candidate_ids)  # noqa: SLF001
                    ),
                    "candidate_parameterization": (
                        "prototype-bag-only-no-id-embedding-or-bias"
                    ),
                    "catalog_registry_sha256": "c" * 64,
                    "catalog_version": "fixture-active21",
                    "font_prototypes_sha256": "d" * 64,
                    "prototype_bags": [
                        {"candidate_id": value, "count": 1, "start": index}
                        for index, value in enumerate(self.candidate_ids)
                    ],
                    "prototype_count": len(self.candidate_ids),
                },
                "deployment": {
                    "automatic_mutation_allowed": True,
                    "fail_closed": True,
                    "fallback_policy": {
                        "automatic_profile_without_pixel_model": "forbidden",
                        "invalid_artifact": "explicit_disabled",
                        "manual_user_lock": "allowed",
                        "missing_artifact": "explicit_disabled",
                        "semantic_bootstrap": "forbidden",
                    },
                    "state": "ready",
                },
                "encoder": {"onnx_sha256": "e" * 64},
                "head": {
                    "architecture": {
                        "candidate_count": len(self.candidate_ids),
                        "feature_dim": 1280,
                        "legacy_feature_dim": 256,
                        "variant_feature_dim": 1024,
                    },
                    "body_checkpoint_sha256": "f" * 64,
                    "onnx_sha256": "1" * 64,
                    "variant_checkpoint_sha256": "f" * 64,
                },
                "hybrid_score_routing": routing(),
                "model_version": "manga-font-v7-fixture",
                "onnx_io_contract": {},
                "policy": {},
                "preprocessing": {},
                "provenance": {},
                "record_type": package.attach.RUNTIME_RECORD_TYPE,
                "release_acceptance": package.attach.seal_record(
                    {
                        "record_type": package.attach.RELEASE_ACCEPTANCE_RECORD_TYPE,
                        "schema_version": package.attach.RELEASE_ACCEPTANCE_SCHEMA_VERSION,
                        "status": "accepted",
                    }
                ),
                "release_evaluation": {},
                "runtime": {
                    "execution_provider": "wasm",
                    "package": "onnxruntime-web",
                    "version": "1.27.0",
                },
                "runtime_batching": {
                    "encoder_batch_size": 2,
                    "parity_qualified": True,
                    "ranker_batch_size": 16,
                },
                "schema_version": package.attach.RUNTIME_SCHEMA_VERSION_V2,
                "test_data_boundary": {
                    "aggregate_metrics_only": True,
                    "frozen_test_pixels_opened_by_exporter": 0,
                    "row_level_predictions_packaged": False,
                    "sample_identifiers_packaged": False,
                    "training_or_validation_pixels_packaged": False,
                },
            }
        )
        write_json(self.release / package.attach.CONTRACT_FILE, contract)
        write_json(
            self.release / package.attach.MARKER_FILE,
            {
                "artifacts": {},
                "owner": package.attach.RUNTIME_OWNER_V2,
                "safe_replace": True,
                "schema_version": package.attach.RUNTIME_SCHEMA_VERSION_V2,
            },
        )

    def evaluation_record(
        self, *, single_day_body_false_top1_rate: float = 0.0
    ) -> dict[str, Any]:
        bindings = {
            "adapter_checkpoint_sha256": "8" * 64,
            "adapter_manifest_sha256": "a" * 64,
            "candidate_order_sha256": (
                package.attach._ordered_values_sha256(self.candidate_ids)  # noqa: SLF001
            ),
            "dataset_manifest_sha256": "7" * 64,
            "dataset_npz_sha256": "6" * 64,
        }
        metrics = {
            "acceptable_at1": 0.80,
            "family_accuracy": 0.85,
            "preferred_at1": 0.60,
            "single_day_body_false_top1_rate": single_day_body_false_top1_rate,
            "single_day_all_top1_rate": 0.0,
            "single_day_positive_precision": 0.0,
            "single_day_predicted_count": 0,
            "top1_max_candidate_share": 0.50,
        }
        checks = package._evaluation_checks(metrics, 474)  # noqa: SLF001
        return package.attach.seal_record(
            {
                "authority": package._evaluation_authority_record(  # noqa: SLF001
                    package.VISUAL_HOLDOUT_AUTHORITY
                ),
                "bindings": bindings,
                "boundary": package._evaluation_boundary_record(  # noqa: SLF001
                    row_count=474, routing_row_count=546, work_count=4
                ),
                "candidate_ids": list(self.candidate_ids),
                "evaluated_positive_rows": 474,
                "metrics": metrics,
                "quality_gate": {
                    "authority": "qa_packaging_only_not_release",
                    "checks": checks,
                    "passed": all(checks.values()),
                    "release_quality_gate_authority": False,
                },
                "record_type": package.VISUAL_HOLDOUT_EVALUATION_RECORD,
                "sample_work_order_sha256": "9" * 64,
                "schema_version": package.VISUAL_HOLDOUT_EVALUATION_SCHEMA,
            }
        )

    def _write_evaluation(self) -> None:
        write_json(self.evaluation, self.evaluation_record())

    def source_args(self) -> dict[str, Path]:
        return {
            "graph_bundle": self.graph,
            "v7_release": self.release,
            "visual_holdout_evaluation": self.evaluation,
        }


class MangaFontV8QaRuntimePackagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = Fixture(Path(self.temp.name))
        self.release_patch = mock.patch.object(
            package.promote,
            "validate_release_bundle",
            return_value={"status": "ready", "release_approved": True},
        )
        self.release_patch.start()

    def tearDown(self) -> None:
        self.release_patch.stop()
        self.temp.cleanup()

    def test_builds_six_file_calibration_gated_base(self) -> None:
        result = package.build_base(
            **self.fixture.source_args(), output_dir=self.fixture.base
        )

        self.assertEqual(set(path.name for path in self.fixture.base.iterdir()), set(package.BASE_FILES))
        self.assertFalse(result["automatic_mutation_allowed_before_calibration"])
        self.assertFalse(result["quality_gate_bypassed"])
        contract = json.loads(
            (self.fixture.base / package.attach.CONTRACT_FILE).read_text(
                encoding="utf-8"
            )
        )
        self.assertNotIn("release_acceptance", contract)
        self.assertNotIn("font_family_evidence", contract)
        self.assertFalse(
            contract["v8_font_family_evidence"][
                "body_and_variant_share_exact_scores"
            ]
        )
        self.assertEqual(
            "8" * 64,
            contract["head"]["body_checkpoint_sha256"],
        )
        self.assertEqual(
            "8" * 64,
            contract["head"]["variant_checkpoint_sha256"],
        )
        self.assertFalse(
            contract["v8_runtime_packaging"][
                "automatic_mutation_before_selection_calibration"
            ]
        )

    def test_visual_holdout_gate_is_recomputed_fail_closed(self) -> None:
        failed = self.fixture.evaluation_record(
            single_day_body_false_top1_rate=0.20
        )
        failed["quality_gate"] = {
            "checks": {key: True for key in failed["quality_gate"]["checks"]},
            "passed": True,
        }
        failed.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(failed))

        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError,
            "visual holdout evaluation quality gate failed",
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )
        self.assertFalse(self.fixture.base.exists())

    def test_visual_holdout_cannot_be_upgraded_to_human_gold(self) -> None:
        upgraded = self.fixture.evaluation_record()
        upgraded["authority"] = {
            **upgraded["authority"],
            "human_gold": True,
        }
        upgraded.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(upgraded))

        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError,
            "authority was upgraded",
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )
        self.assertFalse(self.fixture.base.exists())

    def test_distribution_gate_rejects_collapsed_top1(self) -> None:
        collapsed = self.fixture.evaluation_record()
        collapsed["metrics"]["top1_max_candidate_share"] = 0.715
        collapsed["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            collapsed["metrics"], collapsed["evaluated_positive_rows"]
        )
        collapsed["quality_gate"]["passed"] = False
        collapsed.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(collapsed))

        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError,
            "quality gate failed",
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )

    def test_single_day_precision_gate_rejects_low_precision(self) -> None:
        noisy = self.fixture.evaluation_record()
        noisy["metrics"].update(
            {
                "single_day_positive_precision": 0.125,
                "single_day_predicted_count": 8,
            }
        )
        noisy["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            noisy["metrics"], noisy["evaluated_positive_rows"]
        )
        noisy["quality_gate"]["passed"] = False
        noisy.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(noisy))

        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError,
            "quality gate failed",
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )

    def test_single_day_all_row_rate_gate_rejects_drift(self) -> None:
        noisy = self.fixture.evaluation_record()
        noisy["metrics"]["single_day_all_top1_rate"] = 0.011
        noisy["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            noisy["metrics"], noisy["evaluated_positive_rows"]
        )
        noisy["quality_gate"]["passed"] = False
        noisy.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(noisy))

        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError,
            "quality gate failed",
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )

    def test_r3_checkpoint_selection_authority_stays_non_independent(self) -> None:
        record = self.fixture.evaluation_record()
        record["authority"] = package._evaluation_authority_record(  # noqa: SLF001
            package.ADAPTER_SELECTION_AUTHORITY
        )
        record["bindings"]["dataset_npz_sha256"] = package.R3_DATASET_SHA256
        record["boundary"] = package._evaluation_boundary_record(  # noqa: SLF001
            row_count=1047, routing_row_count=9033, work_count=5
        )
        record["evaluated_positive_rows"] = 1047
        record["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            record["metrics"], 1047
        )
        record["quality_gate"]["passed"] = True
        record.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(record))

        package.build_base(
            **self.fixture.source_args(), output_dir=self.fixture.base
        )
        contract = json.loads(
            (self.fixture.base / package.attach.CONTRACT_FILE).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            package.ADAPTER_SELECTION_AUTHORITY,
            contract["release_evaluation"]["authority"],
        )
        self.assertFalse(
            contract["release_evaluation"]["base_independent_evaluation"]
        )

    def test_r3_training_overlay_requires_and_packages_two_sha_lineage(self) -> None:
        record = self.fixture.evaluation_record()
        record["authority"] = package._evaluation_authority_record(  # noqa: SLF001
            package.ADAPTER_SELECTION_AUTHORITY
        )
        overlay_sha256 = "e" * 64
        record["bindings"]["dataset_npz_sha256"] = overlay_sha256
        record["boundary"] = package._evaluation_boundary_record(  # noqa: SLF001
            row_count=1047, routing_row_count=9033, work_count=5
        )
        record["evaluated_positive_rows"] = 1047
        record["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            record["metrics"], 1047
        )
        record["quality_gate"]["passed"] = True
        record["dataset_lineage"] = {
            "adapter_manifest_sha256": record["bindings"][
                "adapter_manifest_sha256"
            ],
            "base_dataset_npz_sha256": package.R3_DATASET_SHA256,
            "dataset_manifest_sha256": record["bindings"][
                "dataset_manifest_sha256"
            ],
            "evaluated_dataset_npz_sha256": overlay_sha256,
            "profile": "r3_body_holdout_checkpoint_selection",
            "training_overlay": True,
            "validation_arrays_byte_identical_to_base": True,
        }
        record.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(record))

        package.build_base(
            **self.fixture.source_args(), output_dir=self.fixture.base
        )
        contract = json.loads(
            (self.fixture.base / package.attach.CONTRACT_FILE).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            record["dataset_lineage"],
            contract["v8_runtime_packaging"]["visual_holdout_dataset_lineage"],
        )
        self.assertEqual(
            record["dataset_lineage"],
            contract["release_evaluation"]["dataset_lineage"],
        )

    def test_r3_training_overlay_lineage_tampering_is_fail_closed(self) -> None:
        graph = package._validate_graph_bundle(self.fixture.graph)  # noqa: SLF001
        record = self.fixture.evaluation_record()
        record["authority"] = package._evaluation_authority_record(  # noqa: SLF001
            package.ADAPTER_SELECTION_AUTHORITY
        )
        record["bindings"]["dataset_npz_sha256"] = "e" * 64
        record["boundary"] = package._evaluation_boundary_record(  # noqa: SLF001
            row_count=1047, routing_row_count=9033, work_count=5
        )
        record["evaluated_positive_rows"] = 1047
        record["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            record["metrics"], 1047
        )
        record["quality_gate"]["passed"] = True
        record["dataset_lineage"] = {
            "adapter_manifest_sha256": record["bindings"][
                "adapter_manifest_sha256"
            ],
            "base_dataset_npz_sha256": package.R3_DATASET_SHA256,
            "dataset_manifest_sha256": record["bindings"][
                "dataset_manifest_sha256"
            ],
            "evaluated_dataset_npz_sha256": record["bindings"][
                "dataset_npz_sha256"
            ],
            "profile": "r3_body_holdout_checkpoint_selection",
            "training_overlay": True,
            "validation_arrays_byte_identical_to_base": True,
        }
        for key, value in (
            ("base_dataset_npz_sha256", "f" * 64),
            ("evaluated_dataset_npz_sha256", "f" * 64),
            ("validation_arrays_byte_identical_to_base", False),
            ("training_overlay", False),
        ):
            with self.subTest(key=key):
                tampered = copy.deepcopy(record)
                tampered["dataset_lineage"][key] = value
                tampered.pop("record_sha256")
                write_json(
                    self.fixture.evaluation, package.attach.seal_record(tampered)
                )
                with self.assertRaisesRegex(
                    package.MangaFontV8QaRuntimeError, "dataset lineage"
                ):
                    package._validate_visual_holdout_evaluation(  # noqa: SLF001
                        self.fixture.evaluation, graph=graph
                    )

    def test_visual_holdout_requires_at_least_400_rows(self) -> None:
        undersized = self.fixture.evaluation_record()
        undersized["evaluated_positive_rows"] = 399
        undersized["boundary"]["checkpoint_selection_rows"] = 399
        undersized["quality_gate"]["checks"] = package._evaluation_checks(  # noqa: SLF001
            undersized["metrics"], 399
        )
        undersized["quality_gate"]["passed"] = False
        undersized.pop("record_sha256")
        write_json(self.fixture.evaluation, package.attach.seal_record(undersized))

        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError,
            "boundary failed",
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )

    def test_graph_hash_tamper_is_rejected(self) -> None:
        (self.fixture.graph / package.attach.RANKER_FILE).write_bytes(b"tampered")
        with self.assertRaisesRegex(
            package.MangaFontV8QaRuntimeError, "graph artifact hash drifted"
        ):
            package.build_base(
                **self.fixture.source_args(), output_dir=self.fixture.base
            )

    def test_attach_qa_never_forwards_quality_bypass(self) -> None:
        package.build_base(**self.fixture.source_args(), output_dir=self.fixture.base)
        calibration = Path(self.temp.name) / "calibration.json"
        calibration.write_text("{}\n", encoding="utf-8")

        def fake_attach(**kwargs: Any) -> None:
            self.assertFalse(kwargs["qa_only_allow_failed_quality_gate"])
            destination = Path(kwargs["output_dir"])
            destination.mkdir()
            for name in package.BASE_FILES:
                source = self.fixture.base / name
                if name != package.attach.MARKER_FILE:
                    shutil.copyfile(source, destination / name)
            shutil.copyfile(calibration, destination / package.attach.SELECTION_CALIBRATION_FILE)
            marker = json.loads(
                (self.fixture.base / package.attach.MARKER_FILE).read_text(
                    encoding="utf-8"
                )
            )
            write_json(destination / package.attach.MARKER_FILE, marker)

        import shutil

        strict_result = {
            "identity": {
                "candidate_ids": list(self.fixture.candidate_ids),
                "model_version": "manga-font-v8-fixture",
            }
        }
        with (
            mock.patch.object(
                package.attach,
                "attach_selection_calibration",
                side_effect=fake_attach,
            ) as attach_mock,
            mock.patch.object(
                package, "_strict_validate_qa", return_value=strict_result
            ),
        ):
            result = package.attach_qa(
                **self.fixture.source_args(),
                runtime_dir=self.fixture.base,
                selection_calibration=calibration,
                output_dir=self.fixture.qa,
            )

        self.assertEqual(attach_mock.call_count, 1)
        self.assertFalse(result["calibration_quality_gate_bypassed"])
        marker = json.loads(
            (self.fixture.qa / package.attach.MARKER_FILE).read_text(encoding="utf-8")
        )
        self.assertIs(marker["qa_only"], True)
        self.assertIs(marker["release_approved"], False)

    def test_attach_evaluation_only_is_explicit_and_non_promotable(self) -> None:
        package.build_base(**self.fixture.source_args(), output_dir=self.fixture.base)
        calibration = Path(self.temp.name) / "failed-calibration.json"
        calibration.write_text("{}\n", encoding="utf-8")

        def fake_attach(**kwargs: Any) -> None:
            self.assertTrue(kwargs["qa_only_allow_failed_quality_gate"])
            destination = Path(kwargs["output_dir"])
            destination.mkdir()
            for name in package.BASE_FILES:
                if name != package.attach.MARKER_FILE:
                    shutil.copyfile(self.fixture.base / name, destination / name)
            shutil.copyfile(
                calibration,
                destination / package.attach.SELECTION_CALIBRATION_FILE,
            )
            marker = json.loads(
                (self.fixture.base / package.attach.MARKER_FILE).read_text(
                    encoding="utf-8"
                )
            )
            marker.update({"qa_only": True, "release_approved": False})
            write_json(destination / package.attach.MARKER_FILE, marker)

        def fake_validate(root: Path) -> Mapping[str, Any]:
            contract = json.loads(
                (root / package.attach.CONTRACT_FILE).read_text(encoding="utf-8")
            )
            return {
                "candidate_ids": list(self.fixture.candidate_ids),
                "contract": contract,
            }

        import shutil

        with (
            mock.patch.object(
                package.attach,
                "attach_selection_calibration",
                side_effect=fake_attach,
            ) as attach_mock,
            mock.patch.object(
                package,
                "_evaluation_only_validate_qa",
                side_effect=fake_validate,
            ),
        ):
            result = package.attach_evaluation_only(
                **self.fixture.source_args(),
                runtime_dir=self.fixture.base,
                selection_calibration=calibration,
                output_dir=self.fixture.qa,
            )

        self.assertEqual(attach_mock.call_count, 1)
        self.assertTrue(result["calibration_quality_gate_bypassed"])
        self.assertTrue(result["evaluation_only"])
        self.assertTrue(result["non_promotable"])
        self.assertFalse(result["release_approved"])
        contract = json.loads(
            (self.fixture.qa / package.attach.CONTRACT_FILE).read_text(
                encoding="utf-8"
            )
        )
        self.assertTrue(contract["evaluation_only_runtime"]["non_promotable"])
        self.assertTrue(
            contract["v8_runtime_packaging"]["quality_gate_bypassed"]
        )
        self.assertEqual(
            contract["v8_runtime_packaging"]["loader_opt_in_required"],
            "allowQaOnlyRuntime",
        )

    def test_cli_has_no_quality_bypass_switch(self) -> None:
        help_text = package.build_parser().format_help()
        self.assertNotIn("allow-failed", help_text)
        self.assertNotIn("--independent-evaluation", help_text)
        args = package.build_parser().parse_args(
            [
                "attach-qa",
                "--graph-bundle",
                str(self.fixture.graph),
                "--v7-release",
                str(self.fixture.release),
                "--visual-holdout-evaluation",
                str(self.fixture.evaluation),
                "--runtime-dir",
                str(self.fixture.base),
                "--selection-calibration",
                str(self.fixture.evaluation),
                "--output-dir",
                str(self.fixture.qa),
            ]
        )
        self.assertEqual(args.command, "attach-qa")
        evaluation_args = package.build_parser().parse_args(
            [
                "attach-evaluation-only",
                "--graph-bundle",
                str(self.fixture.graph),
                "--v7-release",
                str(self.fixture.release),
                "--visual-holdout-evaluation",
                str(self.fixture.evaluation),
                "--runtime-dir",
                str(self.fixture.base),
                "--selection-calibration",
                str(self.fixture.evaluation),
                "--output-dir",
                str(self.fixture.qa),
            ]
        )
        self.assertEqual(evaluation_args.command, "attach-evaluation-only")


if __name__ == "__main__":
    unittest.main()
