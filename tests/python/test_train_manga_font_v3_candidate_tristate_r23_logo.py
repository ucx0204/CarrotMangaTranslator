from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch

from scripts import train_manga_font_student_v8_role_family_adapter as v8
from scripts import train_manga_font_v3_candidate_tristate_r23_logo as trainer


class MangaFontV3CandidateTristateR23LogoTests(unittest.TestCase):
    @staticmethod
    def production_shape_anchor() -> torch.nn.Module:
        torch.manual_seed(23)
        model = v8.build_role_family_adapter(
            torch,
            candidate_count=21,
            maximum_family_bias=0.1,
            candidate_residual_hidden_dim=64,
            maximum_sample_residual=0.75,
        )
        with torch.no_grad():
            model.sample_candidate_residual[2].weight.normal_(0.0, 0.02)
            model.sample_candidate_residual[2].bias.normal_(0.0, 0.02)
        return model.eval()

    @staticmethod
    def synthetic_base_metrics() -> dict[str, object]:
        section = {
            "acceptable_at1": 0.70,
            "family_accuracy": 0.99,
            "preferred_at1": 0.60,
            "single_day_body_false_top1_count": 0,
        }
        return {
            "all": dict(section),
            "quality_checks": {"synthetic": True},
            "quality_gate_passed": True,
            "visual": dict(section),
        }

    def synthetic_training_inputs(
        self, root: Path
    ) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
        works = tuple(f"work-{index:02d}" for index in range(10))
        candidate_ids = tuple(trainer.r0.page_v3.EXPECTED_CANDIDATE_IDS)
        candidate_count = len(candidate_ids)
        generator = torch.Generator().manual_seed(37)
        query_views = torch.randn(40, 1, 4, 256, generator=generator).numpy()
        prototypes = torch.randn(21, 4, 256, generator=generator).numpy()
        direct_work_ids = np.asarray(
            [work for work in works for _family in range(2)], dtype=np.str_
        )
        non_direct_work_ids = np.asarray(
            [work for work in works for _family in range(2)], dtype=np.str_
        )
        work_ids = np.concatenate((direct_work_ids, non_direct_work_ids))
        sample_ids = np.asarray(
            [f"synthetic-sample-{index:02d}" for index in range(40)], dtype=np.str_
        )
        arrays = {
            "prototype_queries": prototypes,
            "query_views": query_views,
            "sample_ids": sample_ids,
            "split": np.zeros(40, dtype=np.int64),
            "work_ids": work_ids,
        }
        shared = np.zeros(candidate_count, dtype=np.bool_)
        common = np.zeros(candidate_count, dtype=np.bool_)
        shared[:3] = True
        common[:2] = True
        groups = tuple(
            {
                "common_positive_mask": common.copy(),
                "group_id": f"synthetic-page-{work}",
                "row_indices": np.asarray(
                    [work_index * 2, work_index * 2 + 1], dtype=np.int64
                ),
                "shared_reviewed_eligible_mask": shared.copy(),
                "work_id": work,
            }
            for work_index, work in enumerate(works)
        )
        context: dict[str, object] = {
            "arrays": arrays,
            "candidate_ids": candidate_ids,
            "groups": {"development_eval": (), "train": groups},
            "model": self.production_shape_anchor(),
            "overlay_binding": {
                "development_eval_work_ids": ["dev-a", "dev-b", "dev-c"],
                "train_work_ids": list(works),
            },
        }

        preferred = np.zeros(candidate_count, dtype=np.bool_)
        safe = np.zeros(candidate_count, dtype=np.bool_)
        marginal = np.zeros(candidate_count, dtype=np.bool_)
        unacceptable = np.zeros(candidate_count, dtype=np.bool_)
        preferred[0] = True
        safe[:2] = True
        marginal[2] = True
        unacceptable[3] = True
        train_rows = tuple(
            {
                "family_label": family,
                "marginal_mask": marginal.copy(),
                "preferred_mask": preferred.copy(),
                "record_sha256": f"{row_index + 1:064x}",
                "row_index": row_index,
                "safe_mask": safe.copy(),
                "single_day_safety_negative": True,
                "supervision_weight": float(0.8 + 0.01 * (row_index % 5)),
                "unacceptable_mask": unacceptable.copy(),
                "work_id": works[row_index // 2],
            }
            for row_index, family in enumerate(
                np.tile(np.asarray([0, 1], dtype=np.int64), 10).tolist()
            )
        )
        development_rows = tuple(
            {"row_index": 100 + index, "work_id": f"dev-{chr(97 + index)}"}
            for index in range(3)
        )
        ledger: dict[str, object] = {
            "candidate_ids": candidate_ids,
            "contract": {
                "authority": dict(trainer.EXPECTED_AUTHORITY),
                "counts": {"synthetic": True},
                "inventory_sha256": "b" * 64,
                "single_day_policy": {"synthetic": True},
            },
            "development_eval": development_rows,
            "rows": train_rows + development_rows,
            "train": train_rows,
        }

        anchor_dir = root / "anchor"
        overlay_dir = root / "overlay"
        label_dir = root / "labels"
        anchor_dir.mkdir()
        overlay_dir.mkdir()
        label_dir.mkdir()
        base_path = root / "base.npz"
        source_path = root / "head.safetensors"
        base_path.write_bytes(b"synthetic-r23-base")
        source_path.write_bytes(b"synthetic-r23-head")
        context_contract = {
            "anchor": {
                "checkpoint_sha256": "c" * 64,
                "directory": str(anchor_dir.resolve()),
                "synthetic": True,
            },
            "base_dataset": {
                "file": str(base_path.resolve()),
                "sha256": "d" * 64,
                "synthetic": True,
            },
            "overlay": {
                "directory": str(overlay_dir.resolve()),
                "manifest_sha256": "e" * 64,
                "synthetic": True,
            },
            "source_query_head": {
                "file": str(source_path.resolve()),
                "sha256": "f" * 64,
                "synthetic": True,
            },
        }
        paths = {
            "anchor_dir": anchor_dir,
            "base_path": base_path,
            "label_dir": label_dir,
            "overlay_dir": overlay_dir,
            "source_path": source_path,
        }
        return context, ledger, {"contract": context_contract, "paths": paths}

    def test_only_existing_64x42_final_head_is_trainable_and_family_stays_exact(
        self,
    ) -> None:
        model = self.production_shape_anchor()
        generator = torch.Generator().manual_seed(29)
        query_views = torch.randn(6, 3, 4, 256, generator=generator)
        prototypes = torch.randn(21, 4, 256, generator=generator)
        frozen_before = {
            name: value.detach().clone()
            for name, value in model.state_dict().items()
            if name not in trainer.TRAINABLE_NAMES
        }
        with torch.inference_mode():
            anchor_outputs = {
                name: value.clone()
                for name, value in model(query_views, prototypes).items()
                if name
                in {
                    "body_candidate_scores",
                    "candidate_scores",
                    "family_logits",
                    "variant_candidate_scores",
                }
            }

        configured = trainer.configure_candidate_final_head(model)
        self.assertIs(configured, model)
        trainable = {
            name: parameter
            for name, parameter in model.named_parameters()
            if parameter.requires_grad
        }
        self.assertEqual(set(trainer.TRAINABLE_NAMES), set(trainable))
        self.assertEqual(
            {
                "sample_candidate_residual.2.bias": (42,),
                "sample_candidate_residual.2.weight": (42, 64),
            },
            {name: tuple(value.shape) for name, value in trainable.items()},
        )
        self.assertEqual(
            trainer.TRAINABLE_PARAMETER_COUNT,
            sum(value.numel() for value in trainable.values()),
        )
        self.assertEqual(2_730, trainer.TRAINABLE_PARAMETER_COUNT)
        self.assertEqual(
            {
                "sample_candidate_residual.2.bias": ((42,), "float32"),
                "sample_candidate_residual.2.weight": ((42, 64), "float32"),
            },
            trainer._sidecar_spec(),
        )
        with torch.inference_mode():
            configured_outputs = model(query_views, prototypes)
        for name, expected in anchor_outputs.items():
            self.assertTrue(torch.equal(configured_outputs[name], expected), name)

        trainable_before = {
            name: value.detach().clone() for name, value in trainable.items()
        }
        optimizer = torch.optim.SGD(trainable.values(), lr=0.05)
        optimizer.zero_grad(set_to_none=True)
        outputs = model(query_views, prototypes)
        loss = (
            outputs["body_candidate_scores"].square().mean()
            + outputs["variant_candidate_scores"].square().mean()
        )
        loss.backward()
        self.assertTrue(all(value.grad is not None for value in trainable.values()))
        optimizer.step()

        with torch.inference_mode():
            changed_outputs = model(query_views, prototypes)
        self.assertTrue(
            torch.equal(
                changed_outputs["family_logits"], anchor_outputs["family_logits"]
            )
        )
        self.assertFalse(
            torch.equal(
                changed_outputs["body_candidate_scores"],
                anchor_outputs["body_candidate_scores"],
            )
        )
        self.assertFalse(
            torch.equal(
                changed_outputs["variant_candidate_scores"],
                anchor_outputs["variant_candidate_scores"],
            )
        )
        for name, expected in frozen_before.items():
            self.assertTrue(torch.equal(model.state_dict()[name], expected), name)
        self.assertTrue(
            any(
                not torch.equal(value.detach(), trainable_before[name])
                for name, value in trainable.items()
            )
        )

    def test_composite_producer_binds_exact_frozen_dependency_set_and_bytes(
        self,
    ) -> None:
        binding = trainer._producer_binding()
        dependencies = binding["frozen_dependencies"]
        self.assertEqual(set(trainer.FROZEN_DEPENDENCY_INVENTORY), set(dependencies))
        self.assertEqual(7, len(dependencies))
        for name, (expected_size, expected_sha) in sorted(
            trainer.FROZEN_DEPENDENCY_INVENTORY.items()
        ):
            self.assertEqual(
                {
                    "byte_size": expected_size,
                    "file_name": name,
                    "sha256": expected_sha,
                },
                dependencies[name],
            )

        first_name = sorted(trainer.FROZEN_DEPENDENCY_INVENTORY)[0]
        expected_size, expected_sha = trainer.FROZEN_DEPENDENCY_INVENTORY[first_name]
        drifts = (
            (expected_size + 1, expected_sha),
            (expected_size, "0" * 64),
        )
        for replacement in drifts:
            changed = dict(trainer.FROZEN_DEPENDENCY_INVENTORY)
            changed[first_name] = replacement
            with (
                self.subTest(replacement=replacement),
                mock.patch.object(trainer, "FROZEN_DEPENDENCY_INVENTORY", changed),
                self.assertRaisesRegex(
                    trainer.R23TrainingError, "frozen producer dependency drifted"
                ),
            ):
                trainer._producer_binding()

    def test_real_raw_marginal_ledger_reopens_exact_sealed_a_to_g_tiers(self) -> None:
        context = trainer.r21._load_context(
            trainer.r21.build_parser().parse_args(["preflight"]), torch
        )
        ledger = trainer.reconstruct_tier_ledger(
            trainer.DEFAULT_LABEL_DIR, context, enforce_real=True
        )
        self.assertEqual(trainer.EXPECTED_TIER_COUNTS, ledger["contract"]["counts"])
        self.assertEqual(1_600, ledger["contract"]["decision_record_count"])
        self.assertEqual(1_600, ledger["contract"]["private_binding_record_count"])
        self.assertEqual(1_347, len(ledger["rows"]))
        self.assertEqual(1_042, len(ledger["train"]))
        self.assertEqual(305, len(ledger["development_eval"]))
        self.assertEqual(
            "122e1a6b76084c2b2e378717d1e215957250be3e20345205e264d2e4ea0f9158",
            ledger["contract"]["inventory_sha256"],
        )
        source_roles = [value["role"] for value in ledger["contract"]["source_files"]]
        self.assertEqual(1, source_roles.count("sealed_labels"))
        self.assertEqual(1, source_roles.count("sealed_label_manifest"))
        self.assertEqual(8, source_roles.count("blind_decisions"))
        self.assertEqual(2, source_roles.count("private_bindings"))
        self.assertEqual(trainer.EXPECTED_AUTHORITY, ledger["contract"]["authority"])

        candidate_ids = tuple(ledger["candidate_ids"])
        single_day = candidate_ids.index("single-day")
        body_raw_preferred_single_day = 0
        variant_raw_marginal_single_day = 0
        variant_unreviewed_single_day = 0
        variant_safe_single_day = 0
        for row in ledger["rows"]:
            raw_masks = tuple(
                row[f"raw_{name}_mask"]
                for name in ("preferred", "acceptable", "marginal", "unacceptable")
            )
            raw_sum = sum(mask.astype(np.int8) for mask in raw_masks)
            self.assertTrue(
                np.array_equal(raw_sum, row["raw_eligible_mask"].astype(np.int8))
            )
            self.assertEqual(7, int(np.sum(row["raw_eligible_mask"])))
            self.assertFalse(bool((row["safe_mask"] & row["marginal_mask"]).any()))
            self.assertFalse(bool((row["safe_mask"] & row["unacceptable_mask"]).any()))
            self.assertFalse(
                bool((row["marginal_mask"] & row["unacceptable_mask"]).any())
            )
            self.assertFalse(bool(row["marginal_mask"][single_day]))

            ordinary_unreviewed = ~row["raw_eligible_mask"].copy()
            ordinary_unreviewed[single_day] = False
            effective = (
                row["safe_mask"] | row["marginal_mask"] | row["unacceptable_mask"]
            )
            self.assertFalse(bool(effective[ordinary_unreviewed].any()))
            if row["single_day_safety_negative"]:
                self.assertFalse(bool(row["safe_mask"][single_day]))
                if row["raw_eligible_mask"][single_day]:
                    self.assertTrue(bool(row["unacceptable_mask"][single_day]))
                else:
                    self.assertFalse(bool(row["unacceptable_mask"][single_day]))
            else:
                self.assertTrue(bool(row["safe_mask"][single_day]))

            is_body = row["family_label"] == v8.BODY_FAMILY_INDEX
            body_raw_preferred_single_day += bool(
                is_body and row["raw_preferred_mask"][single_day]
            )
            variant_raw_marginal_single_day += bool(
                not is_body and row["raw_marginal_mask"][single_day]
            )
            variant_unreviewed_single_day += bool(
                not is_body and row["single_day_raw_unreviewed"]
            )
            variant_safe_single_day += bool(
                not is_body and row["safe_mask"][single_day]
            )

        # These cases prove that Single Day safety is not a body-only or
        # reviewed-only shortcut and that raw marginal evidence was retained.
        self.assertEqual(67, body_raw_preferred_single_day)
        self.assertEqual(53, variant_raw_marginal_single_day)
        self.assertEqual(290, variant_unreviewed_single_day)
        self.assertEqual(129, variant_safe_single_day)

    def test_candidate_cache_epoch_zero_is_exact_and_nonzero_keeps_family_exact(
        self,
    ) -> None:
        anchor = self.production_shape_anchor()
        generator = torch.Generator().manual_seed(31)
        query_views = torch.randn(9, 3, 4, 256, generator=generator)
        prototypes = torch.randn(21, 4, 256, generator=generator)
        context = {
            "arrays": {
                "prototype_queries": prototypes.numpy(),
                "query_views": query_views.numpy(),
            },
            "candidate_ids": tuple(f"candidate-{index}" for index in range(21)),
            "model": anchor,
        }
        cache = trainer.build_candidate_cache(
            torch, context=context, device=torch.device("cpu"), batch_size=4
        )
        model = trainer.build_candidate_model(context, torch.device("cpu"))
        trainer.assert_epoch0_exact(torch, model, cache)
        indices = np.arange(9, dtype=np.int64)
        epoch_zero = trainer.candidate_outputs_from_cache(torch, model, cache, indices)
        for name in (
            "body_candidate_scores",
            "candidate_scores",
            "family_logits",
            "variant_candidate_scores",
        ):
            self.assertTrue(torch.equal(epoch_zero[name], cache[name]), name)
        self.assertTrue(
            torch.equal(
                epoch_zero["sample_candidate_residual_delta"],
                torch.zeros_like(epoch_zero["sample_candidate_residual_delta"]),
            )
        )

        with torch.no_grad():
            dict(model.named_parameters())["sample_candidate_residual.2.bias"].add_(
                torch.linspace(-0.2, 0.2, 42)
            )
        changed = trainer.candidate_outputs_from_cache(torch, model, cache, indices)
        self.assertTrue(torch.equal(changed["family_logits"], cache["family_logits"]))
        self.assertFalse(
            torch.equal(
                changed["body_candidate_scores"], cache["body_candidate_scores"]
            )
        )
        self.assertFalse(
            torch.equal(
                changed["variant_candidate_scores"],
                cache["variant_candidate_scores"],
            )
        )

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA is unavailable")
    def test_cpu_authority_cache_transferred_to_cuda_is_epoch_zero_bit_exact(
        self,
    ) -> None:
        anchor = self.production_shape_anchor()
        generator = torch.Generator().manual_seed(41)
        query_views = torch.randn(137, 3, 4, 256, generator=generator)
        prototypes = torch.randn(21, 4, 256, generator=generator)
        context = {
            "arrays": {
                "prototype_queries": prototypes.numpy(),
                "query_views": query_views.numpy(),
            },
            "candidate_ids": tuple(f"candidate-{index}" for index in range(21)),
            "model": anchor,
        }
        device = torch.device("cuda")
        cache = trainer.build_training_cache(
            torch, context=context, device=device, batch_size=32
        )
        model = trainer.build_candidate_model(context, device)
        trainer.assert_epoch0_exact(torch, model, cache)
        for count in (1, 7, 29, 128, 137):
            indices = np.arange(count, dtype=np.int64)
            outputs = trainer.candidate_outputs_from_cache(torch, model, cache, indices)
            for name in (
                "body_candidate_scores",
                "candidate_scores",
                "family_logits",
                "variant_candidate_scores",
            ):
                self.assertTrue(
                    torch.equal(outputs[name], cache[name][indices]),
                    f"{name} rows={count}",
                )
            self.assertEqual(
                0,
                int(torch.count_nonzero(outputs["sample_candidate_residual_delta"])),
            )
        with torch.no_grad():
            model.sample_candidate_residual[2].bias.add_(
                torch.linspace(-0.2, 0.2, 42, device=device)
            )
        indices = np.arange(137, dtype=np.int64)
        outputs = trainer.candidate_outputs_from_cache(torch, model, cache, indices)
        hidden = cache["hidden"]
        direct = torch.tanh(model.sample_candidate_residual[2](hidden)).reshape(
            137, 2, 21
        ) * float(model.maximum_sample_residual)
        self.assertTrue(torch.equal(outputs["sample_candidate_residual"], direct))
        self.assertEqual("cuda", cache["hidden"].device.type)
        self.assertEqual("cuda", next(model.parameters()).device.type)

    def test_ten_logo_folds_exclude_heldout_and_development_from_every_surface(
        self,
    ) -> None:
        context = trainer.r21._load_context(
            trainer.r21.build_parser().parse_args(["preflight"]), torch
        )
        ledger = trainer.reconstruct_tier_ledger(
            trainer.DEFAULT_LABEL_DIR, context, enforce_real=True
        )
        folds = trainer.build_logo_folds(context, ledger, enforce_real=True)
        self.assertEqual(10, len(folds))
        arrays = context["arrays"]
        work_ids = arrays["work_ids"].astype(str, copy=False)
        development_works = set(
            str(value)
            for value in context["overlay_binding"]["development_eval_work_ids"]
        )
        seen_heldout: set[str] = set()
        for expected_index, fold in enumerate(folds):
            heldout = str(fold["heldout_work_id"])
            seen_heldout.add(heldout)
            contract = fold["contract"]
            self.assertEqual(expected_index, contract["fold_index"])
            self.assertEqual(heldout, contract["heldout_work_id"])
            self.assertEqual(18, contract["active_work_family_strata_count"])
            self.assertEqual(9, len(contract["train_work_ids"]))
            self.assertEqual(0, contract["development_rows_consulted"])
            self.assertEqual(0, contract["page_optimizer_calls"])
            self.assertNotIn(heldout, contract["train_work_ids"])
            self.assertFalse(development_works & set(contract["train_work_ids"]))

            train_rows = tuple(fold["train_rows"])
            heldout_rows = tuple(fold["heldout_rows"])
            self.assertTrue(train_rows)
            self.assertTrue(heldout_rows)
            self.assertTrue(all(row["work_id"] != heldout for row in train_rows))
            self.assertTrue(all(row["work_id"] == heldout for row in heldout_rows))
            gradient_indices = np.asarray(fold["all_gradient_indices"], dtype=np.int64)
            base_indices = np.asarray(fold["base_indices"], dtype=np.int64)
            heldout_base = np.asarray(fold["heldout_base_indices"], dtype=np.int64)
            self.assertFalse(bool(np.any(work_ids[gradient_indices] == heldout)))
            self.assertFalse(
                bool(
                    np.any(np.isin(work_ids[gradient_indices], list(development_works)))
                )
            )
            self.assertTrue(bool(np.all(work_ids[heldout_base] == heldout)))
            self.assertFalse(
                set(base_indices.tolist()) & {row["row_index"] for row in train_rows}
            )

            train_page = tuple(fold["train_page_groups"])
            heldout_page = tuple(fold["heldout_page_groups"])
            self.assertEqual(68, len(train_page) + len(heldout_page))
            self.assertEqual(
                148,
                sum(len(group["row_indices"]) for group in train_page + heldout_page),
            )
            self.assertTrue(all(group["work_id"] != heldout for group in train_page))
            self.assertTrue(all(group["work_id"] == heldout for group in heldout_page))
            self.assertFalse(
                development_works
                & {str(group["work_id"]) for group in train_page + heldout_page}
            )
            args = trainer.build_parser().parse_args(
                ["preflight", "--marginal-mode", "isolated_lambda1_control"]
            )
            for epoch in range(1, args.epochs + 1):
                order, ordered_weights, schedule = trainer._direct_schedule(
                    fold, args, epoch=epoch
                )
                self.assertEqual(len(train_rows), len(order))
                self.assertEqual(len(train_rows), len(ordered_weights))
                self.assertEqual(18, schedule["active_fold_denominator"])
                self.assertTrue(
                    all(
                        stratum["scheduled_weight_sum"] == 1.0
                        for stratum in schedule["strata"]
                    )
                )
        self.assertEqual({str(row["work_id"]) for row in ledger["train"]}, seen_heldout)

        leaked = dict(ledger)
        leaked["train"] = tuple(ledger["train"]) + (ledger["development_eval"][0],)
        with self.assertRaises(trainer.R23TrainingError):
            trainer.build_logo_folds(context, leaked, enforce_real=False)

    @staticmethod
    def heldout_reports(
        *,
        safe: float,
        preferred: float,
        single_day: float = 0.0,
        unacceptable: float = 0.0,
        safety: bool = True,
    ) -> list[dict[str, object]]:
        return [
            {
                "checks": {"synthetic_safety": safety},
                "deltas": {
                    "preferred_top1_accuracy": preferred,
                    "safe_top1_accuracy": safe,
                    "single_day_unsafe_top1_rate": single_day,
                    "unacceptable_top1_rate": unacceptable,
                },
                "fold_index": fold_index,
            }
            for fold_index in range(10)
        ]

    def test_challenger_gate_and_three_plus_conditional_one_staging_are_fail_closed(
        self,
    ) -> None:
        control = {
            "manifest_record_sha256": "a" * 64,
            "oof_joint_minimum": 0.0,
        }
        boundary = trainer._aggregate_logo_metrics(
            self.heldout_reports(safe=0.005, preferred=0.005),
            control_contract=control,
        )
        self.assertFalse(boundary["logo_diagnostic_worth"])
        self.assertTrue(boundary["pilot_continuation"]["passed"])
        self.assertEqual(
            trainer.CHALLENGER_MINIMUM_JOINT_IMPROVEMENT,
            boundary["pilot_continuation"]["minimum_required_improvement"],
        )
        below = trainer._aggregate_logo_metrics(
            self.heldout_reports(safe=0.0049, preferred=0.008),
            control_contract=control,
        )
        self.assertFalse(below["pilot_continuation"]["passed"])
        unsafe_single_day = trainer._aggregate_logo_metrics(
            self.heldout_reports(safe=0.03, preferred=0.03, single_day=0.001),
            control_contract=control,
        )
        self.assertFalse(unsafe_single_day["pilot_continuation"]["passed"])
        unsafe_fold = trainer._aggregate_logo_metrics(
            self.heldout_reports(safe=0.03, preferred=0.03, safety=False),
            control_contract=control,
        )
        self.assertFalse(unsafe_fold["pilot_continuation"]["passed"])
        worthy = trainer._aggregate_logo_metrics(
            self.heldout_reports(safe=0.02, preferred=0.02),
            control_contract=control,
        )
        self.assertTrue(worthy["logo_diagnostic_worth"])
        self.assertTrue(worthy["pilot_continuation"]["passed"])

        isolated = trainer._aggregate_logo_metrics(
            self.heldout_reports(safe=0.0, preferred=0.0),
            control_contract=None,
        )
        self.assertIsNone(isolated["pilot_continuation"])
        contract = trainer._experiment_contract()
        self.assertEqual(
            list(trainer.MARGINAL_MODES), contract["first_screen"]["allowed_cells"]
        )
        self.assertEqual(0.0, contract["first_screen"]["page_js_weight"])
        self.assertEqual(
            [20260821, 20260822],
            contract["later_confirmation"]["future_schedule_seeds"],
        )
        self.assertTrue(
            contract["later_confirmation"]["all_seeds_must_pass_before_page_js_0_01"]
        )
        self.assertTrue(
            contract["later_confirmation"][
                "allowed_only_after_seed20260820_challenger_pass"
            ]
        )

    def test_candidate_metrics_route_by_family_and_separate_single_day_from_unreviewed(
        self,
    ) -> None:
        candidate_ids = (
            "safe-a",
            "safe-b",
            "marginal",
            "unacceptable",
            "ordinary-unreviewed",
            "single-day",
        )
        body = torch.full((4, 6), -2.0)
        variant = torch.full((4, 6), -2.0)
        body[0, 0] = 2.0
        variant[1, 5] = 2.0
        body[2, 3] = 2.0
        variant[3, 4] = 2.0
        safe = np.asarray([1, 1, 0, 0, 0, 0], dtype=np.bool_)
        preferred = np.asarray([1, 0, 0, 0, 0, 0], dtype=np.bool_)
        marginal = np.asarray([0, 0, 1, 0, 0, 0], dtype=np.bool_)
        unacceptable = np.asarray([0, 0, 0, 1, 0, 0], dtype=np.bool_)
        rows = tuple(
            {
                "family_label": family,
                "marginal_mask": marginal,
                "preferred_mask": preferred
                if index < 3
                else np.zeros(6, dtype=np.bool_),
                "row_index": index,
                "safe_mask": safe,
                "single_day_safety_negative": index == 1,
                "unacceptable_mask": unacceptable,
                "work_id": "work-a" if index < 2 else "work-b",
            }
            for index, family in enumerate(
                (
                    v8.BODY_FAMILY_INDEX,
                    v8.VARIANT_FAMILY_INDEX,
                    v8.BODY_FAMILY_INDEX,
                    v8.VARIANT_FAMILY_INDEX,
                )
            )
        )
        outputs = {
            "body_candidate_scores": body,
            "family_logits": torch.zeros(4, 2),
            "variant_candidate_scores": variant,
        }
        with mock.patch.object(
            trainer, "candidate_outputs_from_cache", return_value=outputs
        ):
            metrics = trainer.candidate_metrics(
                torch,
                object(),
                cache={"hidden": torch.zeros(4, 64)},
                rows=rows,
                candidate_ids=candidate_ids,
            )
        row = metrics["row"]
        self.assertEqual(0.25, row["safe_top1_accuracy"])
        self.assertAlmostEqual(1.0 / 3.0, row["preferred_top1_accuracy"])
        self.assertEqual(0.0, row["marginal_top1_rate"])
        self.assertEqual(0.25, row["unacceptable_top1_rate"])
        self.assertEqual(0.25, row["ordinary_unreviewed_top1_rate"])
        self.assertEqual(1.0, row["single_day_unsafe_top1_rate"])
        work = metrics["work_macro"]
        self.assertEqual(2, work["work_count"])
        self.assertEqual(0.25, work["safe_top1_accuracy"])
        self.assertEqual(0.25, work["preferred_top1_accuracy"])
        self.assertEqual(0.25, work["ordinary_unreviewed_top1_rate"])
        self.assertEqual(0.25, work["unacceptable_top1_rate"])
        self.assertEqual(0.5, work["single_day_unsafe_top1_rate"])

    def test_synthetic_train_strict_validate_tamper_reparse_and_mutual_schema(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            context, ledger, synthetic = self.synthetic_training_inputs(root)
            paths = synthetic["paths"]
            context_contract = synthetic["contract"]
            output = root / "output"
            training_device = "cuda" if torch.cuda.is_available() else "cpu"
            args = trainer.build_parser().parse_args(
                [
                    "train",
                    "--marginal-mode",
                    "isolated_lambda1_control",
                    "--base-npz",
                    str(paths["base_path"]),
                    "--overlay-dir",
                    str(paths["overlay_dir"]),
                    "--anchor-adapter-dir",
                    str(paths["anchor_dir"]),
                    "--source-query-head",
                    str(paths["source_path"]),
                    "--source-label-dir",
                    str(paths["label_dir"]),
                    "--output-dir",
                    str(output),
                    "--device",
                    training_device,
                ]
            )
            base_metrics = self.synthetic_base_metrics()
            original_build_logo_folds = trainer.build_logo_folds

            def page_metrics(
                _torch: object,
                _model: object,
                *,
                cache: object,
                groups: object,
                candidate_ids: object,
            ) -> dict[str, object]:
                del cache, candidate_ids
                selected = tuple(groups)
                return {
                    "all_rows_top1_in_common_positive_rate": 0.5,
                    "group_count": len(selected),
                    "mean_body_probability": 0.5,
                    "mean_common_positive_mass": 0.5,
                    "mean_js": 0.1,
                    "predicted_body_rate": 0.5,
                    "row_count": sum(len(group["row_indices"]) for group in selected),
                    "top1_all_agree_rate": 0.5,
                }

            patches = (
                mock.patch.object(trainer, "_load_context", return_value=context),
                mock.patch.object(
                    trainer, "reconstruct_tier_ledger", return_value=ledger
                ),
                mock.patch.object(
                    trainer.r0,
                    "_base_train_indices",
                    return_value=np.arange(40, dtype=np.int64),
                ),
                mock.patch.object(
                    trainer.r0, "_context_contract", return_value=context_contract
                ),
                mock.patch.object(
                    trainer,
                    "evaluate_base_metrics",
                    side_effect=lambda *_args, **_kwargs: copy.deepcopy(base_metrics),
                ),
                mock.patch.object(
                    trainer, "_base_regression", return_value={"synthetic": True}
                ),
                mock.patch.object(trainer, "_page_metrics", side_effect=page_metrics),
                mock.patch.object(
                    trainer,
                    "build_logo_folds",
                    side_effect=lambda selected_context, selected_ledger, **_kwargs: (
                        original_build_logo_folds(
                            selected_context, selected_ledger, enforce_real=False
                        )
                    ),
                ),
            )
            with (
                patches[0],
                patches[1],
                patches[2],
                patches[3],
                patches[4],
                patches[5],
                patches[6],
                patches[7],
            ):
                result = trainer.train(args)
                self.assertEqual(trainer.SCHEMA_VERSION, result["schema_version"])
                self.assertEqual("isolated_lambda1_control", result["marginal_mode"])
                self.assertTrue(result["nonpromotable"])
                validated = trainer.validate_output(
                    output, require_external_sources=False
                )
                self.assertEqual(
                    result["manifest_record_sha256"],
                    validated["manifest_record_sha256"],
                )

                manifest_path = output / trainer.MANIFEST_FILE
                marker_path = output / trainer.MARKER_FILE
                original_manifest = manifest_path.read_bytes()
                original_marker = marker_path.read_bytes()
                manifest = json.loads(original_manifest.decode("utf-8"))
                marker = json.loads(original_marker.decode("utf-8"))
                self.assertEqual(training_device, manifest["configuration"]["device"])
                self.assertEqual(
                    "cpu_authority",
                    manifest["architecture"][
                        "training_metric_and_checkpoint_selection_device"
                    ],
                )
                self.assertEqual(trainer._producer_binding(), manifest["producer"])
                self.assertEqual(trainer._producer_binding(), marker["producer"])
                self.assertEqual(10, len(manifest["folds"]))
                self.assertEqual(10, len(manifest["files"]))
                self.assertIsNone(manifest["comparison_control"])
                self.assertFalse(
                    manifest["development_boundary"][
                        "development_cache_outputs_paired_with_tiers"
                    ]
                )
                self.assertFalse(
                    manifest["development_boundary"][
                        "development_candidate_metrics_computed"
                    ]
                )
                self.assertFalse(
                    manifest["development_boundary"][
                        "development_outputs_used_for_gradient"
                    ]
                )
                self.assertFalse(
                    manifest["development_boundary"][
                        "development_outputs_used_for_checkpoint_selection"
                    ]
                )
                self.assertTrue(
                    manifest["development_boundary"][
                        "frozen_anchor_cache_materialized_for_all_base_rows"
                    ]
                )
                self.assertTrue(
                    manifest["development_boundary"][
                        "tier_sources_reconstructed_for_exact_inventory_only"
                    ]
                )
                self.assertEqual(0, manifest["development_boundary"]["gradient_rows"])
                self.assertTrue(
                    all(
                        not fold["selection"]["heldout_consulted_for_selection"]
                        and not fold["selection"]["development_eval_consulted"]
                        and fold["selection"]["page_optimizer_calls"] == 0
                        for fold in manifest["folds"]
                    )
                )
                self.assertTrue(
                    all(
                        fold["heldout_postselection"][
                            "heldout_consulted_after_fold_winner_only"
                        ]
                        and not fold["heldout_postselection"][
                            "heldout_used_for_fold_epoch_selection"
                        ]
                        for fold in manifest["folds"]
                    )
                )

                def reseal(value: dict[str, object]) -> dict[str, object]:
                    core = copy.deepcopy(value)
                    core.pop("record_sha256", None)
                    return trainer.seal_record(core)

                def write_manifest_and_marker(
                    changed_manifest: dict[str, object],
                    changed_marker: dict[str, object] | None = None,
                ) -> None:
                    sealed_manifest = reseal(changed_manifest)
                    manifest_path.write_bytes(
                        trainer.json_bytes(sealed_manifest, pretty=True)
                    )
                    marker_value = copy.deepcopy(
                        marker if changed_marker is None else changed_marker
                    )
                    marker_value["artifacts"][trainer.MANIFEST_FILE] = (
                        trainer.sha256_file(manifest_path)
                    )
                    marker_path.write_bytes(
                        trainer.json_bytes(reseal(marker_value), pretty=True)
                    )

                tampers = []
                changed = copy.deepcopy(manifest)
                changed["configuration"]["marginal_lambda"] = 0.25
                tampers.append(changed)
                changed = copy.deepcopy(manifest)
                changed["configuration"]["device"] = "evil"
                tampers.append(changed)
                changed = copy.deepcopy(manifest)
                changed["development_boundary"][
                    "development_candidate_metrics_computed"
                ] = True
                tampers.append(changed)
                changed = copy.deepcopy(manifest)
                changed["source_tier_ledger"]["counts"]["synthetic"] = False
                tampers.append(changed)
                changed = copy.deepcopy(manifest)
                changed["folds"][0]["history"][0]["checkpoint_selection_inputs"] = [
                    "development_eval"
                ]
                tampers.append(changed)
                for changed in tampers:
                    write_manifest_and_marker(changed)
                    with self.assertRaises(trainer.R23TrainingError):
                        trainer.validate_output(output, require_external_sources=False)

                changed_manifest = copy.deepcopy(manifest)
                changed_marker = copy.deepcopy(marker)
                changed_manifest["producer"]["byte_size"] += 1
                changed_marker["producer"]["byte_size"] += 1
                write_manifest_and_marker(changed_manifest, changed_marker)
                with self.assertRaisesRegex(trainer.R23TrainingError, "producer"):
                    trainer.validate_output(output, require_external_sources=False)

                manifest_path.write_bytes(original_manifest)
                marker_path.write_bytes(original_marker)
                from safetensors.torch import load_file, save_file

                sidecar_name = trainer._sidecar_name(0)
                sidecar_path = output / sidecar_name
                original_sidecar = sidecar_path.read_bytes()
                changed_state = {
                    name: value.clone()
                    for name, value in load_file(str(sidecar_path)).items()
                }
                changed_state["sample_candidate_residual.2.bias"][0] += 0.125
                save_file(changed_state, str(sidecar_path))
                coherent = copy.deepcopy(manifest)
                coherent["files"][sidecar_name] = {
                    "byte_size": sidecar_path.stat().st_size,
                    "sha256": trainer.sha256_file(sidecar_path),
                    "tensor_inventory": trainer._tensor_inventory(changed_state),
                }
                coherent_marker = copy.deepcopy(marker)
                coherent_marker["artifacts"][sidecar_name] = trainer.sha256_file(
                    sidecar_path
                )
                write_manifest_and_marker(coherent, coherent_marker)
                with self.assertRaisesRegex(trainer.R23TrainingError, "selected state"):
                    trainer.validate_output(output, require_external_sources=False)

                sidecar_path.write_bytes(original_sidecar)
                manifest_path.write_bytes(original_manifest)
                marker_path.write_bytes(original_marker)
                self.assertEqual(
                    validated["manifest_record_sha256"],
                    trainer.validate_output(output, require_external_sources=False)[
                        "manifest_record_sha256"
                    ],
                )

                changed_current_producer = {
                    **trainer._producer_binding(),
                    "byte_size": trainer._producer_binding()["byte_size"] + 1,
                }
                with (
                    mock.patch.object(
                        trainer,
                        "_producer_binding",
                        return_value=changed_current_producer,
                    ),
                    self.assertRaisesRegex(trainer.R23TrainingError, "producer"),
                ):
                    trainer.validate_output(output, require_external_sources=False)

                with self.assertRaises(trainer.r21.R21TrainingError):
                    trainer.r21.validate_output(output)
                old_outputs = sorted(
                    Path("artifacts").glob(
                        "manga-font-v3-family-residual-r22-concat-logo-*"
                    )
                )
                self.assertTrue(old_outputs)
                with self.assertRaises(trainer.R23TrainingError):
                    trainer.validate_output(
                        old_outputs[0], require_external_sources=False
                    )

            with (
                mock.patch.object(
                    trainer.overlay_v3,
                    "_path_or_ancestor_is_link_or_reparse",
                    return_value=True,
                ),
                self.assertRaisesRegex(trainer.R23TrainingError, "linked or reparsed"),
            ):
                trainer.validate_output(
                    Path("synthetic-linked-r23-output"),
                    require_external_sources=False,
                )

    def test_weighted_set_nll_algebra_gradients_and_lambda1_exact_control(self) -> None:
        scores = torch.tensor(
            [
                [0.30, -0.20, 0.70, 1.10, -0.60, 0.40],
                [-0.40, 0.25, 0.55, -0.10, 0.90, -0.35],
                [0.15, -0.45, 0.05, 0.65, -0.75, 0.20],
            ],
            dtype=torch.float32,
            requires_grad=True,
        )
        safe = torch.tensor(
            [
                [1, 1, 0, 0, 0, 0],
                [1, 1, 0, 0, 0, 0],
                [1, 1, 0, 0, 0, 0],
            ],
            dtype=torch.bool,
        )
        preferred = torch.tensor(
            [
                [1, 0, 0, 0, 0, 0],
                [0, 1, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0],
            ],
            dtype=torch.bool,
        )
        marginal = torch.tensor(
            [
                [0, 0, 1, 0, 0, 0],
                [0, 0, 1, 0, 0, 0],
                [0, 0, 1, 0, 0, 0],
            ],
            dtype=torch.bool,
        )
        unacceptable = torch.tensor(
            [
                [0, 0, 0, 1, 0, 0],
                [0, 0, 0, 1, 0, 0],
                [0, 0, 0, 1, 0, 0],
            ],
            dtype=torch.bool,
        )
        row_weights = torch.tensor([0.7, 1.3, 0.9], dtype=torch.float32)
        safety = torch.tensor([False, True, False])

        def independent_reference(value: torch.Tensor, lam: float) -> torch.Tensor:
            denominator_mass = (
                (value.exp() * safe).sum(dim=1)
                + lam * (value.exp() * marginal).sum(dim=1)
                + (value.exp() * unacceptable).sum(dim=1)
            )
            safe_mass = (value.exp() * safe).sum(dim=1)
            safe_losses = denominator_mass.log() - safe_mass.log()
            safe_loss = (safe_losses * row_weights).sum() / row_weights.sum()
            preferred_rows = preferred.any(dim=1)
            preferred_mass = (value.exp() * preferred).sum(dim=1)
            preferred_losses = (
                denominator_mass[preferred_rows].log()
                - preferred_mass[preferred_rows].log()
            )
            preferred_loss = (
                preferred_losses * row_weights[preferred_rows]
            ).sum() / row_weights[preferred_rows].sum()
            return (
                trainer.SAFE_WEIGHT * safe_loss
                + trainer.PREFERENCE_WEIGHT * preferred_loss
            )

        for marginal_weight in (0.0, 0.25, 1.0):
            with self.subTest(marginal_weight=marginal_weight):
                actual, components = trainer.weighted_candidate_set_loss(
                    torch,
                    scores,
                    preferred_mask=preferred,
                    safe_mask=safe,
                    marginal_mask=marginal,
                    unacceptable_mask=unacceptable,
                    single_day_safety_negative=safety,
                    marginal_weight=marginal_weight,
                    row_weights=row_weights,
                )
                expected = independent_reference(scores, marginal_weight)
                self.assertTrue(torch.allclose(actual, expected, atol=5e-7, rtol=0.0))
                self.assertEqual(
                    0.0,
                    float(components["candidate_distribution_excess"].detach()),
                )
                self.assertEqual(marginal_weight, components["marginal_lambda"])
                self.assertEqual(1, int(components["single_day_safety_negative_rows"]))
                actual_gradient = torch.autograd.grad(
                    actual, scores, retain_graph=True
                )[0]
                expected_gradient = torch.autograd.grad(
                    expected, scores, retain_graph=True
                )[0]
                self.assertTrue(
                    torch.allclose(
                        actual_gradient, expected_gradient, atol=5e-7, rtol=0.0
                    )
                )
                self.assertTrue(torch.equal(actual_gradient[:, 4], torch.zeros(3)))
                if marginal_weight == 0.0:
                    self.assertTrue(torch.equal(actual_gradient[:, 2], torch.zeros(3)))
                else:
                    self.assertTrue(bool((actual_gradient[:, 2] > 0).all()))
                self.assertTrue(bool((actual_gradient[:, 3] > 0).all()))

        lambda1, _ = trainer.weighted_candidate_set_loss(
            torch,
            scores,
            preferred_mask=preferred,
            safe_mask=safe,
            marginal_mask=marginal,
            unacceptable_mask=unacceptable,
            single_day_safety_negative=safety,
            marginal_weight=1.0,
            row_weights=row_weights,
        )
        eligible = safe | marginal | unacceptable
        current_safe = v8.multi_positive_candidate_loss(
            torch,
            scores,
            safe,
            eligible_mask=eligible,
            row_weights=row_weights,
        )
        preferred_rows = preferred.any(dim=1)
        current_preferred = v8.multi_positive_candidate_loss(
            torch,
            scores[preferred_rows],
            preferred[preferred_rows],
            eligible_mask=eligible[preferred_rows],
            row_weights=row_weights[preferred_rows],
        )
        current_core = (
            trainer.PREFERENCE_WEIGHT * current_preferred
            + trainer.SAFE_WEIGHT * current_safe
        )
        self.assertTrue(torch.equal(lambda1, current_core))

    def test_single_day_safety_is_fixed_for_body_and_variant_at_lambda_zero(
        self,
    ) -> None:
        body_scores = torch.tensor(
            [[0.0, -0.5, 0.2, 0.8], [0.1, -0.4, 0.3, 0.9]],
            dtype=torch.float32,
            requires_grad=True,
        )
        variant_scores = torch.tensor(
            [[0.2, -0.3, 0.1, 0.7], [0.0, -0.2, 0.4, 1.0]],
            dtype=torch.float32,
            requires_grad=True,
        )
        safe = torch.tensor([[1, 0, 0, 0], [1, 0, 0, 0]], dtype=torch.bool)
        preferred = safe.clone()
        # Candidate 1 is a mutable marginal. Candidate 2 is ordinary unreviewed;
        # candidate 3 is Single Day and is intentionally outside the core masks.
        marginal = torch.tensor([[0, 1, 0, 0], [0, 1, 0, 0]], dtype=torch.bool)
        unacceptable = torch.zeros_like(safe)
        safety = torch.tensor([True, True])
        weights = torch.tensor([0.75, 1.25], dtype=torch.float32)
        labels = torch.tensor(
            [v8.BODY_FAMILY_INDEX, v8.VARIANT_FAMILY_INDEX], dtype=torch.int64
        )

        routed_scores = torch.where(
            labels[:, None] == v8.BODY_FAMILY_INDEX,
            body_scores,
            variant_scores,
        )
        core, _ = trainer.weighted_candidate_set_loss(
            torch,
            routed_scores,
            preferred_mask=preferred,
            safe_mask=safe,
            marginal_mask=marginal,
            unacceptable_mask=unacceptable,
            single_day_safety_negative=safety,
            marginal_weight=0.0,
            row_weights=weights,
        )
        auxiliary = trainer._single_day_safety_losses(
            torch,
            {
                "body_candidate_scores": body_scores,
                "variant_candidate_scores": variant_scores,
            },
            safe_mask=safe,
            family_labels=labels,
            safety_negative=safety,
            row_weights=weights,
            single_day_index=3,
        )
        self.assertEqual(2, int(auxiliary["supervised_negative_rows"]))
        self.assertEqual(1, int(auxiliary["body_negative_rows"]))
        total = (
            core
            + trainer.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT
            * auxiliary["body_hard_negative"]
            + trainer.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
            * auxiliary["supervised_hard_negative"]
        )
        total.backward()

        # The fixed safety auxiliary reaches both score branches for both
        # family rows; changing marginal lambda cannot disable it.
        self.assertTrue(bool((body_scores.grad[:, 3] > 0).all()))
        self.assertTrue(bool((variant_scores.grad[:, 3] > 0).all()))
        self.assertTrue(torch.equal(body_scores.grad[:, 2], torch.zeros(2)))
        self.assertTrue(torch.equal(variant_scores.grad[:, 2], torch.zeros(2)))


if __name__ == "__main__":
    unittest.main()
