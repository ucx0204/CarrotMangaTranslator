from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import torch

from scripts import train_manga_font_v3_family_residual_r21_logo as r21
from scripts import train_manga_font_v3_family_residual_r22_concat_logo as trainer
from tests.python import test_train_manga_font_v3_family_residual_r21_logo as r21_test


class MangaFontV3FamilyResidualR22ConcatLogoTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = r21_test.MangaFontV3FamilyResidualR21LogoTests()

    @staticmethod
    def args(**overrides: object):
        values: dict[str, object] = {
            **trainer.PRECOMMITTED_CONFIGURATION,
            "anchor_kl_scope": "base_only",
            "base_supervision_mode": "non_direct_preservation",
            "device": "cpu",
            "direct_balance_mode": "work_family",
            "direct_objective": trainer.DIRECT_OBJECTIVE,
            "experiment_cell_id": (
                f"r22-{trainer.FEATURE_SOURCE}-{trainer.DIRECT_OBJECTIVE}-"
                f"seed{trainer.SEED}"
            ),
            "feature_source": trainer.FEATURE_SOURCE,
            "seed": trainer.SEED,
        }
        values.update(overrides)
        return __import__("argparse").Namespace(**values)

    @staticmethod
    def control() -> dict[str, object]:
        return dict(trainer._control_artifact_contract())

    @staticmethod
    def heldout_reports(
        *, balanced: float, body: float, variant: float = 0.0, safety: bool = True
    ) -> list[dict[str, object]]:
        return [
            {
                "checks": {"synthetic_safety": safety},
                "deltas": {
                    "balanced_accuracy": balanced,
                    "body_accuracy": body,
                    "variant_accuracy": variant,
                },
                "fold_index": fold_index,
            }
            for fold_index in range(10)
        ]

    def test_frozen_engine_and_exact_control_artifact_are_strictly_bound(self) -> None:
        self.assertEqual(trainer.CONTROL_PRODUCER, trainer._assert_frozen_engine())
        control = trainer._load_control_contract()
        self.assertEqual(trainer.CONTROL_MANIFEST_SHA256, control["manifest_sha256"])
        self.assertEqual(
            trainer.CONTROL_RECORD_SHA256, control["manifest_record_sha256"]
        )
        self.assertEqual(trainer.CONTROL_PRODUCER, control["producer"])
        self.assertEqual(
            trainer.CONTROL_OOF_DELTA, control["oof_heldout_work_macro_delta"]
        )
        with (
            mock.patch.object(
                trainer,
                "CONTROL_PRODUCER",
                {**trainer.CONTROL_PRODUCER, "sha256": "0" * 64},
            ),
            self.assertRaisesRegex(trainer.R22TrainingError, "engine bytes drifted"),
        ):
            trainer._load_control_contract()
        with (
            mock.patch.object(trainer, "CONTROL_MANIFEST_SHA256", "f" * 64),
            self.assertRaisesRegex(
                trainer.R22TrainingError, "control physical file drifted"
            ),
        ):
            trainer._load_control_contract()

    def test_concat_feature_order_zero_head_bound_and_candidate_invariance(
        self,
    ) -> None:
        anchor = self.fixture.anchor()
        generator = torch.Generator().manual_seed(220)
        query_views = torch.randn(7, 3, 4, 256, generator=generator)
        prototypes = torch.randn(3, 4, 256, generator=generator)
        control = self.control()
        native_feature_dimension = r21._feature_dimension
        with trainer._r22_engine_context(control):
            shared = trainer.r0.frozen_shared_hidden(torch, anchor, query_views)
            family = r21.frozen_family_norm(torch, anchor, query_views)
            concat = r21._feature_from_queries(
                torch, anchor, query_views, trainer.FEATURE_SOURCE
            )
            self.assertTrue(torch.equal(shared, concat[:, :64]))
            self.assertTrue(torch.equal(family, concat[:, 64:]))
            self.assertEqual((7, 1088), tuple(concat.shape))

            model = r21._build_r21_model(
                torch,
                anchor_model=anchor,
                maximum_margin=1.0,
                feature_source=trainer.FEATURE_SOURCE,
            )
            with torch.inference_mode():
                anchor_output = anchor(query_views, prototypes)
                zero_output = model(query_views, prototypes)
            self.assertTrue(
                torch.equal(
                    anchor_output["family_logits"], zero_output["family_logits"]
                )
            )
            for name in (
                "body_candidate_scores",
                "candidate_scores",
                "variant_candidate_scores",
            ):
                self.assertTrue(torch.equal(anchor_output[name], zero_output[name]))

            with torch.no_grad():
                model.family_margin_head.weight.fill_(100.0)
                model.family_margin_head.bias.fill_(100.0)
                changed = model(query_views, prototypes)
            self.assertLessEqual(
                float(changed["family_margin_delta"].abs().max().item()), 1.0
            )
            for name in (
                "body_candidate_scores",
                "candidate_scores",
                "variant_candidate_scores",
            ):
                self.assertTrue(torch.equal(anchor_output[name], changed[name]))

            spec = r21._sidecar_spec(trainer.FEATURE_SOURCE)
            self.assertEqual((1, 1088), spec["family_margin_head.weight"][0])
            self.assertEqual(
                1089,
                r21._trainable_contract(model, trainer.FEATURE_SOURCE)[
                    "sidecar_parameter_count"
                ],
            )
        self.assertIs(native_feature_dimension, r21._feature_dimension)

    def test_architecture_contract_binds_static_ratios_and_pending_full_benchmark(
        self,
    ) -> None:
        control = self.control()
        with trainer._r22_engine_context(control):
            model = r21._build_r21_model(
                torch,
                anchor_model=self.fixture.anchor(),
                maximum_margin=1.0,
                feature_source=trainer.FEATURE_SOURCE,
            )
            contract = r21._architecture_contract(
                model, feature_source=trainer.FEATURE_SOURCE, maximum_margin=1.0
            )
        estimate = contract["static_reuse_estimate_not_runtime_benchmark"]
        self.assertEqual(1089, contract["sidecar_parameter_count"])
        self.assertEqual((74528 + 1089) / 74528, estimate["estimated_parameter_ratio"])
        self.assertEqual(
            (91776 + 1088) / 91776, estimate["estimated_multiply_accumulate_ratio"]
        )
        self.assertTrue(estimate["within_static_1_5x_parameter_and_mac_budget"])
        self.assertFalse(contract["cpu_benchmark_completed"])
        self.assertTrue(
            contract[
                "cpu_single_thread_full_runtime_benchmark_required_before_promotion"
            ]
        )
        self.assertTrue(
            contract["fused_feature_reuse_required_for_any_runtime_candidate"]
        )

    def test_options_are_one_cell_one_seed_plain_ce_only(self) -> None:
        trainer._validate_options(self.args())
        invalid = (
            {"feature_source": "shared_hidden64"},
            {"direct_objective": "work_family_hard_ce_gamma1"},
            {"seed": 20260821},
            {"seed": 20260820.0},
            {"page_body_ce_weight": 0.1},
            {"epochs": 8.5},
        )
        for changes in invalid:
            with (
                self.subTest(changes=changes),
                self.assertRaises(trainer.R22TrainingError),
            ):
                trainer._validate_options(self.args(**changes))

    def test_continuation_gate_is_control_relative_and_does_not_relax_plus_0_02(
        self,
    ) -> None:
        control = self.control()
        boundary = trainer._aggregate_logo_metrics(
            self.heldout_reports(balanced=0.005, body=0.005),
            control_contract=control,
        )
        self.assertFalse(boundary["passed"])
        self.assertTrue(boundary["pilot_continuation"]["passed"])
        self.assertTrue(
            boundary["pilot_continuation"][
                "absolute_plus_0_02_diagnostic_worth_gate_remains_authoritative"
            ]
        )
        below = trainer._aggregate_logo_metrics(
            self.heldout_reports(balanced=0.0049, body=0.006),
            control_contract=control,
        )
        self.assertFalse(below["pilot_continuation"]["passed"])
        unsafe = trainer._aggregate_logo_metrics(
            self.heldout_reports(balanced=0.03, body=0.03, variant=-0.006, safety=True),
            control_contract=control,
        )
        self.assertFalse(unsafe["pilot_continuation"]["passed"])
        worthy = trainer._aggregate_logo_metrics(
            self.heldout_reports(balanced=0.02, body=0.02, variant=0.0),
            control_contract=control,
        )
        self.assertTrue(worthy["passed"])
        self.assertTrue(worthy["pilot_continuation"]["passed"])

    def test_engine_context_is_nonreentrant_and_restores_every_native_global(
        self,
    ) -> None:
        before = {name: getattr(r21, name) for name in trainer._NATIVE_GLOBALS}
        control = self.control()
        with trainer._r22_engine_context(control):
            self.assertEqual(trainer.SCHEMA_VERSION, r21.SCHEMA_VERSION)
            self.assertEqual((trainer.FEATURE_SOURCE,), r21.FEATURE_SOURCES)
            with self.assertRaisesRegex(trainer.R22TrainingError, "not reentrant"):
                with trainer._r22_engine_context(control):
                    pass
        after = {name: getattr(r21, name) for name in trainer._NATIVE_GLOBALS}
        for name in before:
            self.assertIs(before[name], after[name]) if callable(
                before[name]
            ) else self.assertEqual(before[name], after[name])

    def test_real_preflight_contract_has_ten_folds_and_exact_control(self) -> None:
        args = trainer.build_parser().parse_args(["preflight"])
        result = trainer.preflight(args)
        self.assertEqual(trainer.SCHEMA_VERSION, result["schema_version"])
        self.assertEqual(10, len(result["fold_partitions"]))
        self.assertTrue(
            all(
                fold["active_work_family_strata_count"] == 18
                for fold in result["fold_partitions"]
            )
        )
        self.assertEqual(
            trainer.CONTROL_MANIFEST_SHA256,
            result["comparison_control"]["manifest_sha256"],
        )
        self.assertEqual(
            1089, result["trainable_parameters"]["sidecar_parameter_count"]
        )

    def test_synthetic_train_strict_validate_mutual_schema_and_coherent_tampers(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base_path = root / "base.npz"
            source_path = root / "head.safetensors"
            anchor_dir = root / "anchor"
            overlay_dir = root / "overlay"
            output = root / "output"
            base_path.write_bytes(b"synthetic-r22-base")
            source_path.write_bytes(b"synthetic-r22-head")
            anchor_dir.mkdir()
            overlay_dir.mkdir()

            context, global_partition = self.fixture.synthetic_logo_inputs()
            context.update(
                {
                    "candidate_ids": ("a", "b", "single-day"),
                    "dataset_path": base_path.resolve(),
                    "initialization": {"synthetic": True},
                    "inventory": {"row_count": 40, "synthetic": True},
                    "model": self.fixture.anchor(),
                    "overlay_binding": {
                        "development_eval_work_ids": ["dev-a", "dev-b", "dev-c"],
                        "synthetic": True,
                    },
                    "source_head": source_path.resolve(),
                }
            )
            cache = {
                "body_candidate_scores": torch.zeros(40, 3),
                "candidate_scores": torch.zeros(40, 3),
                "family_logits": torch.stack(
                    (torch.linspace(-0.2, 0.2, 40), torch.linspace(0.2, -0.2, 40)),
                    dim=1,
                ),
                "hidden": torch.arange(40 * 1088, dtype=torch.float32).reshape(40, 1088)
                / 1000.0,
                "variant_candidate_scores": torch.zeros(40, 3),
            }
            base_metrics = self.fixture.base_metrics()
            training_metrics = self.fixture.training_metrics()
            heldout_metrics = {
                "direct_family": {
                    "work_macro": {
                        "balanced_accuracy": 0.5,
                        "body_accuracy": 0.5,
                        "variant_accuracy": 0.5,
                    }
                },
                "page_consistency": {
                    "all_rows_top1_in_common_positive_rate": 0.5,
                    "top1_all_agree_rate": 0.5,
                },
            }
            diagnostic_checks = {
                "page_common_positive_top1_nonregression": True,
                "page_top1_all_agree_nonregression": True,
                "synthetic_target_gate": False,
            }
            subgroup = {"synthetic": {"row_count": 1}}
            args = trainer.build_parser().parse_args(
                [
                    "train",
                    "--base-npz",
                    str(base_path),
                    "--source-query-head",
                    str(source_path),
                    "--anchor-adapter-dir",
                    str(anchor_dir),
                    "--overlay-dir",
                    str(overlay_dir),
                    "--output-dir",
                    str(output),
                ]
            )
            control = self.control()
            events: list[str] = []
            original_selection_key = r21._fold_selection_key

            def observed_selection_key(*call_args: object, **call_kwargs: object):
                events.append("selection")
                return original_selection_key(*call_args, **call_kwargs)

            def observed_heldout(*_call_args: object, **_call_kwargs: object):
                events.append("heldout")
                return json.loads(json.dumps(heldout_metrics))

            with (
                mock.patch.object(
                    trainer, "_load_control_contract", return_value=control
                ),
                mock.patch.object(r21, "_load_context", return_value=context),
                mock.patch.object(
                    r21, "_global_partition", return_value=global_partition
                ),
                mock.patch.object(trainer, "_build_feature_cache", return_value=cache),
                mock.patch.object(
                    trainer.r0,
                    "_evaluate_base_from_cache",
                    return_value=base_metrics,
                ),
                mock.patch.object(
                    trainer.r0.page_v3,
                    "base_regression_checks",
                    return_value={"synthetic": True},
                ),
                mock.patch.object(
                    r21, "_fold_training_metrics", return_value=training_metrics
                ),
                mock.patch.object(
                    r21, "_fold_diagnostic_checks", return_value=diagnostic_checks
                ),
                mock.patch.object(
                    trainer.r1,
                    "_subgroup_margin_flip_diagnostics",
                    return_value=subgroup,
                ),
                mock.patch.object(
                    r21, "_postselection_heldout_metrics", side_effect=observed_heldout
                ),
                mock.patch.object(
                    r21, "_fold_selection_key", side_effect=observed_selection_key
                ),
            ):
                result = trainer.train(args)
                self.assertFalse(result["logo_diagnostic_worth"])
                self.assertFalse(result["pilot_continuation_worth"])
                self.assertEqual(trainer.SCHEMA_VERSION, result["schema_version"])
                for fold_index in range(10):
                    start = fold_index * 11
                    self.assertEqual(
                        ["selection"] * 9 + ["heldout"] * 2,
                        events[start : start + 11],
                    )
                validated = trainer.validate_output(output)
                self.assertTrue(validated["read_only_recomputation"])

                manifest_path = output / trainer.MANIFEST_FILE
                marker_path = output / trainer.MARKER_FILE
                original_manifest = manifest_path.read_bytes()
                original_marker = marker_path.read_bytes()
                manifest = json.loads(original_manifest.decode("utf-8"))
                self.assertEqual(trainer.SCHEMA_VERSION, manifest["schema_version"])
                self.assertEqual(trainer._producer_binding(), manifest["producer"])
                self.assertEqual(
                    trainer.CONTROL_MANIFEST_SHA256,
                    manifest["experiment_contract"]["comparison_control"][
                        "manifest_sha256"
                    ],
                )
                self.assertFalse(manifest["logo_aggregate"]["passed"])
                self.assertFalse(
                    manifest["logo_aggregate"]["pilot_continuation"]["passed"]
                )

                with self.assertRaises(r21.R21TrainingError):
                    r21.validate_output(output)
                with self.assertRaises(trainer.R22TrainingError):
                    trainer.validate_output(Path(trainer._CONTROL_DIR))

                def write_resealed(mutator: object) -> None:
                    record = json.loads(original_manifest.decode("utf-8"))
                    mutator(record)  # type: ignore[operator]
                    manifest_path.write_bytes(
                        trainer.r21.json_bytes(
                            trainer.r21.seal_record(record), pretty=True
                        )
                    )
                    changed_marker = json.loads(original_marker.decode("utf-8"))
                    changed_marker["artifacts"][trainer.MANIFEST_FILE] = (
                        trainer.sha256_file(manifest_path)
                    )
                    marker_path.write_bytes(
                        trainer.r21.json_bytes(
                            trainer.r21.seal_record(changed_marker), pretty=True
                        )
                    )

                tampers = (
                    lambda record: record["producer"]["r22_producer"].__setitem__(
                        "sha256", "0" * 64
                    ),
                    lambda record: record["experiment_contract"][
                        "comparison_control"
                    ].__setitem__("manifest_sha256", "1" * 64),
                    lambda record: record["logo_aggregate"][
                        "pilot_continuation"
                    ].__setitem__("passed", True),
                    lambda record: record["configuration"].__setitem__(
                        "feature_source", "family_norm1024"
                    ),
                    lambda record: record["development_boundary"].__setitem__(
                        "consulted", True
                    ),
                )
                for mutator in tampers:
                    write_resealed(mutator)
                    with self.assertRaises(trainer.R22TrainingError):
                        trainer.validate_output(output)

                manifest_path.write_bytes(original_manifest)
                marker_path.write_bytes(original_marker)
                changed_marker = json.loads(original_marker.decode("utf-8"))
                changed_marker["producer"]["frozen_r21_engine"]["byte_size"] += 1
                marker_path.write_bytes(
                    trainer.r21.json_bytes(
                        trainer.r21.seal_record(changed_marker), pretty=True
                    )
                )
                with self.assertRaises(trainer.R22TrainingError):
                    trainer.validate_output(output)

                marker_path.write_bytes(original_marker)
                from safetensors.torch import load_file, save_file

                sidecar_name = "fold-00-family-margin-r22-concat.safetensors"
                sidecar_path = output / sidecar_name
                original_sidecar = sidecar_path.read_bytes()
                changed_state = {
                    name: value.clone()
                    for name, value in load_file(str(sidecar_path)).items()
                }
                changed_state["family_margin_head.weight"][0, 0] = 0.25
                save_file(changed_state, str(sidecar_path))
                coherent = json.loads(original_manifest.decode("utf-8"))
                coherent["files"][sidecar_name] = {
                    "byte_size": sidecar_path.stat().st_size,
                    "sha256": trainer.sha256_file(sidecar_path),
                    "tensor_inventory": trainer.r0._tensor_inventory(changed_state),
                }
                manifest_path.write_bytes(
                    trainer.r21.json_bytes(
                        trainer.r21.seal_record(coherent), pretty=True
                    )
                )
                coherent_marker = json.loads(original_marker.decode("utf-8"))
                coherent_marker["artifacts"][trainer.MANIFEST_FILE] = (
                    trainer.sha256_file(manifest_path)
                )
                coherent_marker["artifacts"][sidecar_name] = trainer.sha256_file(
                    sidecar_path
                )
                marker_path.write_bytes(
                    trainer.r21.json_bytes(
                        trainer.r21.seal_record(coherent_marker), pretty=True
                    )
                )
                with self.assertRaisesRegex(
                    trainer.R22TrainingError, "not selected post-base state"
                ):
                    trainer.validate_output(output)

                sidecar_path.write_bytes(original_sidecar)
                manifest_path.write_bytes(original_manifest)
                marker_path.write_bytes(original_marker)
                restored = trainer.validate_output(output)
                self.assertEqual(
                    result["manifest_record_sha256"],
                    restored["manifest_record_sha256"],
                )
                changed_current_producer = {
                    **trainer._producer_binding(),
                    "r22_producer": {
                        **trainer._producer_binding()["r22_producer"],
                        "byte_size": trainer._producer_binding()["r22_producer"][
                            "byte_size"
                        ]
                        + 1,
                    },
                }
                with (
                    mock.patch.object(
                        trainer,
                        "_producer_binding",
                        return_value=changed_current_producer,
                    ),
                    self.assertRaisesRegex(
                        trainer.R22TrainingError, "producer binding"
                    ),
                ):
                    trainer.validate_output(output)

    def test_reparse_guards_run_before_control_or_output_reads(self) -> None:
        with (
            mock.patch.object(
                trainer.r0.overlay_v3,
                "_path_or_ancestor_is_link_or_reparse",
                return_value=True,
            ),
            self.assertRaisesRegex(trainer.R22TrainingError, "linked.*reparsed"),
        ):
            trainer._load_control_contract()

        control = self.control()
        with (
            mock.patch.object(trainer, "_load_control_contract", return_value=control),
            mock.patch.object(
                trainer, "_assert_frozen_engine", return_value=trainer.CONTROL_PRODUCER
            ),
            mock.patch.object(
                trainer, "_producer_binding", return_value={"synthetic": True}
            ),
            mock.patch.object(
                trainer.r0.overlay_v3,
                "_path_or_ancestor_is_link_or_reparse",
                return_value=True,
            ),
            self.assertRaisesRegex(trainer.R22TrainingError, "linked or reparsed"),
        ):
            trainer.validate_output(Path("synthetic-linked-r22-output"))


if __name__ == "__main__":
    unittest.main()
