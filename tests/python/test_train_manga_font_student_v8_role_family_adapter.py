from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import save_file

from scripts import train_manga_font_student_v8_role_family_adapter as v8


class MangaFontV8RoleFamilyAdapterTests(unittest.TestCase):
    def write_initial_adapter(
        self,
        root: Path,
        *,
        candidate_ids: tuple[str, ...] = ("body", "single-day"),
        source_head: Path,
    ) -> tuple[object, dict[str, object]]:
        model = v8.build_role_family_adapter(
            torch,
            candidate_count=len(candidate_ids),
            maximum_family_bias=0.1,
            candidate_residual_hidden_dim=4,
            maximum_sample_residual=0.5,
        )
        checkpoint = root / v8.CHECKPOINT_FILE
        save_file(model.state_dict(), str(checkpoint))
        architecture = dict(
            v8.adapter_architecture_contract(
                candidate_count=len(candidate_ids),
                maximum_family_bias=0.1,
                candidate_residual_hidden_dim=4,
                maximum_sample_residual=0.5,
            )
        )
        manifest = v8.seal_record(
            {
                "architecture": architecture,
                "candidate_ids": list(candidate_ids),
                "files": {
                    v8.CHECKPOINT_FILE: {
                        "byte_size": checkpoint.stat().st_size,
                        "sha256": v8.sha256_file(checkpoint),
                    }
                },
                "quality_gate": {"passed": True},
                "record_type": "manga_font_student_v8_role_family_adapter_manifest",
                "schema_version": v8.SCHEMA_VERSION,
                "source_query_head": {
                    "file": str(source_head),
                    "sha256": v8.sha256_file(source_head),
                },
            }
        )
        manifest_path = root / v8.MANIFEST_FILE
        manifest_path.write_bytes(v8.json_bytes(manifest, pretty=True))
        marker = v8.seal_record(
            {
                "artifacts": {
                    v8.CHECKPOINT_FILE: v8.sha256_file(checkpoint),
                    v8.MANIFEST_FILE: v8.sha256_file(manifest_path),
                },
                "owner": v8.OWNER,
                "safe_replace": True,
                "schema_version": v8.SCHEMA_VERSION,
            }
        )
        (root / v8.MARKER_FILE).write_bytes(v8.json_bytes(marker, pretty=True))
        return model, architecture

    def test_initial_adapter_is_weight_only_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            root = temporary_root / "adapter"
            root.mkdir()
            source_head = temporary_root / "source.safetensors"
            source_head.write_bytes(b"sealed-head")
            model, architecture = self.write_initial_adapter(
                root, source_head=source_head
            )
            state, binding = v8.load_initial_adapter_state(
                root,
                candidate_ids=("body", "single-day"),
                source_query_head=source_head,
                expected_architecture=architecture,
                expected_state=model.state_dict(),
            )
            self.assertEqual(set(model.state_dict()), set(state))
            self.assertTrue(binding["authority"]["weight_initialization_only"])
            self.assertFalse(binding["authority"]["training_label_authority"])
            with self.assertRaisesRegex(v8.MangaFontV8RoleFamilyError, "contract"):
                v8.load_initial_adapter_state(
                    root,
                    candidate_ids=("single-day", "body"),
                    source_query_head=source_head,
                    expected_architecture=architecture,
                    expected_state=model.state_dict(),
                )
            drifted = dict(architecture)
            drifted["maximum_family_bias"] = 0.2
            with self.assertRaisesRegex(v8.MangaFontV8RoleFamilyError, "contract"):
                v8.load_initial_adapter_state(
                    root,
                    candidate_ids=("body", "single-day"),
                    source_query_head=source_head,
                    expected_architecture=drifted,
                    expected_state=model.state_dict(),
                )
            source_head.write_bytes(b"drifted-head")
            with self.assertRaisesRegex(v8.MangaFontV8RoleFamilyError, "contract"):
                v8.load_initial_adapter_state(
                    root,
                    candidate_ids=("body", "single-day"),
                    source_query_head=source_head,
                    expected_architecture=architecture,
                    expected_state=model.state_dict(),
                )

    def test_optimizer_groups_can_freeze_candidate_ranker(self) -> None:
        model = v8.build_role_family_adapter(torch, candidate_count=2)
        groups, report = v8.optimizer_parameter_groups(
            model,
            learning_rate=1e-4,
            trainable_scope="family-head-only",
            candidate_parameter_lr_multiplier=0.1,
        )
        self.assertEqual(1, len(groups))
        self.assertEqual(0, report["candidate_parameter_count"])
        self.assertTrue(report["family_parameter_names"])
        self.assertFalse(model.body_query_weight_logits.requires_grad)
        self.assertTrue(model.family_head.weight.requires_grad)

        model = v8.build_role_family_adapter(torch, candidate_count=2)
        groups, report = v8.optimizer_parameter_groups(
            model,
            learning_rate=1e-4,
            trainable_scope="all",
            candidate_parameter_lr_multiplier=0.05,
        )
        self.assertEqual(2, len(groups))
        self.assertAlmostEqual(5e-6, groups[1]["lr"])
        self.assertGreater(report["candidate_parameter_count"], 0)

    def test_quality_gate_requires_visual_holdout_not_only_combined_rows(self) -> None:
        combined = {
            "acceptable_at1": 0.66,
            "family_accuracy": 0.95,
            "preferred_at1": 0.56,
            "single_day_body_false_top1_rate": 0.0,
            "single_day_predicted_count": 0,
            "single_day_positive_precision": 0.0,
            "single_day_eligibility": {"eligible_top1_all_rows_rate": 0.005},
            "top1_max_candidate_share": 0.45,
        }
        visual = {
            **combined,
            "acceptable_at1": 0.64,
            "single_day_eligibility": {"eligible_top1_all_rows_rate": 0.0},
        }

        checks = v8.build_quality_gate_checks(combined, visual)

        self.assertTrue(checks["acceptable_at1_at_least_0_65"])
        self.assertFalse(checks["visual_acceptable_at1_at_least_0_65"])
        self.assertFalse(all(checks.values()))

    def test_visual_inverse_frequency_weights_preserve_human_authority(self) -> None:
        arrays = {
            "candidate_ids": np.asarray(["body", "specialist"]),
            "font_authority": np.asarray(
                ["visual", "visual", "visual", "visual", "human"]
            ),
            "font_supervision_weights": np.ones(5, dtype=np.float32),
            "positive_mask": np.asarray(
                [[1, 0], [1, 0], [1, 0], [0, 1], [0, 1]], dtype=bool
            ),
            "preferred_mask": np.asarray(
                [[1, 0], [1, 0], [1, 0], [0, 1], [0, 1]], dtype=bool
            ),
            "split": np.zeros(5, dtype=np.int8),
        }
        weights, report = v8.build_candidate_training_weights(arrays)
        self.assertEqual(1.0, float(weights[-1]))
        self.assertGreater(float(weights[3]), float(weights[0]))
        self.assertEqual(1, report["human_train_rows_unchanged"])

    def test_human_and_focus_training_weights_are_train_only(self) -> None:
        arrays = {
            "candidate_ids": np.asarray(["body", "specialist"]),
            "font_authority": np.asarray(
                ["visual", "visual", "human", "human"]
            ),
            "font_supervision_weights": np.ones(4, dtype=np.float32),
            "positive_mask": np.asarray(
                [[1, 0], [0, 1], [0, 1], [0, 1]], dtype=bool
            ),
            "preferred_mask": np.asarray(
                [[1, 0], [0, 1], [0, 1], [0, 1]], dtype=bool
            ),
            "split": np.asarray([0, 0, 0, 1], dtype=np.int8),
        }
        weights, report = v8.build_candidate_training_weights(
            arrays,
            human_multiplier=2.0,
            focus_candidate_ids=("specialist",),
            focus_multiplier=3.0,
        )
        self.assertGreater(float(weights[1]), float(weights[0]))
        self.assertEqual(6.0, float(weights[2]))
        self.assertEqual(1.0, float(weights[3]))
        self.assertEqual(2, report["focus_train_rows"])
        self.assertEqual(0, report["human_train_rows_unchanged"])

    def test_role_family_mapping_excludes_unknown_other(self) -> None:
        self.assertEqual(v8.BODY_FAMILY_INDEX, v8.role_family_index("dialogue"))
        self.assertEqual(v8.VARIANT_FAMILY_INDEX, v8.role_family_index("sfx_impact"))
        self.assertIsNone(v8.role_family_index("other"))

    def test_body_and_variant_score_branches_can_diverge(self) -> None:
        model = v8.build_role_family_adapter(torch, candidate_count=2)
        with torch.no_grad():
            model.body_query_weight_logits.copy_(
                torch.tensor([12.0, -12.0, -12.0, -12.0])
            )
            model.variant_query_weight_logits.copy_(
                torch.tensor([-12.0, 12.0, -12.0, -12.0])
            )
            model.body_logit_scale.zero_()
            model.variant_logit_scale.zero_()
        queries = torch.zeros((1, 3, v8.QUERY_COUNT, v8.QUERY_DIM))
        queries[:, :, 0, 0] = 1.0
        queries[:, :, 1, 1] = 1.0
        prototypes = torch.zeros((2, v8.QUERY_COUNT, v8.QUERY_DIM))
        prototypes[0, 0, 0] = 1.0
        prototypes[1, 1, 1] = 1.0
        outputs = model(queries, prototypes)
        self.assertEqual(
            0, int(outputs["body_candidate_scores"].argmax(dim=1).item())
        )
        self.assertEqual(
            1, int(outputs["variant_candidate_scores"].argmax(dim=1).item())
        )
        self.assertFalse(
            bool(
                torch.equal(
                    outputs["body_candidate_scores"],
                    outputs["variant_candidate_scores"],
                )
            )
        )

    def test_family_gate_expands_to_non_neutral_runtime_roles(self) -> None:
        family = torch.tensor([[3.0, -2.0], [-1.0, 4.0]])
        roles = v8.expand_family_logits_to_role_logits(torch, family)
        self.assertEqual((2, len(v8.legacy.ROLE_VALUES)), tuple(roles.shape))
        self.assertEqual(
            "dialogue",
            v8.legacy.ROLE_VALUES[int(roles[0].argmax().item())],
        )
        self.assertEqual(
            "emphasis_dialogue",
            v8.legacy.ROLE_VALUES[int(roles[1].argmax().item())],
        )
        self.assertGreater(float(roles.std()), 0.0)

    def test_sample_conditioned_residual_is_zero_initialized_then_varies(self) -> None:
        model = v8.build_role_family_adapter(
            torch,
            candidate_count=2,
            candidate_residual_hidden_dim=2,
        )
        queries = torch.zeros((2, 3, v8.QUERY_COUNT, v8.QUERY_DIM))
        queries[0, :, 0, 0] = 1.0
        queries[1, :, 0, 1] = 1.0
        prototypes = torch.zeros((2, v8.QUERY_COUNT, v8.QUERY_DIM))
        prototypes[:, :, 0] = 1.0
        initial = model(queries, prototypes)["sample_candidate_residual"]
        self.assertTrue(bool((initial == 0).all()))
        with torch.no_grad():
            first = model.sample_candidate_residual[0]
            last = model.sample_candidate_residual[-1]
            first.weight.zero_()
            first.bias.zero_()
            first.weight[0, 0] = 1.0
            last.weight.zero_()
            last.bias.zero_()
            last.weight[0, 0] = 1.0
        residual = model(queries, prototypes)["sample_candidate_residual"]
        self.assertFalse(bool(torch.equal(residual[0], residual[1])))

    def test_metrics_report_collapse_and_single_day_precision(self) -> None:
        scores = torch.tensor(
            [[2.0, 0.0], [2.0, 0.0], [2.0, 0.0], [0.0, 2.0]]
        )
        metrics = v8.compute_metrics(
            torch,
            {
                "body_candidate_scores": scores,
                "variant_candidate_scores": scores,
                "family_logits": torch.tensor(
                    [[-1.0, 1.0], [-1.0, 1.0], [-1.0, 1.0], [-1.0, 1.0]]
                ),
            },
            family_labels=torch.ones(4, dtype=torch.long),
            positive_mask=torch.tensor(
                [[True, False], [True, False], [False, True], [True, False]]
            ),
            preferred_mask=torch.tensor(
                [[True, False], [True, False], [False, True], [True, False]]
            ),
            font_supervision_weights=torch.ones(4),
            single_day_body_negative=torch.zeros(4, dtype=torch.bool),
            single_day_index=1,
            candidate_ids=("body-font", "single-day"),
        )
        self.assertEqual(1, metrics["single_day_predicted_count"])
        self.assertEqual(0.0, metrics["single_day_positive_precision"])
        self.assertEqual(0.75, metrics["top1_max_candidate_share"])
        self.assertEqual(
            {"body-font": 3, "single-day": 1},
            metrics["top1_candidate_distribution"],
        )

    def test_metrics_apply_production_single_day_eligibility(self) -> None:
        metrics = v8.compute_metrics(
            torch,
            {
                "body_candidate_scores": torch.tensor(
                    [[0.0, 3.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]
                ),
                "variant_candidate_scores": torch.tensor(
                    [[0.0, 0.0], [0.0, 3.0], [0.0, 0.5], [0.0, 1.0]]
                ),
                "family_logits": torch.tensor(
                    [[3.0, -3.0], [-0.4, 0.4], [-2.0, 2.0], [-2.0, 2.0]]
                ),
            },
            family_labels=torch.tensor(
                [
                    v8.BODY_FAMILY_INDEX,
                    v8.VARIANT_FAMILY_INDEX,
                    v8.VARIANT_FAMILY_INDEX,
                    v8.VARIANT_FAMILY_INDEX,
                ]
            ),
            positive_mask=torch.tensor(
                [[True, False], [True, False], [True, False], [False, True]]
            ),
            preferred_mask=torch.tensor(
                [[True, False], [True, False], [True, False], [False, True]]
            ),
            font_supervision_weights=torch.ones(4),
            single_day_body_negative=torch.tensor(
                [True, False, False, False]
            ),
            single_day_index=1,
            candidate_ids=("body-font", "single-day"),
        )

        self.assertEqual(
            "predicted_pixel_family_with_single_day_eligibility",
            metrics["routing_authority"],
        )
        self.assertEqual(4, metrics["single_day_eligibility"]["raw_top1_all_rows"])
        self.assertEqual(
            1, metrics["single_day_eligibility"]["variant_gate_allowed_rows"]
        )
        self.assertEqual(
            1, metrics["single_day_eligibility"]["eligible_top1_all_rows"]
        )
        self.assertEqual(0.25, metrics["single_day_eligibility"]["eligible_top1_all_rows_rate"])
        self.assertEqual(1, metrics["single_day_predicted_count"])
        self.assertEqual(1.0, metrics["single_day_positive_precision"])
        self.assertEqual(0, metrics["single_day_body_false_top1_count"])

    def test_single_day_body_hard_negative_has_gradient(self) -> None:
        body = torch.tensor([[0.0, 0.4]], requires_grad=True)
        variant = torch.zeros_like(body, requires_grad=True)
        family_logits = torch.tensor([[2.0, -2.0]], requires_grad=True)
        bias = torch.zeros((2, 2), requires_grad=True)
        total, parts = v8.role_family_training_loss(
            torch,
            {
                "body_candidate_scores": body,
                "variant_candidate_scores": variant,
                "family_logits": family_logits,
                "family_candidate_bias": bias,
            },
            family_labels=torch.tensor([v8.BODY_FAMILY_INDEX]),
            positive_mask=torch.tensor([[True, False]]),
            single_day_index=1,
        )
        total.backward()
        self.assertGreater(
            float(parts["single_day_body_hard_negative"].detach()), 0.0
        )
        self.assertGreater(float(body.grad[0, 1]), 0.0)

    def test_training_arrays_require_work_disjoint_split(self) -> None:
        arrays = {
            "candidate_eligible_mask": np.asarray(
                [[1, 1], [1, 1], [1, 1], [1, 1]], dtype=np.uint8
            ),
            "candidate_ids": np.asarray(["body", "single-day"]),
            "family_label_weights": np.ones(4, dtype=np.float32),
            "family_labels": np.asarray([0, 1, 0, 1], dtype=np.int64),
            "font_authority": np.asarray(
                ["human", "visual", "human", "visual"]
            ),
            "font_supervision_weights": np.ones(4, dtype=np.float32),
            "positive_mask": np.asarray(
                [[1, 0], [0, 1], [1, 0], [0, 1]], dtype=np.uint8
            ),
            "preferred_mask": np.asarray(
                [[1, 0], [0, 1], [1, 0], [0, 1]], dtype=np.uint8
            ),
            "prototype_queries": np.zeros(
                (2, v8.QUERY_COUNT, v8.QUERY_DIM), dtype=np.float32
            ),
            "query_views": np.zeros(
                (4, 3, v8.QUERY_COUNT, v8.QUERY_DIM), dtype=np.float32
            ),
            "sample_ids": np.asarray(["a", "b", "c", "d"]),
            "single_day_body_negative": np.asarray(
                [True, False, True, False], dtype=np.uint8
            ),
            "split": np.asarray([0, 0, 1, 1], dtype=np.int64),
            "work_ids": np.asarray(["train", "train", "val", "val"]),
        }
        inventory = v8.validate_training_arrays(arrays, candidate_count=2)
        self.assertEqual(2, inventory["train_rows"])
        arrays["preferred_mask"][0] = 0
        inventory = v8.validate_training_arrays(arrays, candidate_count=2)
        self.assertEqual(2, inventory["train_rows"])
        arrays["work_ids"][-1] = "train"
        with self.assertRaisesRegex(v8.MangaFontV8RoleFamilyError, "overlap"):
            v8.validate_training_arrays(arrays, candidate_count=2)

    def test_acceptable_only_font_row_skips_preferred_loss(self) -> None:
        body = torch.tensor([[1.0, 0.0]], requires_grad=True)
        variant = torch.zeros_like(body, requires_grad=True)
        total, parts = v8.role_family_training_loss(
            torch,
            {
                "body_candidate_scores": body,
                "variant_candidate_scores": variant,
                "family_logits": torch.tensor([[2.0, -2.0]], requires_grad=True),
                "family_candidate_bias": torch.zeros((2, 2), requires_grad=True),
            },
            family_labels=torch.tensor([v8.BODY_FAMILY_INDEX]),
            positive_mask=torch.tensor([[True, False]]),
            preferred_mask=torch.tensor([[False, False]]),
            candidate_eligible_mask=torch.tensor([[True, True]]),
            font_supervision_weights=torch.tensor([1.0]),
            single_day_body_negative=torch.tensor([False]),
            single_day_index=1,
        )
        total.backward()
        self.assertAlmostEqual(
            float(parts["candidate"].detach()),
            float(parts["candidate_acceptable"].detach()),
            6,
        )
        self.assertGreater(float(body.grad.abs().sum()), 0.0)

    def test_family_only_ordinary_row_can_train_single_day_negative(self) -> None:
        body = torch.tensor([[0.0, 0.4], [0.1, 0.2]], requires_grad=True)
        variant = torch.zeros_like(body, requires_grad=True)
        total, parts = v8.role_family_training_loss(
            torch,
            {
                "body_candidate_scores": body,
                "variant_candidate_scores": variant,
                "family_logits": torch.tensor(
                    [[2.0, -2.0], [2.0, -2.0]], requires_grad=True
                ),
                "family_candidate_bias": torch.zeros(
                    (2, 2), requires_grad=True
                ),
            },
            family_labels=torch.tensor([0, 0]),
            family_label_weights=torch.ones(2),
            font_supervision_weights=torch.tensor([1.0, 0.0]),
            candidate_eligible_mask=torch.tensor(
                [[True, True], [False, False]]
            ),
            positive_mask=torch.tensor([[True, False], [False, False]]),
            preferred_mask=torch.tensor([[True, False], [False, False]]),
            single_day_body_negative=torch.tensor([True, True]),
            single_day_index=1,
        )
        total.backward()
        self.assertGreater(
            float(parts["single_day_body_hard_negative"].detach()), 0.0
        )
        self.assertGreater(float(body.grad[1, 1]), 0.0)

    def test_single_day_supervised_negative_covers_both_score_branches(self) -> None:
        def parts(single_day_eligible: bool) -> dict[str, torch.Tensor]:
            scores = torch.tensor([[0.0, 0.6]], requires_grad=True)
            _total, result = v8.role_family_training_loss(
                torch,
                {
                    "body_candidate_scores": scores,
                    "variant_candidate_scores": scores,
                    "family_logits": torch.tensor([[2.0, -2.0]]),
                    "family_candidate_bias": torch.zeros((2, 2)),
                },
                family_labels=torch.tensor([v8.BODY_FAMILY_INDEX]),
                positive_mask=torch.tensor([[True, False]]),
                preferred_mask=torch.tensor([[True, False]]),
                candidate_eligible_mask=torch.tensor(
                    [[True, single_day_eligible]]
                ),
                font_supervision_weights=torch.tensor([1.0]),
                single_day_body_negative=torch.tensor([False]),
                single_day_index=1,
            )
            return result

        unshown = parts(False)
        self.assertEqual(
            1,
            int(unshown["single_day_supervised_hard_negative_rows"].item()),
        )
        self.assertGreater(
            float(unshown["single_day_supervised_hard_negative"].detach()), 0.0
        )
        reviewed = parts(True)
        self.assertEqual(
            1,
            int(reviewed["single_day_supervised_hard_negative_rows"].item()),
        )
        self.assertGreater(
            float(reviewed["single_day_supervised_hard_negative"].detach()), 0.0
        )

    def test_candidate_loss_ignores_unreviewed_candidates(self) -> None:
        scores = torch.tensor([[1.0, 0.0, 100.0]])
        loss = v8.multi_positive_candidate_loss(
            torch,
            scores,
            torch.tensor([[True, False, False]]),
            eligible_mask=torch.tensor([[True, True, False]]),
        )
        self.assertAlmostEqual(
            float(loss), float(torch.logsumexp(scores[:, :2], 1) - scores[:, 0]), 6
        )


if __name__ == "__main__":
    unittest.main()
