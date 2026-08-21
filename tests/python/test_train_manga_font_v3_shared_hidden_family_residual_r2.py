from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import numpy as np
import torch

from scripts import train_manga_font_student_v8_role_family_adapter as v8
from scripts import train_manga_font_v3_shared_hidden_family_residual_r2 as trainer


class TinyBoundedMarginModel(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.family_margin_head = torch.nn.Linear(1, 1)
        with torch.no_grad():
            self.family_margin_head.weight.fill_(0.2)
            self.family_margin_head.bias.fill_(-0.1)

    def residual_from_hidden(self, hidden: torch.Tensor) -> dict[str, torch.Tensor]:
        raw = self.family_margin_head(hidden.float()).squeeze(1)
        margin = torch.tanh(raw)
        return {
            "family_logit_adjustment": torch.stack(
                (margin * 0.5, margin * -0.5), dim=1
            ),
            "family_margin_delta": margin,
            "family_margin_raw": raw,
        }


class MangaFontV3SharedHiddenFamilyResidualR2Tests(unittest.TestCase):
    def args(self, **overrides: object) -> Namespace:
        args = trainer.build_parser().parse_args(["preflight"])
        for name, value in overrides.items():
            setattr(args, name, value)
        return args

    def anchor(self, candidate_count: int = 3) -> torch.nn.Module:
        torch.manual_seed(7)
        model = v8.build_role_family_adapter(
            torch,
            candidate_count=candidate_count,
            maximum_family_bias=0.1,
            candidate_residual_hidden_dim=trainer.r0.EXPECTED_HIDDEN_DIM,
            maximum_sample_residual=0.75,
        )
        with torch.no_grad():
            model.sample_candidate_residual[2].weight.normal_(0.0, 0.03)
            model.sample_candidate_residual[2].bias.normal_(0.0, 0.03)
        return model.eval()

    @staticmethod
    def direct_partition(row_count: int = 1042) -> dict[str, object]:
        indices = np.arange(row_count, dtype=np.int64)
        work_ids = np.asarray(
            [f"work-{index % 10:02d}" for index in indices], dtype=np.str_
        )
        labels = np.asarray([(index // 10) % 2 for index in indices], dtype=np.int64)
        weights = np.linspace(0.1, 1.0, row_count, dtype=np.float32)
        return {
            "base_indices": np.arange(row_count, row_count + 5, dtype=np.int64),
            "base_labels": np.concatenate((labels, np.asarray([0, 1, 0, 1, 0]))),
            "base_weights": np.concatenate((weights, np.ones(5, dtype=np.float32))),
            "contract": {
                "base_direct_intersection_rows": 0,
                "page_groups": 3,
            },
            "direct_indices": indices,
            "direct_labels": labels,
            "direct_weights": weights,
            "direct_work_ids": work_ids,
            "page_indices": np.asarray([0, 10, 20], dtype=np.int64),
            "page_work_ids": np.asarray(["work-00", "work-00", "work-00"]),
        }

    @staticmethod
    def phase_record(
        balanced: float,
        body: float,
        variant: float = 0.5,
        *,
        diagnostic_gate_passed: bool = True,
    ) -> dict[str, object]:
        return {
            "diagnostic_gate_passed": diagnostic_gate_passed,
            "training_only_selection_metrics": {
                "direct_family": {
                    "work_macro": {
                        "balanced_accuracy": balanced,
                        "body_accuracy": body,
                        "variant_accuracy": variant,
                    }
                }
            },
        }

    @staticmethod
    def base_metrics() -> dict[str, object]:
        section = {
            "acceptable_at1": 0.7,
            "family_accuracy": 0.9,
            "preferred_at1": 0.6,
            "single_day_body_false_top1_count": 0,
        }
        return {
            "all": dict(section),
            "quality_checks": {"synthetic": True},
            "quality_gate_passed": True,
            "visual": dict(section),
        }

    @staticmethod
    def training_metrics() -> dict[str, object]:
        return {
            "direct_family": {
                "row": {"balanced_accuracy": 0.5, "body_accuracy": 0.5},
                "work_macro": {
                    "balanced_accuracy": 0.5,
                    "body_accuracy": 0.5,
                    "per_work": {
                        "w1": {"balanced_accuracy": 0.5},
                        "w2": {"balanced_accuracy": 0.5},
                    },
                    "variant_accuracy": 0.5,
                },
            },
            "margin": {
                "mean_absolute_margin": 0.0,
                "saturation_rate_at_95pct_budget": 0.0,
            },
            "page_consistency": {
                "all_rows_top1_in_common_positive_rate": 0.5,
                "top1_all_agree_rate": 0.5,
            },
        }

    def test_all_head_architectures_have_deterministic_exact_anchor_initialization(
        self,
    ) -> None:
        generator = torch.Generator().manual_seed(17)
        hidden = torch.randn(9, trainer.r0.EXPECTED_HIDDEN_DIM, generator=generator)
        anchor_logits = torch.randn(9, 2, generator=generator)
        expected_counts = {
            "linear": trainer.r0.EXPECTED_HIDDEN_DIM + 1,
            **{f"mlp{width}": width * 66 + 1 for width in trainer.MLP_WIDTHS},
        }

        for architecture in trainer.HEAD_ARCHITECTURES:
            with self.subTest(architecture=architecture):
                first = trainer.build_r2_model(
                    torch,
                    anchor_model=self.anchor(),
                    maximum_margin=1.0,
                    head_architecture=architecture,
                )
                repeated = trainer.build_r2_model(
                    torch,
                    anchor_model=self.anchor(),
                    maximum_margin=1.0,
                    head_architecture=architecture,
                )
                first_state = trainer._sidecar_state(first, architecture)
                repeated_state = trainer._sidecar_state(repeated, architecture)
                self.assertEqual(
                    trainer._state_payload(first_state, architecture),
                    trainer._state_payload(repeated_state, architecture),
                )

                spec = trainer._sidecar_spec(architecture)
                self.assertEqual(set(spec), set(first_state))
                for name, (shape, dtype) in spec.items():
                    self.assertEqual(shape, tuple(first_state[name].shape), name)
                    self.assertEqual(dtype, str(first_state[name].numpy().dtype), name)

                residual = first.residual_from_hidden(hidden)
                self.assertEqual(
                    bytes(hidden.shape[0] * 4),
                    residual["family_margin_delta"].detach().numpy().tobytes(),
                )
                self.assertTrue(
                    torch.equal(
                        residual["family_logit_adjustment"],
                        torch.zeros_like(residual["family_logit_adjustment"]),
                    )
                )
                trainer._assert_zero_output_anchor(
                    torch,
                    first,
                    {
                        "body_candidate_scores": torch.zeros(9, 3),
                        "candidate_scores": torch.zeros(9, 3),
                        "family_logits": anchor_logits,
                        "hidden": hidden,
                        "variant_candidate_scores": torch.zeros(9, 3),
                    },
                )

                contract = trainer._architecture_contract(
                    first,
                    head_architecture=architecture,
                    maximum_margin=1.0,
                )
                self.assertEqual(
                    expected_counts[architecture], contract["sidecar_parameter_count"]
                )
                self.assertEqual(len(spec), contract["sidecar_tensor_count"])
                self.assertTrue(contract["zero_output_initialization_exact_anchor"])
                self.assertTrue(
                    contract[
                        "cpu_single_thread_full_runtime_benchmark_required_before_promotion"
                    ]
                )
                self.assertFalse(contract["cpu_benchmark_completed"])
                self.assertEqual(
                    1.5, contract["cpu_single_thread_full_runtime_relative_budget"]
                )
                self.assertTrue(
                    contract["initial_state"]["final_projection_exact_zero"]
                )
                self.assertFalse(
                    any(
                        parameter.requires_grad
                        for parameter in first.anchor_model.parameters()
                    )
                )

                if architecture == "linear":
                    self.assertIsNone(contract["head_hidden_width"])
                    self.assertTrue(
                        torch.count_nonzero(first.family_margin_head.weight) == 0
                    )
                else:
                    width = int(architecture.removeprefix("mlp"))
                    self.assertEqual(width, contract["head_hidden_width"])
                    self.assertGreater(
                        int(torch.count_nonzero(first.family_margin_head[0].weight)), 0
                    )
                    self.assertEqual(
                        first.family_margin_head[0].weight.detach().numpy().tobytes(),
                        repeated.family_margin_head[0]
                        .weight.detach()
                        .numpy()
                        .tobytes(),
                    )
                    self.assertTrue(
                        torch.count_nonzero(first.family_margin_head[0].bias) == 0
                    )
                    self.assertTrue(
                        torch.count_nonzero(first.family_margin_head[2].weight) == 0
                    )
                    self.assertTrue(
                        torch.count_nonzero(first.family_margin_head[2].bias) == 0
                    )

    def test_margin_is_bounded_and_family_adjustment_is_zero_sum(self) -> None:
        hidden = torch.randn(7, trainer.r0.EXPECTED_HIDDEN_DIM)
        for architecture in trainer.HEAD_ARCHITECTURES:
            with self.subTest(architecture=architecture):
                model = trainer.build_r2_model(
                    torch,
                    anchor_model=self.anchor(),
                    maximum_margin=1.0,
                    head_architecture=architecture,
                )
                with torch.no_grad():
                    if architecture == "linear":
                        model.family_margin_head.bias.fill_(100.0)
                    else:
                        model.family_margin_head[2].bias.fill_(100.0)
                residual = model.residual_from_hidden(hidden)
                margin = residual["family_margin_delta"]
                adjustment = residual["family_logit_adjustment"]
                self.assertTrue(torch.all(margin <= 1.0))
                self.assertTrue(torch.all(margin >= -1.0))
                self.assertGreater(float(margin.detach().min()), 0.999)
                self.assertTrue(
                    torch.equal(adjustment.sum(dim=1), torch.zeros_like(margin))
                )

    def test_sidecar_payload_round_trip_preserves_each_architecture_byte_exactly(
        self,
    ) -> None:
        for architecture in trainer.HEAD_ARCHITECTURES:
            with self.subTest(architecture=architecture):
                model = trainer.build_r2_model(
                    torch,
                    anchor_model=self.anchor(),
                    maximum_margin=1.0,
                    head_architecture=architecture,
                )
                state = trainer._sidecar_state(model, architecture)
                payload = trainer._state_payload(state, architecture)
                restored = trainer._state_from_payload(torch, payload, architecture)
                self.assertEqual(
                    payload, trainer._state_payload(restored, architecture)
                )
                self.assertEqual(
                    trainer._initial_state_contract(model, architecture)[
                        "deterministic_initial_state_sha256"
                    ],
                    trainer._payload_sha256(payload),
                )

    def test_direct_pass_one_is_factorial_invariant_unique_and_fixed_denominator(
        self,
    ) -> None:
        partition = self.direct_partition()
        one_pass_args = self.args(direct_passes=1)
        two_pass_args = self.args(direct_passes=2)
        one_batches, one_contract = trainer._direct_pass_batches(
            partition, one_pass_args, epoch=3, pass_index=1
        )
        two_batches, two_contract = trainer._direct_pass_batches(
            partition, two_pass_args, epoch=3, pass_index=1
        )
        self.assertEqual(one_contract, two_contract)
        self.assertEqual(20, one_contract["loss_denominator"])
        self.assertEqual(20, one_contract["stratum_count"])
        self.assertEqual(1042, one_contract["unique_rows"])
        self.assertEqual(1042, one_contract["effective_rows"])
        self.assertEqual(0, one_contract["oversampled_rows"])
        self.assertEqual(1, one_contract["optimizer_calls"])
        self.assertEqual(1042, sum(len(batch[0]) for batch in one_batches))

        one_order = np.concatenate([batch[0] for batch in one_batches])
        two_order = np.concatenate([batch[0] for batch in two_batches])
        self.assertEqual(list(range(1042)), sorted(one_order.tolist()))
        self.assertEqual(1042, len(set(one_order.tolist())))
        self.assertEqual(one_order.tobytes(), two_order.tobytes())
        for left, right in zip(one_batches, two_batches, strict=True):
            for left_array, right_array in zip(left, right, strict=True):
                self.assertEqual(left_array.tobytes(), right_array.tobytes())

        pass_two_batches, pass_two_contract = trainer._direct_pass_batches(
            partition, two_pass_args, epoch=3, pass_index=2
        )
        pass_two_order = np.concatenate([batch[0] for batch in pass_two_batches])
        self.assertEqual(list(range(1042)), sorted(pass_two_order.tolist()))
        self.assertNotEqual(
            one_contract["schedule_seed"], pass_two_contract["schedule_seed"]
        )
        self.assertNotEqual(one_order.tobytes(), pass_two_order.tobytes())

    def test_base_global_class_balance_binds_original_targets_and_weights(self) -> None:
        labels = np.asarray([0, 0, 0, 1, 1, 1], dtype=np.int64)
        weights = np.asarray([1, 2, 3, 4, 5, 6], dtype=np.float32)
        partition = {
            "base_indices": np.arange(6, dtype=np.int64),
            "base_labels": labels,
            "base_weights": weights,
        }
        class_weights, denominator, contract = trainer._base_class_balance(partition)
        weighted_counts = np.asarray([6.0, 15.0], dtype=np.float32)
        expected = np.sum(weighted_counts, dtype=np.float32) / weighted_counts
        expected /= np.mean(expected, dtype=np.float32)
        np.testing.assert_array_equal(expected, class_weights)
        self.assertEqual(21.0, denominator)
        self.assertEqual([6.0, 15.0], contract["weighted_family_counts"])
        self.assertEqual(6, contract["fixed_kl_denominator_rows"])
        self.assertEqual(6, contract["fixed_residual_l2_denominator_rows"])
        self.assertEqual(21.0, contract["fixed_family_ce_denominator"])
        self.assertEqual(
            "original_r3_non_direct_targets", contract["family_label_source"]
        )

        changed = copy.deepcopy(partition)
        changed["base_weights"][0] = np.float32(1.5)
        _changed_weights, _changed_denominator, changed_contract = (
            trainer._base_class_balance(changed)
        )
        self.assertNotEqual(
            contract["target_weight_inventory_sha256"],
            changed_contract["target_weight_inventory_sha256"],
        )

    def test_base_accumulation_matches_single_global_objective_and_steps_once(
        self,
    ) -> None:
        partition = {
            "base_indices": np.arange(6, dtype=np.int64),
            "base_labels": np.asarray([0, 1, 0, 1, 1, 0], dtype=np.int64),
            "base_weights": np.asarray(
                [0.5, 1.5, 0.75, 1.25, 0.6, 1.4], dtype=np.float32
            ),
        }
        cache = {
            "family_logits": torch.tensor(
                [
                    [0.2, -0.1],
                    [-0.4, 0.3],
                    [0.1, 0.5],
                    [0.0, -0.2],
                    [0.7, 0.1],
                    [-0.3, 0.2],
                ],
                dtype=torch.float32,
            ),
            "hidden": torch.tensor(
                [[-1.0], [-0.5], [0.0], [0.25], [0.75], [1.5]],
                dtype=torch.float32,
            ),
        }
        batches = (
            np.asarray([4, 1], dtype=np.int64),
            np.asarray([0, 5, 3], dtype=np.int64),
            np.asarray([2], dtype=np.int64),
        )
        ordered = np.concatenate(batches)
        class_weights, denominator, _contract = trainer._base_class_balance(partition)
        accumulated_model = TinyBoundedMarginModel()
        reference_model = TinyBoundedMarginModel()
        reference_model.load_state_dict(accumulated_model.state_dict())
        accumulated_optimizer = torch.optim.SGD(
            accumulated_model.family_margin_head.parameters(), lr=0.05
        )
        reference_optimizer = torch.optim.SGD(
            reference_model.family_margin_head.parameters(), lr=0.05
        )
        family_weight = 0.35
        kl_weight = 5.0
        l2_weight = 0.01

        with mock.patch.object(
            accumulated_optimizer, "step", wraps=accumulated_optimizer.step
        ) as optimizer_step:
            actual_losses = trainer._base_accumulated_optimization_step(
                torch,
                accumulated_model,
                accumulated_optimizer,
                cache=cache,
                partition=partition,
                batches=batches,
                class_weights=class_weights,
                source_weight_denominator=denominator,
                family_ce_weight=family_weight,
                anchor_kl_weight=kl_weight,
                residual_l2_weight=l2_weight,
                gradient_clip=10.0,
            )
        optimizer_step.assert_called_once_with()

        reference_optimizer.zero_grad(set_to_none=True)
        outputs = trainer.r0._head_outputs_for_indices(
            torch, reference_model, cache, ordered
        )
        labels = torch.from_numpy(partition["base_labels"][ordered])
        source_weights = torch.from_numpy(partition["base_weights"][ordered])
        per_row_ce = torch.nn.functional.cross_entropy(
            outputs["family_logits"],
            labels,
            weight=torch.from_numpy(class_weights),
            reduction="none",
        )
        family_ce = (per_row_ce * source_weights).sum() / denominator
        anchor_probability = torch.softmax(outputs["anchor_family_logits"], dim=1)
        anchor_kl = (
            anchor_probability
            * (
                torch.log_softmax(outputs["anchor_family_logits"], dim=1)
                - torch.log_softmax(outputs["family_logits"], dim=1)
            )
        ).sum() / len(ordered)
        residual_l2 = outputs["family_margin_delta"].square().sum() / len(ordered)
        total = (
            family_weight * family_ce + kl_weight * anchor_kl + l2_weight * residual_l2
        )
        total.backward()
        torch.nn.utils.clip_grad_norm_(
            tuple(reference_model.family_margin_head.parameters()), 10.0
        )
        reference_optimizer.step()

        expected_losses = {
            "anchor_kl": float(anchor_kl.detach()),
            "family_ce": float(family_ce.detach()),
            "residual_l2": float(residual_l2.detach()),
            "total": float(total.detach()),
        }
        for name, expected in expected_losses.items():
            self.assertAlmostEqual(expected, actual_losses[name], places=6, msg=name)
        for actual, expected in zip(
            accumulated_model.family_margin_head.parameters(),
            reference_model.family_margin_head.parameters(),
            strict=True,
        ):
            torch.testing.assert_close(actual, expected, rtol=1e-6, atol=1e-7)

    def test_epoch_consumption_has_no_page_phase_and_base_is_strictly_last(
        self,
    ) -> None:
        partition = self.direct_partition(row_count=20)
        args = self.args(direct_passes=2)
        with mock.patch.object(
            trainer.r0,
            "_work_balanced_batches",
            side_effect=AssertionError("page scheduling is forbidden in R2"),
        ):
            post_direct = trainer._epoch_consumption(
                partition,
                args,
                epoch=1,
                boundary="after_direct_family",
                completed_direct_passes=1,
            )
            post_base = trainer._epoch_consumption(
                partition,
                args,
                epoch=1,
                boundary="after_base_preservation",
            )

        self.assertEqual(1, post_direct["direct_optimizer_calls"])
        self.assertEqual(0, post_direct["base_optimizer_calls"])
        self.assertEqual(
            ["direct_family_pass_1"], post_direct["optimizer_phase_order_completed"]
        )
        self.assertEqual(2, post_base["direct_optimizer_calls"])
        self.assertEqual(1, post_base["base_optimizer_calls"])
        self.assertEqual(
            ["direct_family_pass_1", "direct_family_pass_2", "base_preservation"],
            post_base["optimizer_phase_order_completed"],
        )
        self.assertEqual(len(partition["base_indices"]), post_base["base_rows"])
        self.assertEqual(
            len(partition["base_indices"]), post_base["anchor_kl_base_rows"]
        )
        self.assertEqual(1, post_base["base_schedule"]["optimizer_calls"])
        for consumption in (post_direct, post_base):
            self.assertEqual(0, consumption["page_batches"])
            self.assertEqual(0, consumption["page_rows"])
            self.assertEqual(0, consumption["page_optimizer_calls"])
            self.assertIsNone(consumption["page_schedule"])

        objective = trainer._objective_contract(args, partition)
        self.assertTrue(objective["base_phase_is_last"])
        self.assertEqual(0, objective["page_optimizer_calls_per_epoch"])
        self.assertEqual(
            ["direct_family_pass_1", "direct_family_pass_2", "base_preservation"],
            objective["optimizer_phase_order"],
        )

    def test_phase_comparison_classifies_retention_erosion_and_no_direct_gate(
        self,
    ) -> None:
        anchor = self.phase_record(0.5, 0.5)
        direct_gate = self.phase_record(0.53, 0.54, 0.49)
        retained = trainer._phase_comparison(
            epoch=1,
            anchor_record=anchor,
            post_direct=direct_gate,
            post_base=self.phase_record(0.525, 0.53, 0.495),
            minimum_improvement=0.02,
        )
        destroyed = trainer._phase_comparison(
            epoch=2,
            anchor_record=anchor,
            post_direct=direct_gate,
            post_base=self.phase_record(0.49, 0.49, 0.5, diagnostic_gate_passed=False),
            minimum_improvement=0.02,
        )
        incapable = trainer._phase_comparison(
            epoch=3,
            anchor_record=anchor,
            post_direct=self.phase_record(0.519, 0.54, diagnostic_gate_passed=False),
            post_base=self.phase_record(0.53, 0.54),
            minimum_improvement=0.02,
        )
        self.assertEqual(
            "full_hard_gate_capable_and_retained", retained["classification"]
        )
        self.assertEqual(
            "full_hard_gate_capable_then_gate_destroyed",
            destroyed["classification"],
        )
        self.assertTrue(destroyed["body_balanced_target_fully_erased"])
        self.assertEqual(
            "not_full_hard_gate_capable_post_direct_at_this_epoch",
            incapable["classification"],
        )
        target_only = trainer._phase_comparison(
            epoch=4,
            anchor_record=anchor,
            post_direct=self.phase_record(
                0.53, 0.54, 0.0, diagnostic_gate_passed=False
            ),
            post_base=self.phase_record(0.53, 0.54),
            minimum_improvement=0.02,
        )
        self.assertEqual(
            "not_full_hard_gate_capable_post_direct_at_this_epoch",
            target_only["classification"],
        )
        self.assertEqual(
            "body_balanced_target_capable_and_retained",
            target_only["body_balanced_target_classification"],
        )
        self.assertAlmostEqual(
            0.025 / 0.03, retained["retention_ratio"]["balanced_accuracy"]
        )

    def test_post_direct_snapshot_is_diagnostic_only_and_never_selectable(self) -> None:
        model = trainer.build_r2_model(
            torch,
            anchor_model=self.anchor(),
            maximum_margin=1.0,
            head_architecture="linear",
        )
        metrics = self.phase_record(0.53, 0.54)["training_only_selection_metrics"]
        args = self.args(head_architecture="linear")
        common = {
            "cache": {},
            "context": {"arrays": {}, "groups": {}},
            "partition": {"all_base_indices": np.asarray([0], dtype=np.int64)},
            "candidate_ids": ("a", "b", "single-day"),
            "anchor_base_metrics": {},
            "anchor_train_metrics": metrics,
            "args": args,
            "losses": None,
            "batch_consumption": trainer._zero_consumption(),
        }
        with (
            mock.patch.object(
                trainer.r0, "_evaluate_base_from_cache", return_value={"base": True}
            ),
            mock.patch.object(
                trainer.r0.page_v3,
                "base_regression_checks",
                return_value={"no_regression": True},
            ),
            mock.patch.object(trainer.r0, "_training_metrics", return_value=metrics),
            mock.patch.object(
                trainer, "_diagnostic_checks", return_value={"gate": True}
            ),
            mock.patch.object(
                trainer.r1,
                "_subgroup_margin_flip_diagnostics",
                return_value={"synthetic": True},
            ),
        ):
            post_direct = trainer._snapshot_record(
                torch,
                model,
                epoch=1,
                phase_boundary="after_direct_family_pass_1",
                selectable=False,
                **common,
            )
            post_base = trainer._snapshot_record(
                torch,
                model,
                epoch=1,
                phase_boundary="after_base_preservation",
                selectable=True,
                **common,
            )

        self.assertTrue(post_direct["diagnostic_gate_passed"])
        self.assertFalse(post_direct["diagnostic_worth_passed"])
        self.assertFalse(post_direct["selectable_for_checkpoint"])
        self.assertEqual([], post_direct["checkpoint_selection_inputs"])
        self.assertTrue(post_base["diagnostic_worth_passed"])
        self.assertTrue(post_base["selectable_for_checkpoint"])
        self.assertEqual(
            list(trainer.CHECKPOINT_SELECTION_INPUTS),
            post_base["checkpoint_selection_inputs"],
        )

        selection = trainer._selection_contract(
            selected_epoch=0,
            partition=self.direct_partition(row_count=20),
            args=self.args(direct_passes=2),
        )
        self.assertFalse(selection["post_direct_states_selectable"])
        self.assertEqual(
            "after_base_preservation_only", selection["selectable_state_boundary"]
        )
        self.assertEqual(16, selection["post_direct_diagnostic_records"])
        self.assertEqual(8, selection["post_base_selectable_records"])

    def test_options_enforce_factorial_enums_and_every_precommitted_value(self) -> None:
        for architecture in trainer.HEAD_ARCHITECTURES:
            for direct_passes in trainer.DIRECT_PASS_CHOICES:
                with self.subTest(
                    valid_architecture=architecture, direct_passes=direct_passes
                ):
                    trainer._validate_options(
                        self.args(
                            head_architecture=architecture,
                            direct_passes=direct_passes,
                        )
                    )

        invalid = (
            ({"head_architecture": "mlp7"}, "head architecture"),
            ({"direct_passes": 0}, "direct passes"),
            ({"direct_passes": 3}, "direct passes"),
            ({"direct_passes": True}, "direct passes"),
            ({"base_supervision_mode": "overridden_all"}, "non_direct"),
            ({"direct_balance_mode": "work"}, "work_family"),
            ({"page_body_ce_weight": 0.1}, "page gradients"),
            ({"maximum_margin": 0.5}, "maximum_margin"),
        )
        for overrides, error in invalid:
            with (
                self.subTest(invalid=overrides),
                self.assertRaisesRegex(trainer.R2TrainingError, error),
            ):
                trainer._validate_options(self.args(**overrides))

        for option, expected in trainer.PRECOMMITTED_CONFIGURATION.items():
            changed: object
            if isinstance(expected, int):
                changed = expected + 1
            else:
                changed = expected + 0.125
            with (
                self.subTest(precommitted_option=option),
                self.assertRaises(trainer.R2TrainingError),
            ):
                trainer._validate_options(self.args(**{option: changed}))

        experiment = trainer._experiment_contract()
        self.assertEqual(
            {"direct_passes": [1, 2], "head_architectures": ["linear", "mlp8"]},
            experiment["initial_crude_grid"],
        )
        self.assertEqual(
            ["mlp16", "mlp32", "mlp64"],
            experiment["larger_widths_are_staged_not_precommitted_winners"],
        )
        self.assertFalse(experiment["promotion_authority"])
        self.assertFalse(experiment["page_replay_performed"])
        self.assertTrue(experiment["cpu_benchmark"]["required_before_any_promotion"])
        self.assertFalse(experiment["cpu_benchmark"]["completed"])

    def test_synthetic_mlp_two_pass_train_strictly_validates_and_rejects_tamper(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base_path = root / "base.npz"
            source_path = root / "head.safetensors"
            anchor_dir = root / "anchor"
            overlay_dir = root / "overlay"
            output = root / "output"
            base_path.write_bytes(b"synthetic-r2-base")
            source_path.write_bytes(b"synthetic-r2-head")
            anchor_dir.mkdir()
            overlay_dir.mkdir()

            direct_train = [
                {
                    "family_label": family,
                    "row_index": index,
                    "sample_id": f"s{index}",
                    "supervision_weight": 1.0,
                    "work_id": work_id,
                }
                for index, family, work_id in (
                    (0, 0, "w1"),
                    (1, 1, "w1"),
                    (2, 0, "w2"),
                    (3, 1, "w2"),
                )
            ]
            groups = {
                "development_eval": [
                    {
                        "group_id": "dev-page",
                        "row_indices": np.asarray([4, 5], dtype=np.int64),
                        "row_weights": np.ones(2, dtype=np.float32),
                        "work_id": "dev",
                    }
                ],
                "direct_family": {
                    "development_eval": [
                        {
                            "family_label": 0,
                            "row_index": 4,
                            "sample_id": "s4",
                            "supervision_weight": 1.0,
                            "work_id": "dev",
                        }
                    ],
                    "train": direct_train,
                },
                "train": [
                    {
                        "group_id": "train-page",
                        "row_indices": np.asarray([0, 2], dtype=np.int64),
                        "row_weights": np.ones(2, dtype=np.float32),
                        "work_id": "w1",
                    }
                ],
            }
            arrays = {
                "family_label_weights": np.ones(6, dtype=np.float32),
                "family_labels": np.asarray([0, 1, 0, 1, 0, 1], dtype=np.int64),
                "sample_ids": np.asarray([f"s{index}" for index in range(6)]),
                "split": np.asarray([0, 0, 0, 0, 1, 1], dtype=np.int64),
                "work_ids": np.asarray(["w1", "w1", "w2", "w2", "dev", "dev"]),
            }
            context = {
                "architecture": {
                    "candidate_residual_hidden_dim": trainer.r0.EXPECTED_HIDDEN_DIM
                },
                "arrays": arrays,
                "candidate_ids": ("a", "b", "single-day"),
                "dataset_path": base_path.resolve(),
                "groups": groups,
                "initialization": {"synthetic": True},
                "inventory": {"row_count": 6, "synthetic": True},
                "model": self.anchor(),
                "overlay_binding": {
                    "development_eval_work_ids": ["dev"],
                    "synthetic": True,
                },
                "source_head": source_path.resolve(),
            }
            cache = {
                "body_candidate_scores": torch.zeros(6, 3),
                "candidate_scores": torch.zeros(6, 3),
                "family_logits": torch.zeros(6, 2),
                "hidden": torch.arange(
                    6 * trainer.r0.EXPECTED_HIDDEN_DIM, dtype=torch.float32
                ).reshape(6, trainer.r0.EXPECTED_HIDDEN_DIM)
                / 100.0,
                "variant_candidate_scores": torch.zeros(6, 3),
            }
            partition = {
                "all_base_indices": np.arange(6, dtype=np.int64),
                "base_indices": np.asarray([4, 5], dtype=np.int64),
                "base_labels": arrays["family_labels"],
                "base_weights": arrays["family_label_weights"],
                "contract": {
                    "all_base_train_rows": 6,
                    "base_direct_intersection_rows": 0,
                    "base_rows": 2,
                    "base_supervision_mode": "non_direct_preservation",
                    "development_eval_gradient_rows": 0,
                    "development_gradient_row_intersection": 0,
                    "direct_rows": 4,
                    "page_groups": 1,
                    "page_rows": 2,
                    "synthetic_partition_sha256": hashlib.sha256(
                        b"synthetic-r2-partition"
                    ).hexdigest(),
                },
                "direct_indices": np.asarray([0, 1, 2, 3], dtype=np.int64),
                "direct_labels": np.asarray([0, 1, 0, 1], dtype=np.int64),
                "direct_weights": np.ones(4, dtype=np.float32),
                "direct_work_ids": np.asarray(["w1", "w1", "w2", "w2"]),
                "family_override": {"schema_version": "synthetic-r2-override"},
                "non_direct_indices": np.asarray([4, 5], dtype=np.int64),
                "page_indices": np.asarray([0, 2], dtype=np.int64),
                "page_labels": np.asarray([0, 0], dtype=np.int64),
                "page_weights": np.ones(2, dtype=np.float32),
                "page_work_ids": np.asarray(["w1", "w2"]),
            }
            metrics = self.training_metrics()
            base_metrics = self.base_metrics()
            direct_metrics = metrics["direct_family"]
            page_metrics = metrics["page_consistency"]
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
                    "--head-architecture",
                    "mlp8",
                    "--direct-passes",
                    "2",
                ]
            )

            with (
                mock.patch.object(trainer, "_load_context", return_value=context),
                mock.patch.object(trainer, "_build_partition", return_value=partition),
                mock.patch.object(
                    trainer.r0, "_build_frozen_cache", return_value=cache
                ),
                mock.patch.object(
                    trainer.r0,
                    "_evaluate_base_from_cache",
                    return_value=base_metrics,
                ),
                mock.patch.object(
                    trainer.r0, "_training_metrics", return_value=metrics
                ),
                mock.patch.object(
                    trainer.r0, "_direct_family_metrics", return_value=direct_metrics
                ),
                mock.patch.object(
                    trainer.r0, "_overlay_metrics", return_value=page_metrics
                ),
                mock.patch.object(
                    trainer.r1,
                    "_subgroup_margin_flip_diagnostics",
                    return_value=subgroup,
                ),
                mock.patch.object(
                    trainer.r0,
                    "_work_balanced_batches",
                    side_effect=AssertionError("page scheduler must remain unused"),
                ),
                mock.patch.object(
                    trainer,
                    "_direct_accumulated_optimization_step",
                    wraps=trainer._direct_accumulated_optimization_step,
                ) as direct_step,
                mock.patch.object(
                    trainer,
                    "_base_accumulated_optimization_step",
                    wraps=trainer._base_accumulated_optimization_step,
                ) as base_step,
            ):
                result = trainer.train(args)
                self.assertEqual(0, result["best_epoch"])
                self.assertEqual("mlp8", result["head_architecture"])
                self.assertFalse(result["diagnostic_worth"])
                self.assertFalse(result["trajectory_replay_authority"])
                self.assertEqual(16, direct_step.call_count)
                self.assertEqual(8, base_step.call_count)

                manifest_path = output / trainer.MANIFEST_FILE
                marker_path = output / trainer.MARKER_FILE
                sidecar_path = output / trainer.SIDECAR_FILE
                original_manifest = manifest_path.read_bytes()
                original_marker = marker_path.read_bytes()
                manifest = json.loads(original_manifest.decode("utf-8"))
                self.assertEqual(25, len(manifest["history"]))
                self.assertEqual(8, len(manifest["phase_diagnostics"]))
                self.assertEqual(
                    16,
                    manifest["selection"]["post_direct_diagnostic_records"],
                )
                self.assertEqual(
                    8, manifest["selection"]["post_base_selectable_records"]
                )
                self.assertFalse(manifest["selection"]["post_direct_states_selectable"])
                self.assertTrue(manifest["selection"]["anchor_fallback_selected"])
                for epoch in range(1, 9):
                    offset = 1 + (epoch - 1) * 3
                    pass_one, pass_two, post_base = manifest["history"][
                        offset : offset + 3
                    ]
                    self.assertEqual(
                        "after_direct_family_pass_1", pass_one["phase_boundary"]
                    )
                    self.assertEqual(
                        "after_direct_family_pass_2", pass_two["phase_boundary"]
                    )
                    self.assertEqual(
                        "after_base_preservation", post_base["phase_boundary"]
                    )
                    self.assertFalse(pass_one["selectable_for_checkpoint"])
                    self.assertFalse(pass_two["selectable_for_checkpoint"])
                    self.assertTrue(post_base["selectable_for_checkpoint"])
                    self.assertIsNone(pass_two["phase_losses"]["base_preservation"])
                    self.assertIsNone(post_base["phase_losses"]["page_body"])
                    self.assertEqual(
                        [
                            "direct_family_pass_1",
                            "direct_family_pass_2",
                            "base_preservation",
                        ],
                        post_base["batch_consumption"][
                            "optimizer_phase_order_completed"
                        ],
                    )

                def write_resealed(mutator: object) -> None:
                    record = json.loads(original_manifest.decode("utf-8"))
                    mutator(record)  # type: ignore[operator]
                    manifest_path.write_bytes(
                        trainer.json_bytes(trainer.seal_record(record), pretty=True)
                    )
                    marker = json.loads(original_marker.decode("utf-8"))
                    marker["artifacts"] = {
                        trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path),
                        trainer.SIDECAR_FILE: trainer.sha256_file(sidecar_path),
                    }
                    marker_path.write_bytes(
                        trainer.json_bytes(trainer.seal_record(marker), pretty=True)
                    )

                def tamper_epoch_zero_mlp_state(record: dict[str, object]) -> None:
                    epoch_zero = record["history"][0]  # type: ignore[index]
                    tensor = epoch_zero["sidecar_state"][  # type: ignore[index]
                        "family_margin_head.0.weight"
                    ]
                    encoded = tensor["data_hex_little_endian_float32"]
                    replacement = "00" if encoded[:2] != "00" else "01"
                    tensor["data_hex_little_endian_float32"] = replacement + encoded[2:]
                    epoch_zero["sidecar_state_sha256"] = trainer._payload_sha256(
                        epoch_zero["sidecar_state"]
                    )

                tampers = (
                    (
                        "post-direct selection",
                        lambda record: record["history"][1].__setitem__(
                            "selectable_for_checkpoint", True
                        ),
                        "boundary drifted",
                    ),
                    (
                        "base not last",
                        lambda record: record["history"][3][
                            "batch_consumption"
                        ].__setitem__(
                            "optimizer_phase_order_completed",
                            ["base_preservation", "direct_family_pass_2"],
                        ),
                        "boundary drifted",
                    ),
                    (
                        "page loss",
                        lambda record: record["history"][3]["phase_losses"].__setitem__(
                            "page_body",
                            record["history"][3]["phase_losses"]["base_preservation"],
                        ),
                        "page loss",
                    ),
                    (
                        "epoch-zero MLP initializer",
                        tamper_epoch_zero_mlp_state,
                        "deterministic initializer",
                    ),
                    (
                        "phase classification",
                        lambda record: record["phase_diagnostics"][0].__setitem__(
                            "classification", "gate_capable_and_retained"
                        ),
                        "phase diagnostics",
                    ),
                    (
                        "direct loss algebra",
                        lambda record: record["history"][1]["phase_losses"][
                            "direct_family_passes"
                        ][0].__setitem__("total", 999.0),
                        "weighted total algebra",
                    ),
                    (
                        "CPU benchmark claim",
                        lambda record: record["architecture"].__setitem__(
                            "cpu_benchmark_completed", True
                        ),
                        "architecture drifted",
                    ),
                )
                for name, mutator, error in tampers:
                    with self.subTest(tamper=name):
                        write_resealed(mutator)
                        with self.assertRaisesRegex(trainer.R2TrainingError, error):
                            trainer.validate_output(output)

                manifest_path.write_bytes(original_manifest)
                marker_path.write_bytes(original_marker)
                validated = trainer.validate_output(output)
                self.assertEqual(0, validated["best_epoch"])
                self.assertEqual("mlp8", validated["head_architecture"])
                self.assertFalse(validated["trajectory_replay_authority"])

    def test_validator_rejects_link_or_reparse_before_artifact_read(self) -> None:
        with (
            mock.patch.object(
                trainer.r0.overlay_v3,
                "_path_or_ancestor_is_link_or_reparse",
                return_value=True,
            ),
            self.assertRaisesRegex(trainer.R2TrainingError, "linked or reparsed"),
        ):
            trainer.validate_output(Path("synthetic-linked-r2-output"))


if __name__ == "__main__":
    unittest.main()
