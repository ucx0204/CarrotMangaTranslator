from __future__ import annotations

import copy
import hashlib
import json
import math
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import numpy as np
import torch

from scripts import train_manga_font_student_v8_role_family_adapter as v8
from scripts import train_manga_font_v3_shared_hidden_family_residual_r1 as trainer


class TinyMarginModel(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.family_margin_head = torch.nn.Linear(1, 1)
        torch.nn.init.zeros_(self.family_margin_head.weight)
        torch.nn.init.zeros_(self.family_margin_head.bias)

    def residual_from_hidden(self, hidden: torch.Tensor) -> dict[str, torch.Tensor]:
        margin = self.family_margin_head(hidden).squeeze(1)
        adjustment = torch.stack((margin / 2.0, -margin / 2.0), dim=1)
        return {
            "family_logit_adjustment": adjustment,
            "family_margin_delta": margin,
        }


class MangaFontV3SharedHiddenFamilyResidualR1Tests(unittest.TestCase):
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
    def training_metrics(
        *,
        balanced: float = 0.5,
        body: float = 0.5,
        variant: float = 0.5,
        per_work: dict[str, float] | None = None,
        page_common: float = 0.5,
        page_agree: float = 0.5,
        row_balanced: float | None = None,
        row_body: float | None = None,
        mean_margin: float = 0.0,
        saturation: float = 0.0,
    ) -> dict[str, object]:
        work_values = per_work or {"work": balanced}
        row = {
            "balanced_accuracy": balanced if row_balanced is None else row_balanced,
            "body_accuracy": body if row_body is None else row_body,
        }
        work = {
            "balanced_accuracy": balanced,
            "body_accuracy": body,
            "per_work": {
                name: {"balanced_accuracy": score}
                for name, score in work_values.items()
            },
            "variant_accuracy": variant,
        }
        return {
            "direct_family": {"row": row, "work_macro": work},
            "margin": {
                "mean_absolute_margin": mean_margin,
                "saturation_rate_at_95pct_budget": saturation,
            },
            "page_consistency": {
                "all_rows_top1_in_common_positive_rate": page_common,
                "top1_all_agree_rate": page_agree,
            },
        }

    @staticmethod
    def schedule_inventory() -> tuple[np.ndarray, ...]:
        rows = np.asarray([101, 102, 103, 201, 202, 301, 302, 303, 304], dtype=np.int64)
        works = np.asarray(["a", "a", "a", "b", "b", "c", "c", "c", "c"])
        families = np.asarray([0, 0, 1, 0, 1, 0, 0, 1, 1], dtype=np.int64)
        weights = np.asarray(
            [0.11, 0.37, 0.52, 0.31, 0.69, 0.13, 0.41, 0.19, 0.27],
            dtype=np.float32,
        )
        return rows, works, families, weights

    def schedule(
        self, mode: str, *, weights: np.ndarray | None = None
    ) -> tuple[object, np.ndarray, object]:
        rows, works, families, source_weights = self.schedule_inventory()
        return trainer._direct_balanced_schedule(
            rows,
            works,
            families,
            source_weights if weights is None else weights,
            balance_mode=mode,
            batch_size=6,
            seed=31,
        )

    def test_direct_modes_share_unique_order_batches_and_optimizer_count(self) -> None:
        work_batches, _work_weights, work_contract = self.schedule("work")
        family_batches, _family_weights, family_contract = self.schedule("work_family")
        self.assertEqual(len(work_batches), len(family_batches))
        for left, right in zip(work_batches, family_batches, strict=True):
            self.assertTrue(np.array_equal(left, right))
        order = np.concatenate(work_batches)
        self.assertEqual(list(range(9)), sorted(order.tolist()))
        self.assertEqual(9, len(set(order.tolist())))
        for contract in (work_contract, family_contract):
            self.assertEqual(9, contract["effective_rows"])
            self.assertEqual(9, contract["unique_rows"])
            self.assertEqual(0, contract["oversampled_rows"])
            self.assertEqual(1, contract["optimizer_calls"])
            self.assertEqual([6, 3], contract["batch_sizes"])
        self.assertEqual(3, work_contract["loss_denominator"])
        self.assertEqual(6, family_contract["loss_denominator"])
        self.assertEqual(31, work_contract["schedule_seed"])
        self.assertEqual(31, family_contract["schedule_seed"])
        self.assertEqual(
            "sealed_direct_family_label",
            work_contract["ordering_family_label_source"],
        )
        self.assertEqual(3.0, work_contract["scheduled_weight_sum_across_strata"])
        self.assertEqual(6.0, family_contract["scheduled_weight_sum_across_strata"])
        self.assertNotEqual(
            work_contract["row_weight_inventory_sha256"],
            family_contract["row_weight_inventory_sha256"],
        )

    def test_direct_weight_normalization_is_exact_per_selected_stratum(self) -> None:
        rows, works, families, _source = self.schedule_inventory()
        for mode in trainer.DIRECT_BALANCE_MODES:
            with self.subTest(mode=mode):
                _batches, weights, contract = self.schedule(mode)
                expected = (
                    [(work_id, None) for work_id in sorted(set(works.tolist()))]
                    if mode == "work"
                    else sorted(
                        set(zip(works.tolist(), families.tolist(), strict=True))
                    )
                )
                self.assertEqual(len(expected), contract["stratum_count"])
                for work_id, family in expected:
                    mask = works == work_id
                    if family is not None:
                        mask &= families == family
                    self.assertEqual(
                        np.float32(1.0), np.sum(weights[mask], dtype=np.float32)
                    )
                for descriptor in contract["strata"]:
                    mask = works == descriptor["work_id"]
                    if descriptor["family_label"] is not None:
                        mask &= families == descriptor["family_label"]
                    self.assertEqual(
                        int(np.max(rows[mask])),
                        descriptor["normalization_correction_base_row_index"],
                    )
                    self.assertEqual(1.0, descriptor["scheduled_weight_sum"])

    def test_direct_schedule_is_deterministic_and_source_weight_bound(self) -> None:
        batches, weights, contract = self.schedule("work_family")
        repeated_batches, repeated_weights, repeated_contract = self.schedule(
            "work_family"
        )
        self.assertEqual(contract, repeated_contract)
        self.assertEqual(weights.tobytes(), repeated_weights.tobytes())
        for left, right in zip(batches, repeated_batches, strict=True):
            self.assertEqual(left.tobytes(), right.tobytes())

        source = self.schedule_inventory()[3].copy()
        source[0] = np.float32(source[0] * 2.0)
        changed_batches, changed_weights, changed_contract = self.schedule(
            "work_family", weights=source
        )
        for left, right in zip(batches, changed_batches, strict=True):
            self.assertEqual(left.tobytes(), right.tobytes())
        self.assertNotEqual(weights.tobytes(), changed_weights.tobytes())
        self.assertNotEqual(
            contract["schedule_sha256"], changed_contract["schedule_sha256"]
        )
        self.assertNotEqual(contract["strata"], changed_contract["strata"])

    def test_direct_accumulation_uses_fixed_denominator_and_one_step(self) -> None:
        rows, works, families, source = self.schedule_inventory()
        cache_rows = int(np.max(rows)) + 1
        cache = {
            "family_logits": torch.zeros(cache_rows, 2),
            "hidden": torch.ones(cache_rows, 1),
        }
        for mode in trainer.DIRECT_BALANCE_MODES:
            with self.subTest(mode=mode):
                positions, normalized, contract = self.schedule(mode)
                batches = tuple(
                    (rows[batch], families[batch], normalized[batch])
                    for batch in positions
                )
                model = TinyMarginModel()
                optimizer = torch.optim.SGD(
                    model.family_margin_head.parameters(), lr=0.01
                )
                with mock.patch.object(
                    optimizer, "step", wraps=optimizer.step
                ) as optimizer_step:
                    losses = trainer._direct_accumulated_optimization_step(
                        torch,
                        model,
                        optimizer,
                        cache=cache,
                        batches=batches,
                        fixed_denominator=contract["loss_denominator"],
                        family_ce_weight=1.0,
                        residual_l2_weight=0.0,
                        gradient_clip=1.0,
                    )
                optimizer_step.assert_called_once_with()
                self.assertAlmostEqual(math.log(2.0), losses["family_ce"], places=6)
                self.assertEqual(0.0, losses["anchor_kl"])
                self.assertEqual(0.0, losses["residual_l2"])
                self.assertEqual(len(source), sum(len(batch[0]) for batch in batches))

    @staticmethod
    def partition_context() -> dict[str, object]:
        direct_train = [
            {
                "family_label": family,
                "row_index": index,
                "sample_id": f"s{index}",
                "supervision_weight": weight,
                "work_id": work,
            }
            for index, family, weight, work in (
                (1, 0, 0.7, "w1"),
                (2, 1, 0.3, "w1"),
                (4, 0, 0.6, "w2"),
                (5, 1, 0.4, "w2"),
            )
        ]
        return {
            "arrays": {
                "family_label_weights": np.asarray(
                    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
                    dtype=np.float32,
                ),
                "family_labels": np.asarray([0, 1, 0, 1, 1, 0, 1, 0]),
                "sample_ids": np.asarray([f"s{i}" for i in range(8)]),
                "split": np.zeros(8, dtype=np.int64),
                "work_ids": np.asarray(
                    ["w1", "w1", "w1", "w1", "w2", "w2", "w2", "w2"]
                ),
            },
            "groups": {
                "development_eval": [
                    {
                        "group_id": "dev-page",
                        "row_indices": np.asarray([81], dtype=np.int64),
                        "row_weights": np.asarray([1.0], dtype=np.float32),
                        "work_id": "dev",
                    }
                ],
                "direct_family": {
                    "development_eval": [
                        {
                            "family_label": 0,
                            "row_index": 80,
                            "sample_id": "dev-direct",
                            "supervision_weight": 1.0,
                            "work_id": "dev",
                        }
                    ],
                    "train": direct_train,
                },
                "train": [
                    {
                        "group_id": "p1",
                        "row_indices": np.asarray([1, 4], dtype=np.int64),
                        "row_weights": np.asarray([1.0, 0.8], dtype=np.float32),
                        "work_id": "w1",
                    }
                ],
            },
            "overlay_binding": {"development_eval_work_ids": ["dev"]},
        }

    def build_small_partition(self, mode: str) -> dict[str, object]:
        context = self.partition_context()
        arrays = context["arrays"]
        override_labels = np.asarray(arrays["family_labels"], dtype=np.int64).copy()
        override_labels[[1, 2, 4, 5]] = np.asarray([0, 1, 0, 1])
        override_weights = np.asarray(
            arrays["family_label_weights"], dtype=np.float32
        ).copy()
        override_weights[[1, 2, 4, 5]] = np.asarray(
            [0.7, 0.3, 0.6, 0.4], dtype=np.float32
        )
        with (
            mock.patch.object(
                trainer.r0,
                "_base_train_indices",
                return_value=np.arange(8, dtype=np.int64),
            ),
            mock.patch.object(
                trainer.r0.page_v3,
                "build_family_override_contract",
                return_value=(
                    override_labels,
                    override_weights,
                    {"sealed": "synthetic"},
                ),
            ),
        ):
            return dict(
                trainer._build_training_partition(
                    context,
                    self.args(base_supervision_mode=mode),
                    enforce_expected_counts=False,
                )
            )

    def test_partition_modes_bind_exact_rows_sources_and_hashes(self) -> None:
        overridden = self.build_small_partition("overridden_all")
        preserved = self.build_small_partition("non_direct_preservation")
        overridden_contract = overridden["contract"]
        preserved_contract = preserved["contract"]

        self.assertEqual(8, overridden_contract["all_base_train_rows"])
        self.assertEqual(4, overridden_contract["direct_rows"])
        self.assertEqual(4, overridden_contract["non_direct_base_rows"])
        self.assertEqual(8, overridden_contract["base_rows"])
        self.assertEqual(4, overridden_contract["base_direct_intersection_rows"])
        self.assertEqual(4, preserved_contract["base_rows"])
        self.assertEqual(0, preserved_contract["base_direct_intersection_rows"])
        self.assertEqual([0, 3, 6, 7], preserved["base_indices"].tolist())
        self.assertTrue(
            preserved_contract["all_base_union_is_exact_non_direct_plus_direct"]
        )
        self.assertEqual(
            "r3_targets_with_sealed_direct_train_override",
            overridden_contract["base_target_source"],
        )
        self.assertEqual(
            "original_r3_targets_and_weights_unmodified",
            preserved_contract["base_target_source"],
        )
        for key in (
            "all_base_train_index_sha256",
            "direct_index_sha256",
            "direct_inventory_sha256",
            "non_direct_base_index_sha256",
            "non_direct_base_inventory_sha256",
        ):
            self.assertEqual(overridden_contract[key], preserved_contract[key], key)
        self.assertNotEqual(
            overridden_contract["base_inventory_sha256"],
            preserved_contract["base_inventory_sha256"],
        )
        self.assertEqual(
            self.partition_context()["arrays"]["family_labels"].tolist(),
            preserved["base_labels"].tolist(),
        )
        self.assertEqual(
            self.partition_context()["arrays"]["family_label_weights"].tobytes(),
            preserved["base_weights"].tobytes(),
        )

    def test_partition_inventory_hash_changes_when_original_source_weight_changes(
        self,
    ) -> None:
        original = self.partition_context()
        changed = copy.deepcopy(original)
        changed["arrays"]["family_label_weights"][0] = np.float32(0.11)
        override_labels = np.asarray(original["arrays"]["family_labels"]).copy()
        override_weights = np.asarray(original["arrays"]["family_label_weights"]).copy()

        def build(context: dict[str, object]) -> dict[str, object]:
            with (
                mock.patch.object(
                    trainer.r0,
                    "_base_train_indices",
                    return_value=np.arange(8, dtype=np.int64),
                ),
                mock.patch.object(
                    trainer.r0.page_v3,
                    "build_family_override_contract",
                    return_value=(
                        override_labels,
                        override_weights,
                        {"sealed": "synthetic"},
                    ),
                ),
            ):
                return dict(
                    trainer._build_training_partition(
                        context,
                        self.args(base_supervision_mode="non_direct_preservation"),
                        enforce_expected_counts=False,
                    )
                )

        before = build(original)["contract"]
        after = build(changed)["contract"]
        self.assertNotEqual(
            before["non_direct_base_inventory_sha256"],
            after["non_direct_base_inventory_sha256"],
        )
        self.assertEqual(
            before["direct_inventory_sha256"], after["direct_inventory_sha256"]
        )

    @staticmethod
    def consumption_partition() -> dict[str, object]:
        return {
            "base_indices": np.asarray([6, 7, 8], dtype=np.int64),
            "contract": {
                "base_direct_intersection_rows": 0,
                "page_groups": 2,
            },
            "direct_indices": np.arange(6, dtype=np.int64),
            "direct_labels": np.asarray([0, 1, 0, 1, 0, 1], dtype=np.int64),
            "direct_weights": np.ones(6, dtype=np.float32),
            "direct_work_ids": np.asarray(["a", "a", "b", "b", "c", "c"]),
            "page_indices": np.asarray([0, 2], dtype=np.int64),
            "page_work_ids": np.asarray(["a", "b"]),
        }

    def test_page_zero_has_no_schedule_phase_rows_or_optimizer_calls(self) -> None:
        partition = self.consumption_partition()
        args = self.args(batch_size=6, page_body_ce_weight=0.0)
        with mock.patch.object(
            trainer.r0,
            "_work_balanced_batches",
            side_effect=AssertionError("page scheduler must not be constructed"),
        ):
            consumption = trainer._batch_consumption(partition, args, epoch=1)
        self.assertIsNone(consumption["page_schedule"])
        self.assertEqual(0, consumption["page_batches"])
        self.assertEqual(0, consumption["page_rows"])
        self.assertEqual(0, consumption["page_optimizer_calls"])
        self.assertEqual(
            ["direct_family", "base_preservation"],
            consumption["optimizer_phase_order"],
        )
        self.assertEqual(1, consumption["direct_optimizer_calls"])
        self.assertEqual(
            "deterministic_unique_shuffle_v1",
            consumption["base_schedule"]["algorithm"],
        )
        self.assertEqual(3, consumption["base_schedule"]["unique_rows"])
        self.assertEqual(
            64,
            len(consumption["base_schedule"]["ordered_base_row_index_sha256"]),
        )
        self.assertEqual(
            "after_base_preservation_only",
            consumption["selectable_state_boundary"],
        )
        objective = trainer._objective_contract(args, partition)
        self.assertFalse(objective["page_optimizer_steps_enabled"])
        self.assertEqual(0.0, objective["direct_anchor_kl_weight"])
        self.assertEqual(0.0, objective["page_anchor_kl_weight"])
        self.assertEqual("base_only", objective["anchor_kl_scope"])
        self.assertEqual(
            "metric_only_no_optimizer_step", objective["page_zero_weight_behavior"]
        )

    def test_epoch_zero_consumes_no_gradient_source(self) -> None:
        zero = trainer._zero_consumption(self.consumption_partition())
        for name in (
            "anchor_kl_base_rows",
            "anchor_kl_direct_rows",
            "anchor_kl_page_rows",
            "base_optimizer_calls",
            "base_rows",
            "development_eval_rows",
            "direct_optimizer_calls",
            "direct_rows",
            "page_optimizer_calls",
            "page_rows",
        ):
            self.assertEqual(0, zero[name], name)
        self.assertIsNone(zero["direct_schedule"])
        self.assertIsNone(zero["page_schedule"])
        self.assertIsNone(zero["base_schedule"])
        self.assertEqual([], zero["optimizer_phase_order"])
        self.assertEqual("anchor_initialization", zero["selectable_state_boundary"])

    def test_hard_diagnostic_requires_macro_body_balanced_variant_and_worst_work(
        self,
    ) -> None:
        anchor = self.training_metrics(per_work={"a": 0.5, "b": 0.5})
        regression = {"gate": True}
        candidate = self.training_metrics(
            balanced=0.52,
            body=0.52,
            variant=0.495,
            per_work={"a": 0.57, "b": 0.45},
        )
        checks = trainer._diagnostic_checks(
            anchor_train=anchor,
            candidate_train=candidate,
            base_metrics=self.base_metrics(),
            base_regression=regression,
            minimum_improvement=0.02,
            candidate_outputs_exact=True,
        )
        self.assertTrue(all(checks.values()))

        too_bad = copy.deepcopy(candidate)
        too_bad["direct_family"]["work_macro"]["per_work"]["b"]["balanced_accuracy"] = (
            0.449
        )
        failed = trainer._diagnostic_checks(
            anchor_train=anchor,
            candidate_train=too_bad,
            base_metrics=self.base_metrics(),
            base_regression=regression,
            minimum_improvement=0.02,
            candidate_outputs_exact=True,
        )
        self.assertFalse(
            failed["worst_per_work_balanced_accuracy_delta_at_least_negative_0_05"]
        )

        variant_regression = copy.deepcopy(candidate)
        variant_regression["direct_family"]["work_macro"]["variant_accuracy"] = 0.4949
        failed = trainer._diagnostic_checks(
            anchor_train=anchor,
            candidate_train=variant_regression,
            base_metrics=self.base_metrics(),
            base_regression=regression,
            minimum_improvement=0.02,
            candidate_outputs_exact=True,
        )
        self.assertFalse(
            failed["train_work_macro_variant_accuracy_delta_at_least_negative_0_005"]
        )

    def test_selection_rejects_failed_epoch_ignores_page_ties_and_prefers_earlier(
        self,
    ) -> None:
        base = self.base_metrics()
        regression = {"gate": True}
        anchor_metrics = self.training_metrics()
        better = self.training_metrics(
            balanced=0.52, body=0.52, variant=0.5, row_balanced=0.8
        )
        anchor_key = trainer._selection_key(
            epoch=0,
            diagnostic_passed=False,
            base_metrics=base,
            base_regression=regression,
            train_metrics=anchor_metrics,
        )
        failed_key = trainer._selection_key(
            epoch=1,
            diagnostic_passed=False,
            base_metrics=base,
            base_regression=regression,
            train_metrics=better,
        )
        passed_key = trainer._selection_key(
            epoch=1,
            diagnostic_passed=True,
            base_metrics=base,
            base_regression=regression,
            train_metrics=better,
        )
        self.assertGreater(anchor_key, failed_key)
        self.assertGreater(passed_key, anchor_key)

        page_changed = copy.deepcopy(better)
        page_changed["page_consistency"] = {
            "all_rows_top1_in_common_positive_rate": 0.0,
            "top1_all_agree_rate": 0.0,
        }
        self.assertEqual(
            passed_key,
            trainer._selection_key(
                epoch=1,
                diagnostic_passed=True,
                base_metrics=base,
                base_regression=regression,
                train_metrics=page_changed,
            ),
        )
        later_key = trainer._selection_key(
            epoch=2,
            diagnostic_passed=True,
            base_metrics=base,
            base_regression=regression,
            train_metrics=better,
        )
        self.assertGreater(passed_key, later_key)

    def test_runtime_boundary_and_candidate_outputs_are_exact_and_nonpromotable(
        self,
    ) -> None:
        boundary = trainer.EXPECTED_RUNTIME_BOUNDARY
        self.assertIs(False, boundary["trajectory_replay_authority"])
        self.assertIs(False, boundary["keyed_artifact_authenticity"])
        self.assertEqual(
            "sealed_producer_attestation_only", boundary["phase_transcript"]
        )
        self.assertFalse(boundary["application_consumption_allowed"])
        self.assertFalse(boundary["existing_exporters_supported"])
        self.assertFalse(boundary["production_files_modified"])
        self.assertEqual(
            "nonpromotable_diagnostic_sidecar", boundary["promotion_state"]
        )

        anchor = self.anchor()
        model = trainer.r0.build_shared_hidden_family_residual(
            torch, anchor_model=anchor, maximum_margin=1.0
        )
        with torch.no_grad():
            model.family_margin_head.weight.fill_(0.02)
            model.family_margin_head.bias.fill_(0.1)
        generator = torch.Generator().manual_seed(17)
        queries = torch.randn(4, 3, 4, 256, generator=generator)
        prototypes = torch.randn(3, 4, 256, generator=generator)
        with torch.inference_mode():
            expected = anchor(queries, prototypes)
            actual = model(queries, prototypes)
        for name in (
            "body_candidate_scores",
            "candidate_scores",
            "variant_candidate_scores",
        ):
            self.assertEqual(
                expected[name].numpy().tobytes(), actual[name].numpy().tobytes(), name
            )
        self.assertFalse(
            torch.equal(expected["family_logits"], actual["family_logits"])
        )

        cache = {
            name: expected[name]
            for name in (
                "body_candidate_scores",
                "candidate_scores",
                "variant_candidate_scores",
            )
        }
        invariance = trainer._candidate_invariance(cache)
        self.assertEqual(
            invariance["anchor_three_output_sha256"],
            invariance["three_output_sha256"],
        )
        self.assertTrue(invariance["body_candidate_scores_byte_exact"])
        self.assertTrue(invariance["variant_candidate_scores_byte_exact"])
        self.assertFalse(invariance["internal_soft_gate_candidate_scores_evaluated"])
        self.assertTrue(invariance["strict_metrics_use_hard_family_route"])

    def test_options_reject_non_exact_types_weakened_gates_and_contract_drift(
        self,
    ) -> None:
        trainer._validate_options(self.args())
        invalid = (
            ("fractional epochs", {"epochs": 1.5}, "epochs"),
            ("boolean batch", {"batch_size": True}, "batch_size"),
            ("boolean seed", {"seed": False}, "seed"),
            ("boolean numeric", {"learning_rate": True}, "learning_rate"),
            (
                "loose acceptable gate",
                {"maximum_acceptable_regression": 0.006},
                "thresholds",
            ),
            (
                "loose preferred gate",
                {"maximum_preferred_regression": 0.006},
                "thresholds",
            ),
            (
                "loose family gate",
                {"maximum_family_regression": 0.003},
                "thresholds",
            ),
            (
                "weak improvement",
                {"minimum_diagnostic_work_macro_improvement": 0.019},
                "cannot be weakened",
            ),
            (
                "base mode",
                {"base_supervision_mode": "all"},
                "base supervision mode",
            ),
            (
                "balance mode",
                {"direct_balance_mode": "row"},
                "direct balance mode",
            ),
            ("KL scope", {"anchor_kl_scope": "all"}, "base_only"),
        )
        for name, overrides, error in invalid:
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(trainer.R1TrainingError, error),
            ):
                trainer._validate_options(self.args(**overrides))

    def test_validator_rejects_link_or_reparse_before_artifact_read(self) -> None:
        with (
            mock.patch.object(
                trainer.r0.overlay_v3,
                "_path_or_ancestor_is_link_or_reparse",
                return_value=True,
            ),
            self.assertRaisesRegex(trainer.R1TrainingError, "linked or reparsed"),
        ):
            trainer.validate_output(Path("synthetic-linked-r1-output"))

    def test_synthetic_train_page_zero_stages_validates_and_rejects_resealed_tamper(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base_path = root / "base.npz"
            source_path = root / "head.safetensors"
            anchor_dir = root / "anchor"
            overlay_dir = root / "overlay"
            output = root / "output"
            base_path.write_bytes(b"synthetic-base")
            source_path.write_bytes(b"synthetic-head")
            anchor_dir.mkdir()
            overlay_dir.mkdir()

            anchor = self.anchor()
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
            direct_dev = [
                {
                    "family_label": 0,
                    "row_index": 4,
                    "sample_id": "s4",
                    "supervision_weight": 1.0,
                    "work_id": "dev",
                }
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
                    "development_eval": direct_dev,
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
                "sample_ids": np.asarray([f"s{i}" for i in range(6)]),
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
                "model": anchor,
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
            partition_contract = {
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
                    b"synthetic-r1-partition"
                ).hexdigest(),
            }
            partition = {
                "all_base_indices": np.arange(6, dtype=np.int64),
                "base_indices": np.asarray([4, 5], dtype=np.int64),
                "base_labels": arrays["family_labels"],
                "base_weights": arrays["family_label_weights"],
                "contract": partition_contract,
                "direct_indices": np.asarray([0, 1, 2, 3], dtype=np.int64),
                "direct_labels": np.asarray([0, 1, 0, 1], dtype=np.int64),
                "direct_weights": np.ones(4, dtype=np.float32),
                "direct_work_ids": np.asarray(["w1", "w1", "w2", "w2"]),
                "family_override": {"schema_version": "synthetic-r1-family-override"},
                "non_direct_indices": np.asarray([4, 5], dtype=np.int64),
                "page_indices": np.asarray([0, 2], dtype=np.int64),
                "page_labels": np.asarray([0, 0], dtype=np.int64),
                "page_weights": np.ones(2, dtype=np.float32),
                "page_work_ids": np.asarray(["w1", "w2"]),
            }
            metrics = self.training_metrics(per_work={"w1": 0.5, "w2": 0.5})
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
                    "--epochs",
                    "1",
                    "--batch-size",
                    "4",
                    "--evaluation-batch-size",
                    "4",
                    "--page-body-ce-weight",
                    "0",
                ]
            )

            with (
                mock.patch.object(trainer, "_load_context", return_value=context),
                mock.patch.object(
                    trainer, "_build_training_partition", return_value=partition
                ),
                mock.patch.object(
                    trainer.r0, "_build_frozen_cache", return_value=cache
                ),
                mock.patch.object(
                    trainer.r0,
                    "_evaluate_base_from_cache",
                    return_value=self.base_metrics(),
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
                    trainer,
                    "_subgroup_margin_flip_diagnostics",
                    return_value=subgroup,
                ),
                mock.patch.object(
                    trainer.r0,
                    "_optimization_step",
                    wraps=trainer.r0._optimization_step,
                ) as base_or_page_step,
                mock.patch.object(
                    trainer,
                    "_direct_accumulated_optimization_step",
                    wraps=trainer._direct_accumulated_optimization_step,
                ) as direct_step,
            ):
                result = trainer.train(args)
                self.assertEqual(0, result["best_epoch"])
                self.assertFalse(result["diagnostic_worth"])
                self.assertFalse(result["trajectory_replay_authority"])
                direct_step.assert_called_once()
                base_or_page_step.assert_called_once()
                self.assertEqual(
                    args.anchor_kl_weight,
                    base_or_page_step.call_args.kwargs["anchor_kl_weight"],
                )
                self.assertEqual(
                    [4, 5],
                    sorted(base_or_page_step.call_args.kwargs["indices"].tolist()),
                )

                manifest_path = output / trainer.MANIFEST_FILE
                marker_path = output / trainer.MARKER_FILE
                original_manifest = manifest_path.read_bytes()
                original_marker = marker_path.read_bytes()
                manifest = json.loads(original_manifest.decode("utf-8"))
                self.assertIsNone(
                    manifest["history"][1]["mean_train_losses"]["page_body"]
                )
                self.assertIsNone(
                    manifest["history"][1]["batch_consumption"]["page_schedule"]
                )
                self.assertEqual(
                    ["direct_family", "base_preservation"],
                    manifest["history"][1]["batch_consumption"][
                        "optimizer_phase_order"
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
                        trainer.SIDECAR_FILE: trainer.sha256_file(
                            output / trainer.SIDECAR_FILE
                        ),
                    }
                    marker_path.write_bytes(
                        trainer.json_bytes(trainer.seal_record(marker), pretty=True)
                    )

                def tamper_epoch_zero_state(record: dict[str, object]) -> None:
                    history = record["history"]
                    epoch0 = history[0]
                    epoch0["sidecar_state"]["family_margin_head.bias"][
                        "data_hex_little_endian_float32"
                    ] = "0000803f"
                    epoch0["sidecar_state_sha256"] = hashlib.sha256(
                        trainer.canonical_json(epoch0["sidecar_state"]).encode("utf-8")
                    ).hexdigest()

                tampers = (
                    (
                        "runtime authority",
                        lambda row: row["runtime_boundary"].__setitem__(
                            "trajectory_replay_authority", True
                        ),
                        "manifest authority or schema",
                    ),
                    (
                        "partition",
                        lambda row: row["partition"].__setitem__("base_rows", 3),
                        "training partition",
                    ),
                    (
                        "KL scope",
                        lambda row: row["objective_contract"].__setitem__(
                            "anchor_kl_scope", "all_phases"
                        ),
                        "objective contract",
                    ),
                    (
                        "page consumption",
                        lambda row: row["history"][1]["batch_consumption"].__setitem__(
                            "page_optimizer_calls", 1
                        ),
                        "batch consumption",
                    ),
                    (
                        "base schedule order seal",
                        lambda row: row["history"][1]["batch_consumption"][
                            "base_schedule"
                        ].__setitem__("ordered_base_row_index_sha256", "0" * 64),
                        "batch consumption",
                    ),
                    (
                        "direct balance configuration",
                        lambda row: row["configuration"].__setitem__(
                            "direct_balance_mode", "work"
                        ),
                        "objective contract",
                    ),
                    (
                        "selection",
                        lambda row: row["selection"].__setitem__(
                            "page_consistency_gradient_rows", 2
                        ),
                        "selection claim",
                    ),
                    (
                        "development selection input",
                        lambda row: row["history"][1].__setitem__(
                            "checkpoint_selection_inputs", ["development_eval"]
                        ),
                        "forbidden diagnostics",
                    ),
                    (
                        "candidate outputs",
                        lambda row: row["candidate_score_invariance"].__setitem__(
                            "body_candidate_scores_byte_exact", False
                        ),
                        "candidate score invariance",
                    ),
                    (
                        "metric-only page loss",
                        lambda row: row["history"][1]["mean_train_losses"].__setitem__(
                            "page_body", row["history"][1]["mean_train_losses"]["base"]
                        ),
                        "metric-only page loss",
                    ),
                    (
                        "epoch zero state",
                        tamper_epoch_zero_state,
                        "epoch zero sidecar",
                    ),
                )
                for name, mutator, error in tampers:
                    with self.subTest(tamper=name):
                        write_resealed(mutator)
                        with self.assertRaisesRegex(trainer.R1TrainingError, error):
                            trainer.validate_output(output)

                manifest_path.write_bytes(original_manifest)
                marker_path.write_bytes(original_marker)
                validated = trainer.validate_output(output)
                self.assertEqual(0, validated["best_epoch"])
                self.assertFalse(validated["trajectory_replay_authority"])


if __name__ == "__main__":
    unittest.main()
