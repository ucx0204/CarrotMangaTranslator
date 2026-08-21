from __future__ import annotations

import argparse
import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch

from scripts import train_manga_font_v3_page_consistency_adapter as trainer


class MangaFontV3PageConsistencyAdapterTests(unittest.TestCase):
    def synthetic_base_metrics(self) -> dict[str, object]:
        return {
            "all": {
                "acceptable_at1": 0.7,
                "family_accuracy": 0.9,
                "preferred_at1": 0.6,
                "single_day_body_false_top1_count": 0,
            },
            "quality_gate_passed": True,
            "visual": {
                "acceptable_at1": 0.7,
                "preferred_at1": 0.6,
                "family_accuracy": 0.9,
                "single_day_body_false_top1_count": 0,
            },
        }

    def synthetic_regression_checks(self) -> dict[str, bool]:
        return {name: True for name in trainer.EXPECTED_BASE_REGRESSION_CHECKS}

    def synthetic_development_diagnostics(self) -> dict[str, object]:
        return {
            "candidate_score_delta_within_configured_bound": True,
            "page_consistency_checks": {
                name: False for name in trainer.EXPECTED_OVERLAY_IMPROVEMENT_CHECKS
            },
            "used_for_checkpoint_export": False,
        }

    def synthetic_history(self) -> list[dict[str, object]]:
        metrics = {
            "direct_family": {
                "balanced_accuracy": 0.5,
                "body_accuracy": 0.5,
                "variant_accuracy": 0.5,
            },
            "page_consistency": {
                "all_rows_top1_in_common_positive_rate": 0.0,
                "mean_common_positive_mass": 0.0,
                "mean_js": 0.0,
                "top1_all_agree_rate": 0.0,
            },
        }
        return [
            {
                "base_metrics": self.synthetic_base_metrics(),
                "base_no_material_regression": True,
                "base_regression_checks": self.synthetic_regression_checks(),
                "checkpoint_selection_inputs": list(
                    trainer.CHECKPOINT_SELECTION_INPUTS
                ),
                "development_eval_consulted": False,
                "epoch": 0,
                "family_override_consumption": {
                    "conflict_rows": 0,
                    "override_batches": 0,
                    "override_rows": 0,
                },
                "training_only_selection_metrics": metrics,
            },
            {
                "base_metrics": self.synthetic_base_metrics(),
                "base_no_material_regression": True,
                "base_regression_checks": self.synthetic_regression_checks(),
                "checkpoint_selection_inputs": list(
                    trainer.CHECKPOINT_SELECTION_INPUTS
                ),
                "development_eval_consulted": False,
                "epoch": 1,
                "family_override_consumption": {
                    "conflict_rows": 630,
                    "direct_family_batches": 9,
                    "direct_family_rows": 1_042,
                    "override_batches": 9,
                    "override_rows": 1_042,
                    "page_consistency_batches": 12,
                    "page_consistency_groups": 91,
                },
                "training_only_selection_metrics": metrics,
            },
        ]

    def synthetic_selection(self) -> dict[str, object]:
        return {
            "anchor_fallback_selected": True,
            "base_gradient_rows": 12_923,
            "best_epoch": 0,
            "development_eval_consulted_during_checkpoint_selection": False,
            "development_eval_excluded_work_ids": list(
                trainer.EXPECTED_DEVELOPMENT_EVAL_WORK_IDS
            ),
            "development_eval_gradient_rows": 0,
            "development_eval_label_rows_consulted_during_checkpoint_selection": 0,
            "direct_family_gradient_rows": 1_042,
            "model_selection_label_sources": list(
                trainer.MODEL_SELECTION_LABEL_SOURCES
            ),
            "page_consistency_gradient_groups": 91,
            "page_consistency_gradient_rows": 197,
            "selection_key_order": list(trainer.SELECTION_KEY_ORDER),
        }

    def synthetic_trainable_parameters(self, scope: str) -> dict[str, object]:
        return {
            "candidate_parameter_count": (
                trainer.EXPECTED_CANDIDATE_PARAMETER_COUNT if scope == "all" else 0
            ),
            "candidate_parameter_lr_multiplier": 0.25,
            "candidate_parameter_names": (
                list(trainer.EXPECTED_CANDIDATE_PARAMETER_NAMES)
                if scope == "all"
                else []
            ),
            "family_parameter_count": trainer.EXPECTED_FAMILY_PARAMETER_COUNT,
            "family_parameter_names": list(trainer.EXPECTED_FAMILY_PARAMETER_NAMES),
            "trainable_scope": scope,
        }

    def synthetic_configuration(self, scope: str) -> dict[str, object]:
        args = trainer.build_parser().parse_args(
            [
                "train",
                "--output-dir",
                "unused-synthetic-output",
                "--trainable-scope",
                scope,
                "--candidate-parameter-lr-multiplier",
                "0.25",
                "--epochs",
                "1",
            ]
        )
        configuration = {
            name: getattr(args, name)
            for name in trainer.EXPECTED_CONFIGURATION_KEYS
            if name != "effective_overlay_weights"
        }
        configuration["effective_overlay_weights"] = trainer.effective_overlay_weights(
            trainable_scope=scope,
            direct_body_ce_weight=args.direct_body_ce_weight,
            direct_family_ce_weight=args.direct_family_ce_weight,
            consistency_js_weight=args.consistency_js_weight,
            common_positive_mass_weight=args.common_positive_mass_weight,
        )
        return configuration

    def masks(self) -> dict[str, torch.Tensor]:
        positive = torch.tensor(
            [
                [1, 0, 0, 0],
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 1, 0, 0],
            ],
            dtype=torch.bool,
        )
        eligible = torch.tensor(
            [
                [1, 1, 0, 0],
                [1, 1, 0, 0],
                [0, 1, 1, 0],
                [0, 1, 1, 0],
            ],
            dtype=torch.bool,
        )
        shared = eligible.clone()
        common = positive.clone()
        return {
            "family_logits": torch.tensor(
                [[2.0, -2.0], [2.0, -2.0], [2.0, -2.0], [2.0, -2.0]]
            ),
            "positive_mask": positive,
            "eligible_mask": eligible,
            "shared_reviewed_eligible_mask": shared,
            "common_positive_mask": common,
            "group_indices": torch.tensor([0, 0, 1, 1]),
        }

    def test_base_inventory_binding_uses_exact_json_contract(self) -> None:
        runtime_inventory = {
            "candidate_ids": ("font-a", "font-b"),
            "row_count": 2,
            "train_rows": 1,
        }
        sealed_inventory = json.loads(trainer.canonical_json(runtime_inventory))
        self.assertEqual(
            sealed_inventory, trainer._json_contract_value(runtime_inventory)
        )
        changed = copy.deepcopy(sealed_inventory)
        changed["candidate_ids"][1] = "font-c"
        self.assertNotEqual(changed, trainer._json_contract_value(runtime_inventory))

    def test_losses_ignore_unreviewed_candidates(self) -> None:
        masks = self.masks()
        scores = torch.tensor(
            [
                [2.0, 0.0, -1.0, 100.0],
                [0.0, 2.0, 3.0, -100.0],
                [4.0, 2.0, 0.0, 100.0],
                [-4.0, 0.0, 2.0, -100.0],
            ]
        )
        first = trainer.page_consistency_losses(torch, scores, **masks)
        changed = scores.clone()
        changed[:, 3] *= -1000.0
        second = trainer.page_consistency_losses(torch, changed, **masks)
        for name in (
            "consistency_js",
            "common_positive_mass",
            "reviewed_candidate_set_ce_diagnostic",
        ):
            self.assertAlmostEqual(float(first[name]), float(second[name]), places=6)
        self.assertGreater(float(first["consistency_js"]), 0.0)

    def test_consistency_js_is_zero_for_identical_group_distributions(self) -> None:
        masks = self.masks()
        scores = torch.tensor(
            [
                [2.0, 0.0, 9.0, 9.0],
                [2.0, 0.0, -9.0, -9.0],
                [9.0, 2.0, 0.0, 9.0],
                [-9.0, 2.0, 0.0, -9.0],
            ]
        )
        losses = trainer.page_consistency_losses(torch, scores, **masks)
        self.assertAlmostEqual(0.0, float(losses["consistency_js"]), places=7)

    def test_family_head_only_explicitly_disables_candidate_objectives(self) -> None:
        contract = trainer.effective_overlay_weights(
            trainable_scope="family-head-only",
            direct_body_ce_weight=0.1,
            direct_family_ce_weight=0.4,
            consistency_js_weight=0.2,
            common_positive_mass_weight=0.3,
        )
        self.assertTrue(contract["candidate_objectives_disabled"])
        self.assertEqual(
            {
                "common_positive_mass": 0.0,
                "consistency_js": 0.0,
                "direct_body_ce": 0.1,
                "direct_family_ce": 0.4,
            },
            contract["effective"],
        )

    def test_non_direct_base_family_supervision_cannot_be_disabled(self) -> None:
        args = trainer.build_parser().parse_args(["preflight", "--family-weight", "0"])
        with self.assertRaisesRegex(
            trainer.PageConsistencyTrainingError,
            "non-direct base family supervision must remain enabled",
        ):
            trainer._validate_options(args)

    def test_trainable_parameter_inventory_matches_runtime_model(self) -> None:
        for scope in ("family-head-only", "all"):
            with self.subTest(scope=scope):
                model = trainer.v8.build_role_family_adapter(
                    torch,
                    candidate_count=len(trainer.EXPECTED_CANDIDATE_IDS),
                    maximum_family_bias=0.1,
                    candidate_residual_hidden_dim=64,
                    maximum_sample_residual=0.75,
                )
                _, inventory = trainer.v8.optimizer_parameter_groups(
                    model,
                    learning_rate=5e-5,
                    trainable_scope=scope,
                    candidate_parameter_lr_multiplier=0.25,
                )
                self.assertEqual(self.synthetic_trainable_parameters(scope), inventory)

    def test_linked_base_is_rejected_before_v8_loader_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real_base = root / "base.npz"
            real_base.write_bytes(b"not-loaded")
            linked_base = root / "linked-base.npz"
            try:
                linked_base.symlink_to(real_base)
            except OSError:
                original = trainer.overlay_v3._path_or_ancestor_is_link_or_reparse

                def linked_base_only(path: Path) -> bool:
                    if Path(path).absolute() == linked_base.absolute():
                        return True
                    return original(path)

                link_context = mock.patch.object(
                    trainer.overlay_v3,
                    "_path_or_ancestor_is_link_or_reparse",
                    side_effect=linked_base_only,
                )
            else:
                link_context = mock.patch.object(
                    trainer.overlay_v3,
                    "_path_or_ancestor_is_link_or_reparse",
                    wraps=trainer.overlay_v3._path_or_ancestor_is_link_or_reparse,
                )
            args = argparse.Namespace(
                anchor_adapter_dir=root / "unused-anchor",
                base_npz=linked_base,
                overlay_dir=root / "unused-overlay",
                source_query_head=root / "unused-head",
            )
            with (
                link_context,
                mock.patch.object(trainer.v8, "_load_training_npz") as load_base,
            ):
                with self.assertRaisesRegex(
                    trainer.PageConsistencyTrainingError,
                    "base NPZ cannot be linked",
                ):
                    trainer._load_context(args, torch)
                load_base.assert_not_called()

    def test_direct_family_ce_trains_body_and_variant_rows(self) -> None:
        logits = torch.tensor([[0.0, 2.0], [2.0, 0.0]], requires_grad=True)
        loss = trainer.direct_family_loss(
            torch,
            logits,
            family_labels=torch.tensor([0, 1]),
            row_weights=torch.tensor([1.0, 1.0]),
        )
        loss.backward()
        self.assertGreater(float(loss.detach()), 1.0)
        self.assertIsNotNone(logits.grad)
        metrics = trainer.direct_family_metrics(
            torch,
            logits.detach(),
            direct_rows=[{"family_label": 0}, {"family_label": 1}],
        )
        self.assertEqual(0.0, metrics["accuracy"])
        self.assertEqual(1, metrics["body_rows"])
        self.assertEqual(1, metrics["variant_rows"])

    def test_sealed_direct_targets_override_only_base_family_ce(self) -> None:
        arrays = {
            "family_labels": np.asarray([1, 0, 0, 1], dtype=np.int64),
            "family_label_weights": np.asarray([1.0, 2.0, 3.0, 4.0], dtype=np.float32),
            "sample_ids": np.asarray(["s0", "s1", "s2", "s3"]),
            "split": np.zeros(4, dtype=np.int64),
            "work_ids": np.asarray(["train", "train", "eval", "eval"]),
        }
        direct = {
            "train": [
                {
                    "family_label": 0,
                    "row_index": 0,
                    "supervision_weight": 0.5,
                },
                {
                    "family_label": 0,
                    "row_index": 1,
                    "supervision_weight": 0.6,
                },
            ],
            "development_eval": [
                {
                    "family_label": 1,
                    "row_index": 2,
                    "supervision_weight": 0.7,
                },
                {
                    "family_label": 1,
                    "row_index": 3,
                    "supervision_weight": 0.8,
                },
            ],
        }
        labels, weights, contract = trainer.build_family_override_contract(
            arrays,
            direct,
            development_eval_work_ids=["eval"],
            expected_counts=None,
        )
        np.testing.assert_array_equal(labels, np.asarray([0, 0, 0, 1]))
        np.testing.assert_allclose(weights, np.asarray([0.5, 0.6, 3.0, 4.0]))
        np.testing.assert_array_equal(arrays["family_labels"], np.asarray([1, 0, 0, 1]))
        self.assertTrue(
            contract["base_candidate_and_single_day_route_labels_unchanged"]
        )
        self.assertEqual(1, contract["counts"]["direct_train_conflicts"])
        self.assertEqual(1, contract["counts"]["direct_development_eval_conflicts"])
        self.assertEqual(0, contract["development_eval_overrides_applied"])
        logits = torch.tensor(
            [[-2.0, 2.0], [2.0, -2.0], [2.0, -2.0], [-2.0, 2.0]],
            requires_grad=True,
        )
        loss = trainer.base_family_training_loss(
            torch,
            logits,
            family_labels=torch.from_numpy(labels),
            family_label_weights=torch.from_numpy(weights),
        )
        loss.backward()
        self.assertLess(float(logits.grad[0, 0]), 0.0)
        self.assertGreater(float(logits.grad[0, 1]), 0.0)

    def test_runtime_metrics_do_not_hide_unreviewed_full_inventory_top1(self) -> None:
        groups = [
            {
                "common_positive_mask": np.asarray([True, False, False, False]),
                "group_id": "g1",
                "row_indices": np.asarray([0, 1]),
                "shared_reviewed_eligible_mask": np.asarray([True, True, False, False]),
                "work_id": "work-1",
            }
        ]
        outputs = {
            "body_candidate_scores": torch.tensor(
                [[3.0, 1.0, 9.0, -9.0], [3.0, 1.0, -9.0, -9.0]]
            ),
            "variant_candidate_scores": torch.zeros((2, 4)),
            "family_logits": torch.tensor([[9.0, -9.0], [9.0, -9.0]]),
        }
        metrics = trainer.overlay_metrics(
            torch,
            outputs,
            groups=groups,
            candidate_ids=("font-a", "font-b", "unreviewed", "single-day"),
        )
        self.assertEqual(
            1.0,
            metrics["reviewed_support"]["all_rows_top1_in_common_positive_rate"],
        )
        self.assertEqual(0.0, metrics["all_rows_top1_in_common_positive_rate"])
        self.assertEqual(0.0, metrics["top1_all_agree_rate"])
        self.assertEqual(
            "production_deployed_full_candidate_inventory",
            metrics["probability_support"],
        )

    def test_overlay_diagnostic_checks_js_and_discrete_nonregression(self) -> None:
        anchor = {
            "mean_js": 0.20,
            "top1_all_agree_rate": 0.50,
            "all_rows_top1_in_common_positive_rate": 0.40,
            "mean_body_probability": 0.70,
            "predicted_body_rate": 0.75,
        }
        candidate = {
            **anchor,
            "mean_js": 0.15,
            "top1_all_agree_rate": 0.60,
            "all_rows_top1_in_common_positive_rate": 0.45,
        }
        checks = trainer.overlay_improvement_checks(
            anchor,
            candidate,
            minimum_js_improvement=0.01,
            minimum_rate_improvement=0.01,
            maximum_body_rate_regression=0.01,
        )
        self.assertTrue(all(checks.values()))
        candidate["top1_all_agree_rate"] = 0.30
        checks = trainer.overlay_improvement_checks(
            anchor,
            candidate,
            minimum_js_improvement=0.01,
            minimum_rate_improvement=0.01,
            maximum_body_rate_regression=0.01,
        )
        self.assertFalse(checks["top1_all_agree_rate_nonregression"])

    def test_bounded_diagnostics_exposes_requested_grids(self) -> None:
        groups = [
            {
                "group_id": "g1",
                "row_indices": np.asarray([0, 1]),
                "shared_reviewed_eligible_mask": np.asarray([True, True, False]),
            }
        ]
        anchor = {
            "body_candidate_scores": torch.zeros((2, 3)),
            "family_logits": torch.tensor([[0.0, 3.0], [0.0, 3.0]]),
        }
        candidate = {
            "body_candidate_scores": torch.tensor(
                [[0.1, -0.1, 99.0], [0.2, -0.2, -99.0]]
            ),
            "family_logits": torch.tensor([[0.0, 3.0], [0.0, 3.0]]),
        }
        result = trainer.bounded_drift_diagnostics(
            torch, candidate, anchor, groups=groups
        )
        self.assertEqual(
            {"0", "1", "2", "3", "4"},
            set(result["family_body_logit_shift_grid"]),
        )
        self.assertEqual(
            {"0", "0.1", "0.2", "0.35"},
            set(result["candidate_body_score_delta"]["budget_grid"]),
        )
        self.assertAlmostEqual(
            0.2,
            result["candidate_body_score_delta"]["maximum_absolute_delta"],
        )

    def test_epoch_zero_anchor_remains_when_train_metrics_regress(self) -> None:
        base = {
            "all": {
                "acceptable_at1": 0.7,
                "family_accuracy": 0.9,
                "preferred_at1": 0.6,
            },
            "quality_gate_passed": True,
            "visual": {
                "acceptable_at1": 0.7,
                "preferred_at1": 0.6,
            },
        }
        regression = {"safe": True}
        anchor = self.synthetic_history()[0]["training_only_selection_metrics"]
        worse = {
            "direct_family": {
                "balanced_accuracy": 0.4,
                "body_accuracy": 0.9,
                "variant_accuracy": 0.0,
            },
            "page_consistency": anchor["page_consistency"],
        }
        better = {
            "direct_family": {
                "balanced_accuracy": 0.6,
                "body_accuracy": 0.6,
                "variant_accuracy": 0.6,
            },
            "page_consistency": anchor["page_consistency"],
        }
        anchor_key = trainer._selection_key(base, regression, anchor)
        self.assertGreater(anchor_key, trainer._selection_key(base, regression, worse))
        self.assertGreater(trainer._selection_key(base, regression, better), anchor_key)

    def test_rejected_artifact_has_no_checkpoint_and_is_tamper_evident(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "rejected"
            root.mkdir()
            manifest = trainer.seal_record(
                {
                    "anchor": {
                        "checkpoint_sha256": trainer.EXPECTED_ANCHOR_CHECKPOINT_SHA256,
                        "frozen": True,
                        "initialization_and_anchor_are_identical": True,
                        "manifest_record_sha256": (
                            trainer.EXPECTED_ANCHOR_MANIFEST_RECORD_SHA256
                        ),
                        "manifest_sha256": trainer.EXPECTED_ANCHOR_MANIFEST_SHA256,
                        "output_dir": "unused-in-synthetic-validation",
                    },
                    "architecture": trainer.v8.adapter_architecture_contract(
                        candidate_count=21,
                        maximum_family_bias=0.1,
                        candidate_residual_hidden_dim=64,
                        maximum_sample_residual=0.75,
                    ),
                    "base_dataset": {
                        "file": "unused-in-synthetic-validation",
                        "sha256": trainer.EXPECTED_BASE_NPZ_SHA256,
                    },
                    "base_metrics": {},
                    "candidate_ids": list(trainer.EXPECTED_CANDIDATE_IDS),
                    "candidate_weighting": {},
                    "configuration": self.synthetic_configuration("all"),
                    "development_diagnostics": (
                        self.synthetic_development_diagnostics()
                    ),
                    "diagnostics": {},
                    "direct_family_metrics": {},
                    "export_decision": {
                        "checks": {
                            name: name
                            != "base_validation_candidate_score_delta_within_bound"
                            for name in trainer.EXPECTED_EXPORT_CHECKS
                        },
                        "checkpoint_exported": False,
                        "promotion_claimed": False,
                        "status": "rejected_base_regression",
                    },
                    "authority": dict(trainer.EXPECTED_AUTHORITY),
                    "files": {},
                    "family_override": {
                        "base_candidate_and_single_day_route_labels_unchanged": True,
                        "counts": dict(trainer.EXPECTED_FAMILY_OVERRIDE_COUNTS),
                        "development_eval_overrides_applied": 0,
                        "direct_train_overrides_applied": 1_042,
                        "direct_train_override_inventory_sha256": "0" * 64,
                        "direct_train_supervision_authority": (
                            "training_only_non_human_visual"
                        ),
                    },
                    "history": self.synthetic_history(),
                    "overlay": {},
                    "overlay_metrics": {},
                    "record_type": ("manga_font_v3_page_consistency_adapter_manifest"),
                    "runtime_architecture_unchanged": True,
                    "schema_version": trainer.SCHEMA_VERSION,
                    "selection": self.synthetic_selection(),
                    "source_query_head": {
                        "file": "unused-in-synthetic-validation",
                        "sha256": trainer.EXPECTED_SOURCE_QUERY_HEAD_SHA256,
                    },
                    "trainable_parameters": self.synthetic_trainable_parameters("all"),
                    "training_seconds": 0.0,
                }
            )
            manifest_path = root / trainer.MANIFEST_FILE
            marker_path = root / trainer.MARKER_FILE

            def write_resealed(payload: dict[str, object]) -> None:
                sealed = trainer.seal_record(payload)
                manifest_path.write_bytes(trainer.json_bytes(sealed, pretty=True))
                marker = trainer.seal_record(
                    {
                        "artifacts": {
                            trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path)
                        },
                        "owner": trainer.OWNER,
                        "safe_replace": False,
                        "schema_version": trainer.SCHEMA_VERSION,
                    }
                )
                marker_path.write_bytes(trainer.json_bytes(marker, pretty=True))

            baseline = copy.deepcopy(manifest)
            write_resealed(baseline)
            result = trainer.validate_output(root, require_external_sources=False)
            self.assertFalse(result["checkpoint_exported"])

            elevated = copy.deepcopy(baseline)
            elevated["authority"]["evaluation_authority"] = True
            elevated["authority"]["training_label_authority"] = "human_gold"
            elevated["authority"][
                "development_eval_is_post_selection_diagnostic_only"
            ] = False
            write_resealed(elevated)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "authority was elevated"
            ):
                trainer.validate_output(root, require_external_sources=False)

            root_authority_extra = copy.deepcopy(baseline)
            root_authority_extra["evaluation_authority"] = True
            write_resealed(root_authority_extra)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "marker/manifest drifted"
            ):
                trainer.validate_output(root, require_external_sources=False)

            dev_selected = copy.deepcopy(baseline)
            dev_selected["selection"][
                "development_eval_label_rows_consulted_during_checkpoint_selection"
            ] = 305
            write_resealed(dev_selected)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "authority was elevated"
            ):
                trainer.validate_output(root, require_external_sources=False)

            tied_late_epoch = copy.deepcopy(baseline)
            tied_late_epoch["selection"]["best_epoch"] = 1
            tied_late_epoch["selection"]["anchor_fallback_selected"] = False
            write_resealed(tied_late_epoch)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "argmax drifted"
            ):
                trainer.validate_output(root, require_external_sources=False)

            forged_anchor_regression = copy.deepcopy(baseline)
            forged_anchor_regression["history"][0]["base_regression_checks"][
                "all_family_nonmaterial_regression"
            ] = False
            forged_anchor_regression["history"][0]["base_no_material_regression"] = (
                False
            )
            forged_anchor_regression["selection"]["best_epoch"] = 1
            forged_anchor_regression["selection"]["anchor_fallback_selected"] = False
            write_resealed(forged_anchor_regression)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError,
                "training-only selection metrics drifted",
            ):
                trainer.validate_output(root, require_external_sources=False)

            dev_history = copy.deepcopy(baseline)
            dev_history["history"][1]["checkpoint_selection_inputs"] = [
                "development_eval"
            ]
            write_resealed(dev_history)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError,
                "training-only selection metrics drifted",
            ):
                trainer.validate_output(root, require_external_sources=False)

            bogus_scope = copy.deepcopy(baseline)
            bogus_scope["configuration"]["trainable_scope"] = "bogus"
            bogus_scope["trainable_parameters"]["trainable_scope"] = "bogus"
            write_resealed(bogus_scope)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "trainable scope drifted"
            ):
                trainer.validate_output(root, require_external_sources=False)

            trainable_inventory = copy.deepcopy(baseline)
            trainable_inventory["trainable_parameters"][
                "candidate_parameter_names"
            ] = []
            trainable_inventory["trainable_parameters"]["candidate_parameter_count"] = 0
            write_resealed(trainable_inventory)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError,
                "trainable parameter inventory drifted",
            ):
                trainer.validate_output(root, require_external_sources=False)

            disabled_base_family = copy.deepcopy(baseline)
            disabled_base_family["configuration"]["family_weight"] = 0.0
            write_resealed(disabled_base_family)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError,
                "family supervision must remain enabled",
            ):
                trainer.validate_output(root, require_external_sources=False)

            configuration_extra = copy.deepcopy(baseline)
            configuration_extra["configuration"]["evaluation_authority"] = True
            write_resealed(configuration_extra)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError,
                "configuration inventory drifted",
            ):
                trainer.validate_output(root, require_external_sources=False)

            consumption = copy.deepcopy(baseline)
            consumption["history"][1]["family_override_consumption"][
                "conflict_rows"
            ] = 629
            write_resealed(consumption)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "batch consumption drifted"
            ):
                trainer.validate_output(root, require_external_sources=False)
            manifest_path.write_text("{}\n", encoding="utf-8")
            with self.assertRaises(trainer.PageConsistencyTrainingError):
                trainer.validate_output(root, require_external_sources=False)

    def test_family_head_only_rejects_resealed_frozen_tensor_drift(self) -> None:
        from safetensors.numpy import load_file, save_file

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "family-only"
            root.mkdir()
            anchor_dir = trainer.DEFAULT_ANCHOR_DIR.resolve()
            checkpoint_path = root / trainer.CHECKPOINT_FILE
            shutil.copyfile(anchor_dir / trainer.v8.CHECKPOINT_FILE, checkpoint_path)

            def write_seals(*, best_epoch: int = 0) -> None:
                history = self.synthetic_history()
                selection = self.synthetic_selection()
                if best_epoch == 1:
                    history[1]["training_only_selection_metrics"] = copy.deepcopy(
                        history[1]["training_only_selection_metrics"]
                    )
                    history[1]["training_only_selection_metrics"][
                        "direct_family"
                    ].update(
                        {
                            "balanced_accuracy": 0.6,
                            "body_accuracy": 0.6,
                            "variant_accuracy": 0.6,
                        }
                    )
                    selection["anchor_fallback_selected"] = False
                    selection["best_epoch"] = 1
                manifest = trainer.seal_record(
                    {
                        "anchor": {
                            "checkpoint_sha256": (
                                trainer.EXPECTED_ANCHOR_CHECKPOINT_SHA256
                            ),
                            "frozen": True,
                            "initialization_and_anchor_are_identical": True,
                            "manifest_record_sha256": (
                                trainer.EXPECTED_ANCHOR_MANIFEST_RECORD_SHA256
                            ),
                            "manifest_sha256": (
                                trainer.EXPECTED_ANCHOR_MANIFEST_SHA256
                            ),
                            "output_dir": str(anchor_dir),
                        },
                        "architecture": trainer.v8.adapter_architecture_contract(
                            candidate_count=21,
                            maximum_family_bias=0.1,
                            candidate_residual_hidden_dim=64,
                            maximum_sample_residual=0.75,
                        ),
                        "authority": dict(trainer.EXPECTED_AUTHORITY),
                        "base_dataset": {
                            "file": "unused-in-synthetic-validation",
                            "sha256": trainer.EXPECTED_BASE_NPZ_SHA256,
                        },
                        "base_metrics": {},
                        "candidate_ids": list(trainer.EXPECTED_CANDIDATE_IDS),
                        "candidate_weighting": {},
                        "configuration": self.synthetic_configuration(
                            "family-head-only"
                        ),
                        "development_diagnostics": (
                            self.synthetic_development_diagnostics()
                        ),
                        "diagnostics": {},
                        "direct_family_metrics": {},
                        "export_decision": {
                            "checks": {
                                name: True for name in trainer.EXPECTED_EXPORT_CHECKS
                            },
                            "checkpoint_exported": True,
                            "promotion_claimed": False,
                            "status": "experimental_checkpoint_exported",
                        },
                        "family_override": {
                            "base_candidate_and_single_day_route_labels_unchanged": True,
                            "counts": dict(trainer.EXPECTED_FAMILY_OVERRIDE_COUNTS),
                            "development_eval_overrides_applied": 0,
                            "direct_train_overrides_applied": 1_042,
                            "direct_train_override_inventory_sha256": "0" * 64,
                            "direct_train_supervision_authority": (
                                "training_only_non_human_visual"
                            ),
                        },
                        "files": {
                            trainer.CHECKPOINT_FILE: {
                                "byte_size": checkpoint_path.stat().st_size,
                                "sha256": trainer.sha256_file(checkpoint_path),
                            }
                        },
                        "history": history,
                        "overlay": {},
                        "overlay_metrics": {},
                        "record_type": (
                            "manga_font_v3_page_consistency_adapter_manifest"
                        ),
                        "runtime_architecture_unchanged": True,
                        "schema_version": trainer.SCHEMA_VERSION,
                        "selection": selection,
                        "source_query_head": {
                            "file": "unused-in-synthetic-validation",
                            "sha256": trainer.EXPECTED_SOURCE_QUERY_HEAD_SHA256,
                        },
                        "trainable_parameters": self.synthetic_trainable_parameters(
                            "family-head-only"
                        ),
                        "training_seconds": 0.0,
                    }
                )
                manifest_path = root / trainer.MANIFEST_FILE
                manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
                marker = trainer.seal_record(
                    {
                        "artifacts": {
                            trainer.CHECKPOINT_FILE: trainer.sha256_file(
                                checkpoint_path
                            ),
                            trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path),
                        },
                        "owner": trainer.OWNER,
                        "safe_replace": False,
                        "schema_version": trainer.SCHEMA_VERSION,
                    }
                )
                (root / trainer.MARKER_FILE).write_bytes(
                    trainer.json_bytes(marker, pretty=True)
                )

            write_seals()
            self.assertTrue(
                trainer.validate_output(root, require_external_sources=False)[
                    "checkpoint_exported"
                ]
            )
            state = {
                name: value.copy() for name, value in load_file(checkpoint_path).items()
            }
            family_name = "family_head.bias"
            self.assertIn(family_name, state)
            state[family_name].flat[0] += np.float32(1e-6)
            save_file(state, checkpoint_path)
            write_seals()
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError,
                "anchor-fallback checkpoint drifted",
            ):
                trainer.validate_output(root, require_external_sources=False)

            shutil.copyfile(anchor_dir / trainer.v8.CHECKPOINT_FILE, checkpoint_path)
            state = {
                name: value.copy() for name, value in load_file(checkpoint_path).items()
            }
            frozen_name = "body_query_weight_logits"
            self.assertIn(frozen_name, state)
            state[frozen_name].flat[0] += np.float32(0.01)
            save_file(state, checkpoint_path)
            write_seals(best_epoch=1)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "frozen tensors drifted"
            ):
                trainer.validate_output(root, require_external_sources=False)

    def test_strict_export_recomputation_binds_checkpoint_metrics(self) -> None:
        from safetensors.torch import save_file

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = trainer.v8.build_role_family_adapter(
                torch,
                candidate_count=len(trainer.EXPECTED_CANDIDATE_IDS),
                maximum_family_bias=0.1,
                candidate_residual_hidden_dim=64,
                maximum_sample_residual=0.75,
            )
            save_file(model.state_dict(), str(root / trainer.CHECKPOINT_FILE))
            context = {
                "arrays": {
                    "prototype_queries": np.zeros((21, 4, 256), dtype=np.float32),
                    "query_views": np.zeros((1, 3, 4, 256), dtype=np.float16),
                },
                "candidate_ids": trainer.EXPECTED_CANDIDATE_IDS,
                "groups": {
                    "development_eval": [],
                    "direct_family": {
                        "development_eval": [],
                        "train": [],
                    },
                    "train": [],
                },
                "model": model,
            }
            anchor_base = self.synthetic_base_metrics()
            candidate_base = copy.deepcopy(anchor_base)
            overlay_values = [
                {"split": "train", "model": "anchor"},
                {"split": "train", "model": "candidate"},
                {"split": "development_eval", "model": "anchor"},
                {"split": "development_eval", "model": "candidate"},
            ]
            direct_values = [
                {"split": "train", "model": "anchor"},
                {"split": "train", "model": "candidate"},
                {"split": "development_eval", "model": "anchor"},
                {"split": "development_eval", "model": "candidate"},
            ]
            overlay_drift = [
                {
                    "candidate_body_score_delta": {"maximum_absolute_delta": 0.1},
                    "split": "train",
                },
                {
                    "candidate_body_score_delta": {"maximum_absolute_delta": 0.1},
                    "split": "development_eval",
                },
            ]
            base_drift = {
                "score_drift": {
                    "body": {"maximum_absolute_delta": 0.1},
                    "variant": {"maximum_absolute_delta": 0.2},
                }
            }
            train_selection = self.synthetic_history()[0][
                "training_only_selection_metrics"
            ]
            regression = self.synthetic_regression_checks()
            export_checks = {
                **{f"base_{key}": value for key, value in regression.items()},
                "base_v8_quality_gate_passed": True,
                "base_validation_candidate_score_delta_within_bound": True,
                "development_eval_gradient_rows_zero": True,
                "runtime_architecture_unchanged": True,
            }
            improvement = {
                name: True for name in trainer.EXPECTED_OVERLAY_IMPROVEMENT_CHECKS
            }
            manifest = {
                "base_metrics": {
                    "anchor": anchor_base,
                    "candidate": candidate_base,
                },
                "configuration": {
                    "evaluation_batch_size": 8,
                    "maximum_acceptable_regression": 0.005,
                    "maximum_body_rate_regression": 0.01,
                    "maximum_candidate_score_delta": 0.35,
                    "maximum_family_regression": 0.0025,
                    "maximum_preferred_regression": 0.005,
                    "minimum_overlay_js_improvement": 0.0001,
                    "minimum_overlay_rate_improvement": 0.0,
                },
                "development_diagnostics": {
                    "candidate_score_delta_within_configured_bound": True,
                    "page_consistency_checks": improvement,
                    "used_for_checkpoint_export": False,
                },
                "diagnostics": {
                    "base_validation_anchor_drift": base_drift,
                    "development_eval": overlay_drift[1],
                    "final_parameter_anchor_loss": 0.125,
                    "train": overlay_drift[0],
                },
                "direct_family_metrics": {
                    "development_eval": {
                        "anchor": direct_values[2],
                        "candidate": direct_values[3],
                    },
                    "train": {
                        "anchor": direct_values[0],
                        "candidate": direct_values[1],
                    },
                },
                "export_decision": {"checks": export_checks},
                "history": [
                    {
                        "base_metrics": anchor_base,
                        "base_no_material_regression": True,
                        "base_regression_checks": regression,
                        "training_only_selection_metrics": train_selection,
                    },
                    {
                        "base_metrics": candidate_base,
                        "base_no_material_regression": True,
                        "base_regression_checks": regression,
                        "training_only_selection_metrics": train_selection,
                    },
                ],
                "overlay_metrics": {
                    "development_eval": {
                        "anchor": overlay_values[2],
                        "candidate": overlay_values[3],
                    },
                    "train": {
                        "anchor": overlay_values[0],
                        "candidate": overlay_values[1],
                    },
                },
                "selection": {"best_epoch": 1},
            }

            def recompute(candidate_acceptable: float) -> None:
                candidate_metrics = copy.deepcopy(candidate_base)
                candidate_metrics["all"]["acceptable_at1"] = candidate_acceptable
                with (
                    mock.patch.object(
                        trainer,
                        "evaluate_base",
                        side_effect=[anchor_base, candidate_metrics],
                    ),
                    mock.patch.object(
                        trainer,
                        "_overlay_outputs",
                        side_effect=[object(), object(), object(), object()],
                    ),
                    mock.patch.object(
                        trainer, "overlay_metrics", side_effect=overlay_values
                    ),
                    mock.patch.object(
                        trainer,
                        "_model_outputs",
                        side_effect=[
                            {"family_logits": object()},
                            {"family_logits": object()},
                            {"family_logits": object()},
                            {"family_logits": object()},
                        ],
                    ),
                    mock.patch.object(
                        trainer, "direct_family_metrics", side_effect=direct_values
                    ),
                    mock.patch.object(
                        trainer,
                        "bounded_drift_diagnostics",
                        side_effect=overlay_drift,
                    ),
                    mock.patch.object(
                        trainer,
                        "base_anchor_drift_diagnostics",
                        return_value=base_drift,
                    ),
                    mock.patch.object(
                        trainer, "base_regression_checks", return_value=regression
                    ),
                    mock.patch.object(
                        trainer.v8,
                        "parameter_anchor_loss",
                        return_value=torch.tensor(0.125),
                    ),
                    mock.patch.object(
                        trainer,
                        "overlay_improvement_checks",
                        return_value=improvement,
                    ),
                    mock.patch.object(
                        trainer,
                        "_training_only_selection_metrics",
                        side_effect=[train_selection, train_selection],
                    ),
                ):
                    trainer._strict_recompute_exported_candidate(
                        root=root,
                        manifest=manifest,
                        context=context,
                        torch=torch,
                    )

            recompute(0.7)
            with self.assertRaisesRegex(
                trainer.PageConsistencyTrainingError, "strict base metrics"
            ):
                recompute(0.6)


if __name__ == "__main__":
    unittest.main()
