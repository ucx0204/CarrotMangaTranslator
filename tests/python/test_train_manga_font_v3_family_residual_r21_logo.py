from __future__ import annotations

import copy
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import numpy as np
import torch

from scripts import train_manga_font_student_v8_role_family_adapter as v8
from scripts import train_manga_font_v3_family_residual_r21_logo as trainer


class TinyBoundedMarginModel(torch.nn.Module):
    def __init__(self, feature_dimension: int = 1) -> None:
        super().__init__()
        self.family_margin_head = torch.nn.Linear(feature_dimension, 1)
        with torch.no_grad():
            self.family_margin_head.weight.copy_(
                torch.linspace(-0.35, 0.25, feature_dimension)[None, :]
            )
            self.family_margin_head.bias.fill_(0.07)

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


class MangaFontV3FamilyResidualR21LogoTests(unittest.TestCase):
    def anchor(self, candidate_count: int = 3) -> torch.nn.Module:
        torch.manual_seed(17)
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
    def args(**overrides: object) -> Namespace:
        values: dict[str, object] = {
            **trainer.PRECOMMITTED_CONFIGURATION,
            "anchor_kl_scope": "base_only",
            "base_supervision_mode": "non_direct_preservation",
            "device": "cpu",
            "direct_balance_mode": "work_family",
            "direct_objective": "work_family_ce",
            "experiment_cell_id": "r21-shared_hidden64-work_family_ce",
            "feature_source": "shared_hidden64",
            "seed": trainer.INITIAL_SEEDS[0],
        }
        values.update(overrides)
        if "feature_source" in overrides or "direct_objective" in overrides:
            values["experiment_cell_id"] = (
                f"r21-{values['feature_source']}-{values['direct_objective']}"
            )
        return Namespace(**values)

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
        *, balanced: float = 0.5, body: float = 0.5, variant: float = 0.5
    ) -> dict[str, object]:
        return {
            "direct_family": {
                "row": {"balanced_accuracy": balanced, "body_accuracy": body},
                "work_macro": {
                    "balanced_accuracy": balanced,
                    "body_accuracy": body,
                    "per_work": {
                        "w0": {"balanced_accuracy": balanced},
                        "w1": {"balanced_accuracy": balanced},
                    },
                    "variant_accuracy": variant,
                },
            },
            "margin": {
                "mean_absolute_margin": 0.0,
                "saturation_rate_at_95pct_budget": 0.0,
            },
            "page_consistency": {
                "all_rows_top1_in_common_positive_rate": 0.5,
                "mean_common_positive_mass": 0.5,
                "mean_js": 0.1,
                "top1_all_agree_rate": 0.5,
            },
        }

    @staticmethod
    def synthetic_logo_inputs() -> tuple[dict[str, object], dict[str, object]]:
        works = tuple(f"work-{index:02d}" for index in range(10))
        direct_indices = np.arange(20, dtype=np.int64)
        non_direct_indices = np.arange(20, 40, dtype=np.int64)
        direct_work_ids = np.asarray(
            [work for work in works for _family in range(2)], dtype=np.str_
        )
        non_direct_work_ids = np.asarray(
            [work for work in works for _family in range(2)], dtype=np.str_
        )
        work_ids = np.concatenate((direct_work_ids, non_direct_work_ids))
        labels = np.tile(np.asarray([0, 1], dtype=np.int64), 20)
        weights = np.linspace(0.5, 1.5, 40, dtype=np.float32)
        direct_labels = labels[direct_indices]
        direct_weights = weights[direct_indices]
        direct_rows = tuple(
            {
                "family_label": int(labels[row]),
                "row_index": int(row),
                "sample_id": f"sample-{row:02d}",
                "supervision_weight": float(weights[row]),
                "work_id": str(work_ids[row]),
            }
            for row in direct_indices
        )
        page_groups = tuple(
            {
                "group_id": f"page-{work}",
                "row_indices": np.asarray([index * 2, index * 2 + 1], dtype=np.int64),
                "row_weights": np.ones(2, dtype=np.float32),
                "work_id": work,
            }
            for index, work in enumerate(works)
        )
        arrays = {
            "family_label_weights": weights,
            "family_labels": labels,
            "sample_ids": np.asarray(
                [f"sample-{index:02d}" for index in range(40)], dtype=np.str_
            ),
            "work_ids": work_ids,
        }
        context: dict[str, object] = {
            "arrays": arrays,
            "groups": {
                "development_eval": ("sealed-development-sentinel",),
                "direct_family": {
                    "development_eval": ("sealed-development-sentinel",),
                    "train": direct_rows,
                },
                "train": page_groups,
            },
        }
        strata = [
            {"family_label": family, "work_id": work}
            for work in works
            for family in (0, 1)
        ]
        global_partition: dict[str, object] = {
            "all_base_indices": np.arange(40, dtype=np.int64),
            "base_indices": non_direct_indices,
            "base_labels": labels,
            "base_weights": weights,
            "contract": {
                "work_family_strata": strata,
                "synthetic": True,
            },
            "direct_indices": direct_indices,
            "direct_labels": direct_labels,
            "direct_weights": direct_weights,
            "direct_work_ids": direct_work_ids,
            "family_override": {"synthetic": True},
        }
        return context, global_partition

    @staticmethod
    def hard_objective_partition() -> dict[str, object]:
        works = tuple(f"work-{index:02d}" for index in range(9))
        work_ids = np.asarray(
            [work for work in works for family in (0, 1) for _ in range(2)],
            dtype=np.str_,
        )
        labels = np.asarray(
            [family for _work in works for family in (0, 1) for _ in range(2)],
            dtype=np.int64,
        )
        indices = np.arange(len(labels), dtype=np.int64)
        return {
            "contract": {"active_work_family_strata_count": 18},
            "direct_indices": indices,
            "direct_labels": labels,
            "direct_weights": np.resize(
                np.asarray([1.0, 3.0], dtype=np.float32), len(labels)
            ),
            "direct_work_ids": work_ids,
            "heldout_work_id": "heldout-work",
        }

    def test_four_cells_use_exact_zero_heads_and_preserve_anchor_outputs(self) -> None:
        generator = torch.Generator().manual_seed(23)
        query_views = torch.randn(5, 2, 4, 256, generator=generator)
        prototypes = torch.randn(3, 4, 256, generator=generator)
        expected_dimensions = {
            "shared_hidden64": 64,
            "family_norm1024": 1024,
        }

        for feature_source in trainer.FEATURE_SOURCES:
            first_payload: dict[str, object] | None = None
            for objective in trainer.DIRECT_OBJECTIVES:
                with self.subTest(
                    feature_source=feature_source, direct_objective=objective
                ):
                    trainer._validate_options(
                        self.args(
                            feature_source=feature_source,
                            direct_objective=objective,
                        )
                    )
                    anchor = self.anchor()
                    with torch.inference_mode():
                        anchor_outputs = anchor(query_views, prototypes)
                    model = trainer._build_r21_model(
                        torch,
                        anchor_model=anchor,
                        maximum_margin=1.0,
                        feature_source=feature_source,
                    )
                    with torch.inference_mode():
                        outputs = model(query_views, prototypes)
                    self.assertTrue(
                        torch.equal(
                            outputs["family_logits"], anchor_outputs["family_logits"]
                        )
                    )
                    for name in (
                        "body_candidate_scores",
                        "candidate_scores",
                        "variant_candidate_scores",
                    ):
                        self.assertTrue(
                            torch.equal(outputs[name], anchor_outputs[name]), name
                        )
                    self.assertEqual(
                        bytes(query_views.shape[0] * 4),
                        outputs["family_margin_delta"].detach().numpy().tobytes(),
                    )
                    state = trainer._sidecar_state(model, feature_source)
                    payload = trainer._state_payload(state, feature_source)
                    self.assertEqual(
                        {
                            "family_margin_head.bias": ((1,), "float32"),
                            "family_margin_head.weight": (
                                (1, expected_dimensions[feature_source]),
                                "float32",
                            ),
                        },
                        trainer._sidecar_spec(feature_source),
                    )
                    self.assertFalse(
                        any(
                            np.count_nonzero(value.detach().numpy())
                            for value in state.values()
                        )
                    )
                    if first_payload is None:
                        first_payload = copy.deepcopy(payload)
                    else:
                        self.assertEqual(first_payload, payload)
                    initial = trainer._initial_state_contract(model, feature_source)
                    self.assertIsNone(initial["head_initialization_seed"])
                    self.assertFalse(initial["seed_changes_initialization"])

    def test_family_norm1024_replays_anchor_family_input_exactly(self) -> None:
        generator = torch.Generator().manual_seed(29)
        query_views = torch.randn(7, 3, 4, 256, generator=generator)
        prototypes = torch.randn(3, 4, 256, generator=generator)
        anchor = self.anchor()
        with torch.inference_mode():
            actual = trainer.frozen_family_norm(torch, anchor, query_views)
            normalized = torch.nn.functional.normalize(
                query_views.float().mean(dim=1), p=2, dim=-1
            )
            expected = anchor.family_norm(normalized.reshape(7, 1024))
            anchor_outputs = anchor(query_views, prototypes)
        self.assertTrue(torch.equal(actual, expected))
        with torch.inference_mode():
            replayed_logits = anchor.family_head(actual)
        self.assertTrue(torch.equal(replayed_logits, anchor_outputs["family_logits"]))

        globally_normalized = torch.nn.functional.normalize(
            query_views.float().mean(dim=1).reshape(7, 1024), p=2, dim=-1
        )
        wrong = anchor.family_norm(globally_normalized)
        self.assertFalse(torch.equal(actual, wrong))

    def test_gamma_one_hard_ce_is_detached_stratum_normalized_and_divides_by_18(
        self,
    ) -> None:
        partition = self.hard_objective_partition()
        rows = partition["direct_indices"]
        labels = partition["direct_labels"]
        works = partition["direct_work_ids"]
        sealed = np.resize(np.asarray([0.25, 0.75], dtype=np.float32), len(rows))
        hidden = torch.linspace(
            -1.5,
            1.5,
            len(rows) * trainer.r0.EXPECTED_HIDDEN_DIM,
        ).reshape(len(rows), trainer.r0.EXPECTED_HIDDEN_DIM)
        anchor_logits = torch.stack(
            (
                torch.linspace(-0.8, 0.9, len(rows)),
                torch.linspace(0.7, -0.6, len(rows)),
            ),
            dim=1,
        ).requires_grad_(True)
        cache = {"family_logits": anchor_logits, "hidden": hidden}
        model = trainer._build_r21_model(
            torch,
            anchor_model=self.anchor(),
            maximum_margin=1.0,
            feature_source="shared_hidden64",
        )
        with torch.no_grad():
            model.family_margin_head.weight.copy_(
                torch.linspace(-0.35, 0.25, trainer.r0.EXPECTED_HIDDEN_DIM)[None, :]
            )
            model.family_margin_head.bias.fill_(0.07)

        actual, contract = trainer._hard_example_weights(
            torch,
            model,
            cache=cache,
            indices=rows,
            labels=labels,
            work_ids=works,
            sealed_normalized_weights=sealed,
        )
        self.assertIsNone(anchor_logits.grad)
        self.assertTrue(
            all(
                parameter.grad is None
                for parameter in model.family_margin_head.parameters()
            )
        )
        outputs = trainer.r0._head_outputs_for_indices(torch, model, cache, rows)
        probabilities = torch.softmax(outputs["family_logits"], dim=1).detach().numpy()
        expected = np.empty_like(sealed)
        descriptor_by_stratum = {
            (row["work_id"], row["family_label"]): row for row in contract["strata"]
        }
        for work in sorted(set(works.tolist())):
            for family in (0, 1):
                positions = np.flatnonzero((works == work) & (labels == family))
                numerator = (
                    sealed[positions] * (1.0 - probabilities[positions, family])
                ).astype(np.float32)
                normalized = numerator / np.sum(numerator, dtype=np.float32)
                candidate_order = np.lexsort((-rows[positions], -normalized))
                for correction_rank, offset_value in enumerate(candidate_order):
                    correction_offset = int(offset_value)
                    try:
                        expected_values = trainer.r1._correct_float32_sum_to_one(
                            normalized,
                            correction_offset=correction_offset,
                        )
                    except trainer.r1.R1TrainingError:
                        continue
                    break
                else:  # pragma: no cover - producer helper owns the same guard
                    self.fail("synthetic hard stratum has no exact f32 correction")
                expected[positions] = expected_values
                descriptor = descriptor_by_stratum[(work, family)]
                self.assertEqual(
                    "descending_pre_correction_weight_then_highest_base_row_first_exact",
                    descriptor["normalization_correction_rule"],
                )
                self.assertEqual(
                    correction_rank,
                    descriptor["normalization_correction_candidate_rank"],
                )
                self.assertEqual(
                    int(rows[positions][correction_offset]),
                    descriptor["normalization_correction_base_row_index"],
                )
                self.assertEqual(
                    np.float32(1.0), np.sum(actual[positions], dtype=np.float32)
                )
        np.testing.assert_array_equal(expected, actual)
        self.assertTrue(contract["detached_phase_start_probability"])
        self.assertEqual(1.0, contract["gamma"])
        self.assertEqual(18, contract["stratum_count"])

        args = self.args(direct_objective="work_family_hard_ce_gamma1")
        training_cache = {
            "family_logits": anchor_logits.detach(),
            "hidden": hidden,
        }
        batches, schedule = trainer._direct_batches(
            torch,
            model,
            cache=training_cache,
            partition=partition,
            args=args,
            epoch=1,
        )
        self.assertEqual(18, schedule["active_fold_denominator"])
        self.assertEqual(18, schedule["loss_denominator"])
        self.assertEqual(20, schedule["full_data_refit_denominator_not_used"])
        effective_by_row = np.empty(len(rows), dtype=np.float32)
        for batch_rows, _batch_labels, batch_weights in batches:
            effective_by_row[batch_rows] = batch_weights
        for work in sorted(set(works.tolist())):
            for family in (0, 1):
                positions = np.flatnonzero((works == work) & (labels == family))
                self.assertEqual(
                    np.float32(1.0),
                    np.sum(effective_by_row[positions], dtype=np.float32),
                )
        self.assertAlmostEqual(
            18.0, float(effective_by_row.astype(np.float64).sum()), places=6
        )

        reference_outputs = trainer.r0._head_outputs_for_indices(
            torch,
            model,
            training_cache,
            np.concatenate([batch[0] for batch in batches]),
        )
        ordered_labels = torch.from_numpy(
            np.concatenate([batch[1] for batch in batches])
        )
        ordered_weights = torch.from_numpy(
            np.concatenate([batch[2] for batch in batches])
        )
        expected_ce = (
            torch.nn.functional.cross_entropy(
                reference_outputs["family_logits"], ordered_labels, reduction="none"
            )
            * ordered_weights
        ).sum() / 18.0
        optimizer = torch.optim.SGD(model.family_margin_head.parameters(), lr=0.0)
        losses = trainer._direct_accumulated_step(
            torch,
            model,
            optimizer,
            cache=training_cache,
            batches=batches,
            fixed_denominator=schedule["active_fold_denominator"],
            args=self.args(
                direct_objective="work_family_hard_ce_gamma1",
                residual_l2_weight=0.0,
            ),
        )
        self.assertAlmostEqual(
            float(expected_ce.detach()), losses["family_ce"], places=6
        )

        drifted = copy.deepcopy(partition)
        drifted["contract"]["active_work_family_strata_count"] = 20
        with self.assertRaisesRegex(trainer.R21TrainingError, "denominator"):
            trainer._direct_batches(
                torch,
                model,
                cache=training_cache,
                partition=drifted,
                args=args,
                epoch=1,
            )

    def test_hard_weight_correction_closes_real_78_row_float32_residual(self) -> None:
        # Exact pre-correction f32 values captured from fold 0 / epoch 2 of the
        # first real shared-hidden hard-CE run. The former highest-row element
        # is too small for 4,096 nextafter steps to absorb the reduction error.
        value_hex = (
            "d86469399814363cf590b43c9e0a923c0408c63caa45c23c2ed8be3c8276b23c"
            "c59f113aa0a7dd3b3f8db83a2562ca3c2b1fe63ae816253929bdbc3c0a8fb63c"
            "a556883cef2fb23c3573b63ab1cbcd3c49e2be3c111bc0397a8a673c1b337038"
            "0329b83cb1e9253aca86a73c62fc973c1bc2b83a08a88c3c86e62d3aa247873b"
            "c141ac391425923a957da43cb9b09d3c2279a73c397be439ede4993a8ff8bf3c"
            "adcb8a3918a5ba3c36289a3cbf53b83ca8a06439fb67cb3cd806c33a7ac4693c"
            "9e41b93c98b3b73cc752bc395dddb33ce334c53c4cd9a23c9740ba3c40f8ba3c"
            "0d68fd3b7c3ac5392060c03ca8b20e39aeb1c63c5549ae3c298406395cc9f738"
            "b8a0c737c4deb43bc8121b3cfa53bb3aa3b4943c6d7cc43cd7aabf3cd5fbbc3c"
            "99a8393a4e4bb83c850c323c97f48b3ccd989e3b37048238"
        )
        values = np.frombuffer(bytes.fromhex(value_hex), dtype="<f4").copy()
        base_rows = np.arange(len(values), dtype=np.int64)
        self.assertEqual(78, len(values))
        self.assertEqual(
            np.float32(1.0000001192092896), np.sum(values, dtype=np.float32)
        )
        self.assertEqual(19, int(np.argmax(values)))
        with self.assertRaises(trainer.r1.R1TrainingError):
            trainer.r1._correct_float32_sum_to_one(
                values, correction_offset=len(values) - 1
            )

        corrected, correction_offset, correction_rank = (
            trainer._correct_hard_example_float32_sum_to_one(
                values, base_rows=base_rows
            )
        )
        self.assertEqual(19, correction_offset)
        self.assertEqual(0, correction_rank)
        self.assertEqual(np.float32(1.0), np.sum(corrected, dtype=np.float32))
        self.assertTrue(np.all(corrected > 0))

        skip_hex = (
            "ee19083cc9ebc43df9b8cf3dec7c713c31dd393c4d56043b08969239336e533b"
            "718a4a3d25df673939bfce3ba117a53e2411053b9f654e3bae11a73b034d143b"
            "ca171a3eb3f85d3e1d838c3b"
        )
        skip_values = np.frombuffer(bytes.fromhex(skip_hex), dtype="<f4").copy()
        skip_rows = np.asarray(
            [
                1630,
                2901,
                3314,
                5541,
                8079,
                9489,
                9493,
                9495,
                9672,
                9746,
                11783,
                12326,
                12607,
                12925,
                13076,
                13262,
                14065,
                14251,
                14349,
            ],
            dtype=np.int64,
        )
        self.assertEqual(19, len(skip_values))
        self.assertEqual(11, int(np.argmax(skip_values)))
        with self.assertRaises(trainer.r1.R1TrainingError):
            trainer.r1._correct_float32_sum_to_one(skip_values, correction_offset=11)
        skip_corrected, skip_offset, skip_rank = (
            trainer._correct_hard_example_float32_sum_to_one(
                skip_values, base_rows=skip_rows
            )
        )
        self.assertEqual(17, skip_offset)
        self.assertEqual(14251, int(skip_rows[skip_offset]))
        self.assertEqual(1, skip_rank)
        self.assertEqual(np.float32(1.0), np.sum(skip_corrected, dtype=np.float32))

    def test_ten_logo_folds_exclude_heldout_from_every_training_surface(self) -> None:
        context, global_partition = self.synthetic_logo_inputs()
        with mock.patch.object(
            trainer, "_global_partition", return_value=global_partition
        ):
            folds = trainer._build_logo_folds(context, self.args(), enforce_real=True)

        self.assertEqual(10, len(folds))
        self.assertEqual(
            [f"work-{index:02d}" for index in range(10)],
            [fold["heldout_work_id"] for fold in folds],
        )
        array_works = context["arrays"]["work_ids"]
        for fold_index, fold in enumerate(folds):
            heldout = fold["heldout_work_id"]
            contract = fold["contract"]
            with self.subTest(fold=fold_index, heldout=heldout):
                self.assertEqual(18, contract["active_work_family_strata_count"])
                self.assertEqual(20, contract["full_work_family_strata_count"])
                self.assertEqual(18, contract["direct_rows"])
                self.assertEqual(18, contract["base_rows"])
                self.assertEqual(36, contract["all_gradient_rows"])
                self.assertEqual(4, contract["heldout_all_base_rows"])
                self.assertEqual(2, contract["heldout_direct_rows"])
                self.assertEqual(0, contract["gradient_heldout_row_intersection_count"])
                self.assertEqual(
                    0, contract["gradient_heldout_work_intersection_count"]
                )
                for key in (
                    "all_base_indices",
                    "base_indices",
                    "direct_indices",
                    "page_indices",
                ):
                    self.assertNotIn(heldout, set(array_works[fold[key]].tolist()), key)
                self.assertNotIn(heldout, set(fold["direct_work_ids"].tolist()))
                self.assertNotIn(
                    heldout,
                    {
                        row["work_id"]
                        for row in fold["selection_groups"]["direct_family"]["train"]
                    },
                )
                self.assertNotIn(
                    heldout,
                    {group["work_id"] for group in fold["selection_groups"]["train"]},
                )
                self.assertEqual(
                    {heldout}, {row["work_id"] for row in fold["heldout_direct_rows"]}
                )
                self.assertEqual(
                    {heldout},
                    {group["work_id"] for group in fold["heldout_page_groups"]},
                )

    def test_seed_changes_only_schedules_not_folds_or_zero_initializer(self) -> None:
        context, global_partition = self.synthetic_logo_inputs()
        fold_plans: list[tuple[dict[str, object], ...]] = []
        with mock.patch.object(
            trainer, "_global_partition", return_value=global_partition
        ):
            for seed in trainer.FINAL_SEEDS:
                folds = trainer._build_logo_folds(
                    context,
                    self.args(
                        seed=seed,
                        feature_source=trainer.FEATURE_SOURCES[seed % 2],
                        direct_objective=trainer.DIRECT_OBJECTIVES[seed % 2],
                    ),
                    enforce_real=True,
                )
                fold_plans.append(
                    tuple(copy.deepcopy(fold["contract"]) for fold in folds)
                )
        for plan in fold_plans[1:]:
            self.assertEqual(fold_plans[0], plan)

        anchor = self.anchor()
        payloads = []
        for feature_source in trainer.FEATURE_SOURCES:
            model = trainer._build_r21_model(
                torch,
                anchor_model=copy.deepcopy(anchor),
                maximum_margin=1.0,
                feature_source=feature_source,
            )
            payloads.append(
                trainer._state_payload(
                    trainer._sidecar_state(model, feature_source), feature_source
                )
            )
            self.assertTrue(
                trainer._experiment_contract()["seed_contract"][
                    "seed_changes_only_schedule_and_float_accumulation_order"
                ]
            )
        self.assertNotEqual(payloads[0], payloads[1])
        for feature_source, payload in zip(
            trainer.FEATURE_SOURCES, payloads, strict=True
        ):
            for seed in trainer.FINAL_SEEDS:
                repeated = trainer._build_r21_model(
                    torch,
                    anchor_model=self.anchor(),
                    maximum_margin=1.0,
                    feature_source=feature_source,
                )
                self.assertEqual(
                    payload,
                    trainer._state_payload(
                        trainer._sidecar_state(repeated, feature_source), feature_source
                    ),
                    seed,
                )

        seeds = {
            trainer._schedule_seed(
                seed=seed, heldout_work_id="work-00", epoch=1, phase="direct"
            )
            for seed in trainer.FINAL_SEEDS
        }
        self.assertEqual(len(trainer.FINAL_SEEDS), len(seeds))
        self.assertNotEqual(
            trainer._schedule_seed(
                seed=trainer.INITIAL_SEEDS[0],
                heldout_work_id="work-00",
                epoch=1,
                phase="direct",
            ),
            trainer._schedule_seed(
                seed=trainer.INITIAL_SEEDS[0],
                heldout_work_id="work-00",
                epoch=1,
                phase="base",
            ),
        )

    def test_logo_aggregate_gates_and_fold_selection_epoch_zero_ties(self) -> None:
        reports = []
        for index in range(10):
            reports.append(
                {
                    "checks": {"synthetic_safety": True},
                    "deltas": {
                        "balanced_accuracy": -0.05 if index == 0 else 0.03,
                        "body_accuracy": 0.02,
                        "variant_accuracy": -0.005,
                    },
                    "fold_index": index,
                }
            )
        aggregate = trainer._aggregate_logo_metrics(reports)
        self.assertTrue(aggregate["passed"])
        self.assertEqual(10, aggregate["fold_count"])
        self.assertAlmostEqual(
            0.022, aggregate["heldout_work_macro_delta"]["balanced_accuracy"]
        )
        self.assertAlmostEqual(
            -0.05, aggregate["worst_heldout_work_balanced_accuracy_delta"]
        )

        failures = (
            (
                lambda values: values[0]["deltas"].__setitem__(
                    "variant_accuracy", -0.005001
                ),
                "all_fold_variant_deltas_at_least_negative_0_005",
            ),
            (
                lambda values: values[0]["deltas"].__setitem__(
                    "balanced_accuracy", -0.050001
                ),
                "worst_heldout_work_balanced_accuracy_delta_at_least_negative_0_05",
            ),
            (
                lambda values: [
                    report["deltas"].__setitem__("body_accuracy", 0.02 - 1e-9)
                    for report in values
                ],
                "heldout_work_macro_body_accuracy_improved_by_0_02",
            ),
            (
                lambda values: values[0]["checks"].__setitem__(
                    "synthetic_safety", False
                ),
                "all_fold_base_and_page_and_candidate_checks_passed",
            ),
        )
        for mutator, failed_check in failures:
            with self.subTest(failed_check=failed_check):
                changed = copy.deepcopy(reports)
                mutator(changed)
                result = trainer._aggregate_logo_metrics(changed)
                self.assertFalse(result["passed"])
                self.assertFalse(result["checks"][failed_check])

        base = self.base_metrics()
        regression = {"synthetic": True}
        metrics = self.training_metrics()
        epoch_zero = trainer._fold_selection_key(
            epoch=0,
            diagnostic_passed=False,
            base_metrics=base,
            base_regression=regression,
            train_metrics=metrics,
        )
        failed_epoch = trainer._fold_selection_key(
            epoch=1,
            diagnostic_passed=False,
            base_metrics=base,
            base_regression=regression,
            train_metrics=metrics,
        )
        passed_epoch_one = trainer._fold_selection_key(
            epoch=1,
            diagnostic_passed=True,
            base_metrics=base,
            base_regression=regression,
            train_metrics=metrics,
        )
        passed_epoch_two = trainer._fold_selection_key(
            epoch=2,
            diagnostic_passed=True,
            base_metrics=base,
            base_regression=regression,
            train_metrics=metrics,
        )
        self.assertGreater(epoch_zero, failed_epoch)
        self.assertGreater(passed_epoch_one, epoch_zero)
        self.assertGreater(passed_epoch_one, passed_epoch_two)

    def test_synthetic_hard_objective_train_strictly_validates_and_rejects_tamper(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base_path = root / "base.npz"
            source_path = root / "head.safetensors"
            anchor_dir = root / "anchor"
            overlay_dir = root / "overlay"
            output = root / "output"
            base_path.write_bytes(b"synthetic-r21-base")
            source_path.write_bytes(b"synthetic-r21-head")
            anchor_dir.mkdir()
            overlay_dir.mkdir()

            context, global_partition = self.synthetic_logo_inputs()
            context.update(
                {
                    "candidate_ids": ("a", "b", "single-day"),
                    "dataset_path": base_path.resolve(),
                    "initialization": {"synthetic": True},
                    "inventory": {"row_count": 40, "synthetic": True},
                    "model": self.anchor(),
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
                "hidden": torch.arange(
                    40 * trainer.r0.EXPECTED_HIDDEN_DIM, dtype=torch.float32
                ).reshape(40, trainer.r0.EXPECTED_HIDDEN_DIM)
                / 1000.0,
                "variant_candidate_scores": torch.zeros(40, 3),
            }
            base_metrics = self.base_metrics()
            training_metrics = self.training_metrics()
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
                    "--feature-source",
                    "shared_hidden64",
                    "--direct-objective",
                    "work_family_hard_ce_gamma1",
                ]
            )
            events: list[str] = []
            original_selection_key = trainer._fold_selection_key

            def observed_selection_key(*call_args: object, **call_kwargs: object):
                events.append("selection")
                return original_selection_key(*call_args, **call_kwargs)

            def observed_heldout(*_call_args: object, **_call_kwargs: object):
                events.append("heldout")
                return copy.deepcopy(heldout_metrics)

            with (
                mock.patch.object(trainer, "_load_context", return_value=context),
                mock.patch.object(
                    trainer, "_global_partition", return_value=global_partition
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
                    trainer, "_fold_training_metrics", return_value=training_metrics
                ),
                mock.patch.object(
                    trainer,
                    "_fold_diagnostic_checks",
                    return_value=diagnostic_checks,
                ),
                mock.patch.object(
                    trainer.r1,
                    "_subgroup_margin_flip_diagnostics",
                    return_value=subgroup,
                ),
                mock.patch.object(
                    trainer,
                    "_postselection_heldout_metrics",
                    side_effect=observed_heldout,
                ),
                mock.patch.object(
                    trainer,
                    "_fold_selection_key",
                    side_effect=observed_selection_key,
                ),
            ):
                result = trainer.train(args)
                self.assertEqual(10, result["fold_count"])
                self.assertEqual(
                    "work_family_hard_ce_gamma1", result["direct_objective"]
                )
                self.assertFalse(result["logo_diagnostic_worth"])
                self.assertFalse(result["trajectory_replay_authority"])

                # Every producer fold fixes its winner using epoch0 plus eight
                # selectable post-base keys before either held-out metric call.
                for fold_index in range(10):
                    start = fold_index * 11
                    self.assertEqual(
                        ["selection"] * 9 + ["heldout"] * 2,
                        events[start : start + 11],
                    )

                validated = trainer.validate_output(output)
                self.assertTrue(validated["read_only_recomputation"])
                self.assertEqual(10, validated["fold_count"])

                manifest_path = output / trainer.MANIFEST_FILE
                marker_path = output / trainer.MARKER_FILE
                original_manifest = manifest_path.read_bytes()
                original_marker = marker_path.read_bytes()
                manifest = json.loads(original_manifest.decode("utf-8"))
                marker_record = json.loads(original_marker.decode("utf-8"))
                self.assertEqual(10, len(manifest["folds"]))
                self.assertEqual(10, len(manifest["files"]))
                self.assertEqual(trainer._producer_binding(), manifest["producer"])
                self.assertEqual(manifest["producer"], marker_record["producer"])
                self.assertEqual(manifest["producer"], result["producer"])
                self.assertFalse(manifest["development_boundary"]["consulted"])
                for fold_index, fold in enumerate(manifest["folds"]):
                    self.assertEqual(0, fold["selected_epoch"])
                    self.assertEqual(17, len(fold["history"]))
                    self.assertEqual(
                        trainer._sidecar_name(fold_index), fold["sidecar_file"]
                    )
                    for record in fold["history"]:
                        self.assertFalse(record["heldout_work_consulted"])
                        self.assertFalse(record["development_eval_consulted"])
                    direct_schedule = fold["history"][1]["batch_consumption"][
                        "direct_schedule"
                    ]
                    self.assertEqual(18, direct_schedule["active_fold_denominator"])
                    self.assertEqual(18, direct_schedule["loss_denominator"])
                    self.assertTrue(
                        direct_schedule["hard_example"][
                            "detached_phase_start_probability"
                        ]
                    )

                def write_resealed(mutator: object) -> None:
                    record = json.loads(original_manifest.decode("utf-8"))
                    mutator(record)  # type: ignore[operator]
                    manifest_path.write_bytes(
                        trainer.json_bytes(trainer.seal_record(record), pretty=True)
                    )
                    marker = json.loads(original_marker.decode("utf-8"))
                    marker["artifacts"][trainer.MANIFEST_FILE] = trainer.sha256_file(
                        manifest_path
                    )
                    marker_path.write_bytes(
                        trainer.json_bytes(trainer.seal_record(marker), pretty=True)
                    )

                tampers = (
                    (
                        "heldout enters epoch selection",
                        lambda record: record["folds"][0]["history"][1].__setitem__(
                            "heldout_work_consulted", True
                        ),
                        "boundary drifted",
                    ),
                    (
                        "hard objective transcript",
                        lambda record: record["folds"][0]["history"][1][
                            "batch_consumption"
                        ]["direct_schedule"]["hard_example"].__setitem__(
                            "effective_row_weight_sha256", "0" * 64
                        ),
                        "boundary drifted",
                    ),
                    (
                        "fold denominator 20",
                        lambda record: record["folds"][0]["history"][1][
                            "batch_consumption"
                        ]["direct_schedule"].__setitem__("active_fold_denominator", 20),
                        "boundary drifted",
                    ),
                    (
                        "epoch zero state",
                        lambda record: self._tamper_epoch_zero_state(record),
                        "exact zero initializer",
                    ),
                    (
                        "heldout report",
                        lambda record: record["folds"][0]["heldout_postselection"][
                            "deltas"
                        ].__setitem__("body_accuracy", 0.25),
                        "heldout postselection",
                    ),
                    (
                        "development opened",
                        lambda record: record["development_boundary"].__setitem__(
                            "consulted", True
                        ),
                        "development boundary",
                    ),
                    (
                        "producer hash",
                        lambda record: record["producer"].__setitem__(
                            "sha256", "0" * 64
                        ),
                        "manifest producer binding",
                    ),
                )
                for name, mutator, error in tampers:
                    with self.subTest(tamper=name):
                        write_resealed(mutator)
                        with self.assertRaisesRegex(trainer.R21TrainingError, error):
                            trainer.validate_output(output)

                manifest_path.write_bytes(original_manifest)
                changed_marker = json.loads(original_marker.decode("utf-8"))
                changed_marker["producer"]["byte_size"] += 1
                marker_path.write_bytes(
                    trainer.json_bytes(trainer.seal_record(changed_marker), pretty=True)
                )
                with self.assertRaisesRegex(
                    trainer.R21TrainingError,
                    "ownership marker producer binding",
                ):
                    trainer.validate_output(output)
                marker_path.write_bytes(original_marker)

                # Replace a checkpoint and coherently refresh both descriptor
                # and ownership hashes.  Source/state recomputation must still
                # reject it as a state that checkpoint selection never chose.
                from safetensors.torch import load_file, save_file

                sidecar_name = trainer._sidecar_name(0)
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
                    trainer.json_bytes(trainer.seal_record(coherent), pretty=True)
                )
                coherent_marker = json.loads(original_marker.decode("utf-8"))
                coherent_marker["artifacts"][trainer.MANIFEST_FILE] = (
                    trainer.sha256_file(manifest_path)
                )
                coherent_marker["artifacts"][sidecar_name] = trainer.sha256_file(
                    sidecar_path
                )
                marker_path.write_bytes(
                    trainer.json_bytes(
                        trainer.seal_record(coherent_marker), pretty=True
                    )
                )
                with self.assertRaisesRegex(
                    trainer.R21TrainingError, "not selected post-base state"
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
                changed_producer = {
                    **trainer._producer_binding(),
                    "sha256": "f" * 64,
                }
                with (
                    mock.patch.object(
                        trainer,
                        "_producer_binding",
                        return_value=changed_producer,
                    ),
                    self.assertRaisesRegex(
                        trainer.R21TrainingError,
                        "producer binding",
                    ),
                ):
                    trainer.validate_output(output)

    @staticmethod
    def _tamper_epoch_zero_state(record: dict[str, object]) -> None:
        epoch_zero = record["folds"][0]["history"][0]  # type: ignore[index]
        tensor = epoch_zero["sidecar_state"][  # type: ignore[index]
            "family_margin_head.weight"
        ]
        encoded = tensor["data_hex_little_endian_float32"]
        tensor["data_hex_little_endian_float32"] = "01" + encoded[2:]
        epoch_zero["sidecar_state_sha256"] = trainer._payload_sha256(
            epoch_zero["sidecar_state"]
        )

    def test_validator_rejects_link_or_reparse_before_artifact_read(self) -> None:
        with (
            mock.patch.object(
                trainer.r0.overlay_v3,
                "_path_or_ancestor_is_link_or_reparse",
                return_value=True,
            ),
            self.assertRaisesRegex(trainer.R21TrainingError, "linked or reparsed"),
        ):
            trainer.validate_output(Path("synthetic-linked-r21-output"))


if __name__ == "__main__":
    unittest.main()
