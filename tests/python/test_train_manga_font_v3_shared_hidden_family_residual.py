from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch
from safetensors.torch import save_file

from scripts import train_manga_font_student_v8_role_family_adapter as v8
from scripts import train_manga_font_v3_shared_hidden_family_residual as trainer


class MangaFontV3SharedHiddenFamilyResidualTests(unittest.TestCase):
    def anchor(self, candidate_count: int = 3) -> torch.nn.Module:
        torch.manual_seed(7)
        model = v8.build_role_family_adapter(
            torch,
            candidate_count=candidate_count,
            maximum_family_bias=0.1,
            candidate_residual_hidden_dim=trainer.EXPECTED_HIDDEN_DIM,
            maximum_sample_residual=0.75,
        )
        with torch.no_grad():
            model.sample_candidate_residual[2].weight.normal_(0.0, 0.03)
            model.sample_candidate_residual[2].bias.normal_(0.0, 0.03)
        return model.eval()

    def inputs(self, candidate_count: int = 3) -> tuple[torch.Tensor, torch.Tensor]:
        generator = torch.Generator().manual_seed(19)
        return (
            torch.randn(5, 3, 4, 256, generator=generator),
            torch.randn(candidate_count, 4, 256, generator=generator),
        )

    def base_metrics(self, family: float = 0.9) -> dict[str, object]:
        return {
            "all": {
                "acceptable_at1": 0.7,
                "family_accuracy": family,
                "preferred_at1": 0.6,
                "single_day_body_false_top1_count": 0,
            },
            "quality_checks": {"synthetic": True},
            "quality_gate_passed": True,
            "visual": {
                "acceptable_at1": 0.7,
                "family_accuracy": family,
                "preferred_at1": 0.6,
                "single_day_body_false_top1_count": 0,
            },
        }

    def training_metrics(self, score: float = 0.5) -> dict[str, object]:
        row = {
            "accuracy": score,
            "balanced_accuracy": score,
            "body_accuracy": score,
            "body_rows": 1,
            "mean_body_probability": score,
            "predicted_body_rate": score,
            "row_count": 2,
            "variant_accuracy": score,
            "variant_rows": 1,
        }
        work = {
            "accuracy": score,
            "balanced_accuracy": score,
            "body_accuracy": score,
            "mean_body_probability": score,
            "per_work": {"work": row},
            "predicted_body_rate": score,
            "variant_accuracy": score,
            "work_count": 1,
        }
        return {
            "direct_family": {"row": row, "work_macro": work},
            "margin": {
                "maximum_absolute_margin": 0.0,
                "mean_absolute_margin": 0.0,
                "quantiles": {
                    "p00": 0.0,
                    "p10": 0.0,
                    "p25": 0.0,
                    "p50": 0.0,
                    "p75": 0.0,
                    "p90": 0.0,
                    "p100": 0.0,
                },
                "row_count": 2,
                "saturation_rate_at_95pct_budget": 0.0,
            },
            "page_consistency": {
                "all_rows_top1_in_common_positive_rate": score,
                "group_count": 1,
                "mean_body_probability": score,
                "mean_common_positive_mass": score,
                "mean_js": 0.2,
                "predicted_body_rate": score,
                "row_count": 2,
                "top1_all_agree_rate": score,
            },
        }

    def history_record(
        self,
        model: torch.nn.Module,
        *,
        epoch: int,
        score: float,
        family: float = 0.9,
    ) -> dict[str, object]:
        state = trainer._state_payload(trainer._sidecar_state(model))
        base = self.base_metrics(family)
        regression = {
            name: True for name in trainer.page_v3.EXPECTED_BASE_REGRESSION_CHECKS
        }
        record: dict[str, object] = {
            "base_metrics": base,
            "base_no_material_regression": True,
            "base_regression_checks": regression,
            "batch_consumption": trainer._expected_batch_consumption(
                epoch=epoch,
                base_rows=2,
                direct_work_ids=np.asarray(["work", "work"]),
                page_work_ids=np.asarray(["work", "work"]),
                batch_size=2,
                seed=7,
            ),
            "checkpoint_selection_inputs": list(trainer.CHECKPOINT_SELECTION_INPUTS),
            "development_eval_consulted": False,
            "epoch": epoch,
            "sidecar_state": state,
            "sidecar_state_sha256": trainer.hashlib.sha256(
                trainer.canonical_json(state).encode("utf-8")
            ).hexdigest(),
            "training_only_selection_metrics": self.training_metrics(score),
        }
        if epoch > 0:
            record["mean_train_losses"] = {
                objective: {
                    "anchor_kl": 0.1,
                    "family_ce": 0.2,
                    "residual_l2": 0.01,
                    "total": 0.3,
                }
                for objective in ("base", "direct_family", "page_body")
            }
        return record

    def test_zero_init_is_exact_anchor_for_all_candidate_outputs(self) -> None:
        anchor = self.anchor()
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=anchor, maximum_margin=2.0
        )
        queries, prototypes = self.inputs()
        with torch.inference_mode():
            expected = anchor(queries, prototypes)
            actual = model(queries, prototypes)
        for name in (
            "body_candidate_scores",
            "candidate_scores",
            "variant_candidate_scores",
            "family_logits",
        ):
            self.assertTrue(torch.equal(expected[name], actual[name]), name)
        self.assertEqual(0.0, float(actual["family_margin_delta"].abs().max()))

    def test_nonzero_head_keeps_candidate_outputs_byte_exact(self) -> None:
        anchor = self.anchor()
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=anchor, maximum_margin=2.0
        )
        with torch.no_grad():
            model.family_margin_head.weight.fill_(0.05)
            model.family_margin_head.bias.fill_(0.2)
        queries, prototypes = self.inputs()
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
        adjustment = actual["family_logit_adjustment"]
        self.assertTrue(torch.equal(adjustment[:, 0], -adjustment[:, 1]))
        self.assertTrue(bool((actual["family_margin_delta"].abs() < 2.0).all()))

        family_top1 = actual["family_logits"].argmax(dim=1)
        hard_routed_scores = torch.where(
            (family_top1 == v8.BODY_FAMILY_INDEX)[:, None],
            actual["body_candidate_scores"],
            actual["variant_candidate_scores"],
        )
        self.assertFalse(torch.equal(hard_routed_scores, actual["candidate_scores"]))
        self.assertEqual(
            "frozen_anchor_soft_gate_mixture_compatibility_only_not_evaluated",
            trainer.EXPECTED_RUNTIME_BOUNDARY["internal_candidate_scores_semantics"],
        )
        self.assertEqual(
            "body_candidate_scores_alias",
            trainer.EXPECTED_RUNTIME_BOUNDARY["public_onnx_candidate_scores_semantics"],
        )
        self.assertEqual(
            "hard_family_argmax_then_body_or_variant_branch",
            trainer.EXPECTED_RUNTIME_BOUNDARY["strict_metric_score_route"],
        )

    def test_bound_has_unit_zero_derivative_for_every_budget(self) -> None:
        for budget in trainer.MAX_MARGIN_CHOICES:
            raw = torch.tensor([0.0], requires_grad=True)
            bounded = trainer.bounded_margin(torch, raw, budget)
            bounded.sum().backward()
            self.assertEqual(1.0, float(raw.grad.item()))
            extremes = trainer.bounded_margin(torch, torch.tensor([-1e6, 1e6]), budget)
            self.assertTrue(bool((extremes.abs() <= budget).all()))
            self.assertEqual(-budget, float(extremes[0]))
            self.assertEqual(budget, float(extremes[1]))

    def test_optimizer_can_change_only_two_sidecar_tensors(self) -> None:
        anchor = self.anchor()
        anchor_before = {
            name: value.detach().clone() for name, value in anchor.state_dict().items()
        }
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=anchor, maximum_margin=1.0
        )
        optimizer = torch.optim.SGD(model.family_margin_head.parameters(), lr=0.01)
        queries, prototypes = self.inputs()
        loss = model(queries, prototypes)["family_logits"][:, 0].sum()
        loss.backward()
        optimizer.step()
        self.assertTrue(
            any(
                bool(torch.count_nonzero(value))
                for value in trainer._sidecar_state(model).values()
            )
        )
        for name, value in anchor.state_dict().items():
            self.assertEqual(
                anchor_before[name].numpy().tobytes(), value.numpy().tobytes(), name
            )
        self.assertFalse(
            any(parameter.requires_grad for parameter in anchor.parameters())
        )

    def test_sidecar_inventory_is_exact_and_rejects_extra_tensor(self) -> None:
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=self.anchor(), maximum_margin=2.0
        )
        state = trainer._sidecar_state(model)
        payload = trainer._state_payload(state)
        restored = trainer._state_from_payload(torch, payload)
        self.assertEqual(set(trainer.EXPECTED_SIDECAR_TENSORS), set(restored))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sidecar.safetensors"
            save_file({**state, "unexpected": torch.zeros(1)}, str(path))
            with self.assertRaisesRegex(
                trainer.SharedHiddenFamilyResidualError, "inventory"
            ):
                trainer._load_sidecar_state(torch, path)

    def test_state_snapshot_does_not_alias_live_cpu_parameters(self) -> None:
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=self.anchor(), maximum_margin=2.0
        )
        snapshot = trainer._sidecar_state(model)
        with torch.no_grad():
            model.family_margin_head.bias.fill_(1.0)
        self.assertEqual(0.0, float(snapshot["family_margin_head.bias"][0]))

    def test_selection_prioritizes_work_macro_before_row_metrics(self) -> None:
        base = self.base_metrics()
        checks = {
            name: True for name in trainer.page_v3.EXPECTED_BASE_REGRESSION_CHECKS
        }
        left = self.training_metrics(0.5)
        right = copy.deepcopy(left)
        right["direct_family"]["row"]["balanced_accuracy"] = 0.99
        right["direct_family"]["row"]["body_accuracy"] = 0.99
        left["direct_family"]["work_macro"]["balanced_accuracy"] = 0.51
        self.assertGreater(
            trainer._selection_key(base, checks, left),
            trainer._selection_key(base, checks, right),
        )

    def test_auxiliary_batches_are_deterministically_work_balanced(self) -> None:
        work_ids = np.asarray(["a"] * 5 + ["b"] * 2 + ["c"])
        batches, contract = trainer._work_balanced_batches(
            work_ids, batch_size=6, seed=31
        )
        repeated, repeated_contract = trainer._work_balanced_batches(
            work_ids, batch_size=6, seed=31
        )
        self.assertEqual(contract, repeated_contract)
        self.assertEqual(3, contract["batch_count"])
        self.assertEqual(18, contract["effective_rows"])
        self.assertEqual(10, contract["oversampled_rows"])
        self.assertEqual(2, contract["rows_per_work_per_batch"])
        self.assertEqual(
            "each_work_sum_one_per_batch",
            contract["supervision_weight_normalization"],
        )
        for batch, again in zip(batches, repeated, strict=True):
            self.assertTrue(np.array_equal(batch, again))
            selected_works = work_ids[batch]
            self.assertEqual(
                {"a": 2, "b": 2, "c": 2},
                {
                    work_id: int(np.sum(selected_works == work_id))
                    for work_id in ("a", "b", "c")
                },
            )
            normalized = trainer._normalize_work_weights(
                np.linspace(0.5, 2.0, len(batch), dtype=np.float32),
                selected_works,
            )
            for work_id in ("a", "b", "c"):
                self.assertAlmostEqual(
                    1.0, float(normalized[selected_works == work_id].sum()), places=6
                )

    def test_strict_history_recomputes_metrics_and_epoch_zero_wins_tie(self) -> None:
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=self.anchor(), maximum_margin=2.0
        )
        epoch0 = self.history_record(model, epoch=0, score=0.5)
        epoch1 = self.history_record(model, epoch=1, score=0.5)
        configuration = {
            "epochs": 1,
            "batch_size": 2,
            "maximum_acceptable_regression": 0.01,
            "maximum_preferred_regression": 0.01,
            "maximum_family_regression": 0.01,
            "seed": 7,
        }
        context = {
            "arrays": {},
            "candidate_ids": ("a", "b", "single-day"),
            "groups": {
                "direct_family": {"train": [{"work_id": "work"}, {"work_id": "work"}]},
                "train": [{"row_indices": np.asarray([0, 1]), "work_id": "work"}],
            },
        }
        cache = {"hidden": torch.zeros(2, trainer.EXPECTED_HIDDEN_DIM)}
        with (
            mock.patch.object(
                trainer,
                "_evaluate_base_from_cache",
                return_value=self.base_metrics(),
            ),
            mock.patch.object(
                trainer,
                "_training_metrics",
                return_value=self.training_metrics(0.5),
            ),
        ):
            best, _state, _record = trainer._strict_history_recompute(
                torch,
                manifest={"history": [epoch0, epoch1]},
                configuration=configuration,
                model=model,
                cache=cache,
                context=context,
                base_indices=np.asarray([0, 1]),
                anchor_base_metrics=self.base_metrics(),
            )
        self.assertEqual(0, best)

    def test_strict_history_rejects_resealed_metric_or_dev_selection_tamper(
        self,
    ) -> None:
        model = trainer.build_shared_hidden_family_residual(
            torch, anchor_model=self.anchor(), maximum_margin=2.0
        )
        record = self.history_record(model, epoch=0, score=0.5)
        configuration = {
            "epochs": 0,
            "batch_size": 2,
            "maximum_acceptable_regression": 0.01,
            "maximum_preferred_regression": 0.01,
            "maximum_family_regression": 0.01,
            "seed": 7,
        }
        context = {
            "arrays": {},
            "candidate_ids": ("a", "b", "single-day"),
            "groups": {
                "direct_family": {"train": [{"work_id": "work"}, {"work_id": "work"}]},
                "train": [{"row_indices": np.asarray([0, 1]), "work_id": "work"}],
            },
        }
        cache = {"hidden": torch.zeros(2, trainer.EXPECTED_HIDDEN_DIM)}
        patches = (
            mock.patch.object(
                trainer,
                "_evaluate_base_from_cache",
                return_value=self.base_metrics(),
            ),
            mock.patch.object(
                trainer,
                "_training_metrics",
                return_value=self.training_metrics(0.5),
            ),
        )
        tampered = copy.deepcopy(record)
        tampered["training_only_selection_metrics"]["direct_family"]["work_macro"][
            "body_accuracy"
        ] = 0.99
        with (
            patches[0],
            patches[1],
            self.assertRaisesRegex(
                trainer.SharedHiddenFamilyResidualError, "numeric drifted"
            ),
        ):
            trainer._strict_history_recompute(
                torch,
                manifest={"history": [tampered]},
                configuration=configuration,
                model=model,
                cache=cache,
                context=context,
                base_indices=np.asarray([0, 1]),
                anchor_base_metrics=self.base_metrics(),
            )
        dev_tampered = copy.deepcopy(record)
        dev_tampered["checkpoint_selection_inputs"] = ["development_eval"]
        with self.assertRaisesRegex(
            trainer.SharedHiddenFamilyResidualError, "forbidden diagnostics"
        ):
            trainer._strict_history_recompute(
                torch,
                manifest={"history": [dev_tampered]},
                configuration=configuration,
                model=model,
                cache=cache,
                context=context,
                base_indices=np.asarray([0, 1]),
                anchor_base_metrics=self.base_metrics(),
            )

    def test_validator_rejects_link_before_reading_artifact(self) -> None:
        with (
            mock.patch.object(
                trainer.overlay_v3,
                "_path_or_ancestor_is_link_or_reparse",
                return_value=True,
            ),
            self.assertRaisesRegex(
                trainer.SharedHiddenFamilyResidualError, "linked or reparsed"
            ),
        ):
            trainer.validate_output(Path("synthetic-linked-output"))

    def test_synthetic_train_stages_and_strictly_recomputes_anchor_fallback(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base_path = root / "base.npz"
            source_path = root / "head.safetensors"
            anchor_dir = root / "anchor"
            overlay_dir = root / "overlay"
            base_path.write_bytes(b"synthetic-base")
            source_path.write_bytes(b"synthetic-head")
            anchor_dir.mkdir()
            overlay_dir.mkdir()
            output = root / "output"
            anchor = self.anchor()
            direct_train = [
                {
                    "family_label": 0,
                    "row_index": 0,
                    "sample_id": "s0",
                    "supervision_weight": 1.0,
                    "work_id": "train-work",
                },
                {
                    "family_label": 1,
                    "row_index": 1,
                    "sample_id": "s1",
                    "supervision_weight": 1.0,
                    "work_id": "train-work",
                },
            ]
            direct_dev = [
                {
                    "family_label": 0,
                    "row_index": 2,
                    "sample_id": "s2",
                    "supervision_weight": 1.0,
                    "work_id": "dev-work",
                },
                {
                    "family_label": 1,
                    "row_index": 3,
                    "sample_id": "s3",
                    "supervision_weight": 1.0,
                    "work_id": "dev-work",
                },
            ]
            groups = {
                "development_eval": [
                    {
                        "group_id": "dev-group",
                        "row_indices": np.asarray([2, 3]),
                        "row_weights": np.ones(2, dtype=np.float32),
                        "work_id": "dev-work",
                    }
                ],
                "direct_family": {
                    "development_eval": direct_dev,
                    "train": direct_train,
                },
                "train": [
                    {
                        "group_id": "train-group",
                        "row_indices": np.asarray([0, 1]),
                        "row_weights": np.ones(2, dtype=np.float32),
                        "work_id": "train-work",
                    }
                ],
            }
            context = {
                "architecture": {"candidate_residual_hidden_dim": 64},
                "arrays": {
                    "family_label_weights": np.ones(4, dtype=np.float32),
                    "family_labels": np.asarray([0, 1, 0, 1], dtype=np.int64),
                    "split": np.asarray([0, 0, 0, 0], dtype=np.int64),
                    "work_ids": np.asarray(
                        ["train-work", "train-work", "dev-work", "dev-work"]
                    ),
                },
                "candidate_ids": ("a", "b", "single-day"),
                "dataset_path": base_path.resolve(),
                "groups": groups,
                "initialization": {"synthetic": True},
                "inventory": {
                    "candidate_ids": ("a", "b", "single-day"),
                    "row_count": 4,
                },
                "model": anchor,
                "overlay_binding": {
                    "development_eval_work_ids": ["dev-work"],
                    "synthetic": True,
                },
                "source_head": source_path.resolve(),
            }
            cache = {
                "body_candidate_scores": torch.zeros(4, 3),
                "candidate_scores": torch.zeros(4, 3),
                "family_logits": torch.zeros(4, 2),
                "hidden": torch.arange(4 * 64, dtype=torch.float32).reshape(4, 64)
                / 100.0,
                "variant_candidate_scores": torch.zeros(4, 3),
            }
            metrics = self.training_metrics(0.5)
            base_metrics = self.base_metrics()
            direct_metrics = metrics["direct_family"]
            page_metrics = metrics["page_consistency"]
            override = {"synthetic": True}
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
                    "2",
                    "--evaluation-batch-size",
                    "2",
                ]
            )
            with (
                mock.patch.object(trainer.time, "monotonic", return_value=100.0),
                mock.patch.object(trainer, "_load_context", return_value=context),
                mock.patch.object(trainer, "_build_frozen_cache", return_value=cache),
                mock.patch.object(
                    trainer,
                    "_base_train_indices",
                    return_value=np.asarray([0, 1], dtype=np.int64),
                ),
                mock.patch.object(
                    trainer,
                    "_evaluate_base_from_cache",
                    return_value=base_metrics,
                ),
                mock.patch.object(trainer, "_training_metrics", return_value=metrics),
                mock.patch.object(
                    trainer, "_direct_family_metrics", return_value=direct_metrics
                ),
                mock.patch.object(
                    trainer, "_overlay_metrics", return_value=page_metrics
                ),
                mock.patch.object(
                    trainer.page_v3,
                    "build_family_override_contract",
                    return_value=(
                        np.asarray([0, 1, 0, 1], dtype=np.int64),
                        np.ones(4, dtype=np.float32),
                        override,
                    ),
                ),
            ):
                result = trainer.train(args)
                self.assertEqual(0, result["best_epoch"])
                self.assertEqual(
                    "valid_nonpromotable_shared_hidden_family_residual",
                    result["status"],
                )
                state = trainer._load_sidecar_state(
                    torch, output / trainer.SIDECAR_FILE
                )
                self.assertTrue(
                    all(
                        not bool(torch.count_nonzero(value)) for value in state.values()
                    )
                )

                manifest_path = output / trainer.MANIFEST_FILE
                marker_path = output / trainer.MARKER_FILE
                original_manifest_bytes = manifest_path.read_bytes()
                original_marker_bytes = marker_path.read_bytes()

                def write_coherently_resealed_manifest(mutator: object) -> None:
                    manifest_record = json.loads(
                        original_manifest_bytes.decode("utf-8")
                    )
                    mutator(manifest_record)  # type: ignore[operator]
                    resealed_manifest = trainer.seal_record(manifest_record)
                    manifest_path.write_bytes(
                        trainer.json_bytes(resealed_manifest, pretty=True)
                    )
                    marker_record = json.loads(original_marker_bytes.decode("utf-8"))
                    marker_record["artifacts"] = {
                        trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path),
                        trainer.SIDECAR_FILE: trainer.sha256_file(
                            output / trainer.SIDECAR_FILE
                        ),
                    }
                    marker_path.write_bytes(
                        trainer.json_bytes(
                            trainer.seal_record(marker_record), pretty=True
                        )
                    )

                coherent_tampers = (
                    (
                        "fractional epochs",
                        lambda row: row["configuration"].__setitem__("epochs", 1.5),
                        "epochs",
                    ),
                    (
                        "fractional batch size",
                        lambda row: row["configuration"].__setitem__("batch_size", 2.5),
                        "batch_size",
                    ),
                    (
                        "fractional evaluation batch size",
                        lambda row: row["configuration"].__setitem__(
                            "evaluation_batch_size", 2.5
                        ),
                        "evaluation_batch_size",
                    ),
                    (
                        "boolean seed",
                        lambda row: row["configuration"].__setitem__("seed", True),
                        "seed",
                    ),
                    (
                        "boolean numeric option",
                        lambda row: row["configuration"].__setitem__(
                            "learning_rate", True
                        ),
                        "learning_rate",
                    ),
                    (
                        "boolean training seconds",
                        lambda row: row.__setitem__("training_seconds", True),
                        "training seconds",
                    ),
                    (
                        "weakened acceptable gate",
                        lambda row: row["configuration"].__setitem__(
                            "maximum_acceptable_regression", 0.006
                        ),
                        "thresholds",
                    ),
                    (
                        "weakened preferred gate",
                        lambda row: row["configuration"].__setitem__(
                            "maximum_preferred_regression", 0.006
                        ),
                        "thresholds",
                    ),
                    (
                        "weakened family gate",
                        lambda row: row["configuration"].__setitem__(
                            "maximum_family_regression", 0.003
                        ),
                        "thresholds",
                    ),
                    (
                        "weakened diagnostic gate",
                        lambda row: row["configuration"].__setitem__(
                            "minimum_diagnostic_work_macro_improvement", 0.019
                        ),
                        "cannot be weakened",
                    ),
                    (
                        "candidate score semantics",
                        lambda row: row["candidate_score_invariance"].__setitem__(
                            "internal_soft_gate_candidate_scores_evaluated", True
                        ),
                        "candidate score invariance",
                    ),
                    (
                        "work-balanced consumption",
                        lambda row: row["history"][1]["batch_consumption"][
                            "direct_schedule"
                        ].__setitem__("effective_rows", 3),
                        "batch consumption",
                    ),
                )
                for name, mutator, expected_error in coherent_tampers:
                    with self.subTest(tamper=name):
                        write_coherently_resealed_manifest(mutator)
                        with self.assertRaisesRegex(
                            trainer.SharedHiddenFamilyResidualError,
                            expected_error,
                        ):
                            trainer.validate_output(output)

                manifest_path.write_bytes(original_manifest_bytes)
                marker_path.write_bytes(original_marker_bytes)

                changed = {name: value.clone() for name, value in state.items()}
                changed["family_margin_head.bias"].fill_(0.01)
                sidecar_path = output / trainer.SIDECAR_FILE
                save_file(changed, str(sidecar_path))
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["files"][trainer.SIDECAR_FILE] = {
                    "byte_size": sidecar_path.stat().st_size,
                    "sha256": trainer.sha256_file(sidecar_path),
                    "tensor_inventory": trainer._tensor_inventory(changed),
                }
                manifest = trainer.seal_record(manifest)
                manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
                marker = json.loads(marker_path.read_text(encoding="utf-8"))
                marker["artifacts"] = {
                    trainer.MANIFEST_FILE: trainer.sha256_file(manifest_path),
                    trainer.SIDECAR_FILE: trainer.sha256_file(sidecar_path),
                }
                marker = trainer.seal_record(marker)
                marker_path.write_bytes(trainer.json_bytes(marker, pretty=True))
                with self.assertRaisesRegex(
                    trainer.SharedHiddenFamilyResidualError,
                    "not the selected history state",
                ):
                    trainer.validate_output(output)


if __name__ == "__main__":
    unittest.main()
