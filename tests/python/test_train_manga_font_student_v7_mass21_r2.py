from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch

from scripts import train_manga_font_student_v7_mass21_r2 as r2


def fake_entries(counts: list[int]) -> list[SimpleNamespace]:
    rows: list[SimpleNamespace] = []
    for work_index, count in enumerate(counts):
        for row_index in range(count):
            rows.append(
                SimpleNamespace(
                    sample_id=f"sample-{work_index}-{row_index}",
                    work_id=f"work-{work_index}",
                    work_weight=1.0 / count,
                )
            )
    return rows


def val_metrics(*, preferred: float, variant_preferred: float) -> dict[str, float | int]:
    return {
        "acceptable_at1": 0.70,
        "acceptable_hit_at3": 0.90,
        "evaluated_positive_rows": r2.v7.VAL_ROWS,
        "preferred_at1": preferred,
        "preferred_hit_at3": 0.70,
        "tiered_gold_loss": 2.0,
        "top1_max_candidate_share": 0.25,
        "top1_unique_candidate_count": 8,
        "variant_acceptable_at1": 0.70,
        "variant_acceptable_hit_at3": 0.90,
        "variant_preferred_at1": variant_preferred,
        "variant_preferred_hit_at3": 0.70,
        "variant_val_rows": r2.v7.VARIANT_VAL_ROWS,
    }


class MangaFontV7Mass21R2Tests(unittest.TestCase):
    def test_global_normalization_equalizes_all_15_epoch_macro_contributions(
        self,
    ) -> None:
        entries = fake_entries(list(range(1, 16)))

        contract = r2.global_work_normalization(entries)
        per_work: dict[str, float] = {}
        denominator = 8
        for entry in entries:
            per_work[entry.work_id] = per_work.get(entry.work_id, 0.0) + (
                entry.work_weight * contract.scale / denominator
            )

        self.assertEqual(15, contract.work_count)
        self.assertAlmostEqual(1.0, contract.normalized_weight_mean)
        self.assertAlmostEqual(15.0, contract.raw_weight_sum)
        self.assertEqual(15, len(per_work))
        expected = len(entries) / 15.0 / denominator
        for contribution in per_work.values():
            self.assertAlmostEqual(expected, contribution, places=12)

    def test_pseudo_confidence_is_absolute_and_missing_rows_contribute_zero(
        self,
    ) -> None:
        logits = torch.zeros((1, r2.v7.mass21.ACTIVE_CANDIDATE_COUNT))
        targets = torch.full_like(logits, 1.0 / logits.shape[1])
        low = r2.absolute_pseudo_soft_target_loss(
            torch, logits, targets, torch.tensor([0.2]), denominator=4
        )
        high = r2.absolute_pseudo_soft_target_loss(
            torch, logits, targets, torch.tensor([0.4]), denominator=4
        )
        zero = r2.absolute_pseudo_soft_target_loss(
            torch, logits, targets, torch.tensor([0.0]), denominator=4
        )
        empty = r2.absolute_pseudo_soft_target_loss(
            torch,
            logits[:0],
            targets[:0],
            torch.zeros(0),
            denominator=4,
        )

        self.assertAlmostEqual(float(high), 2.0 * float(low), places=6)
        self.assertEqual(0.0, float(zero))
        self.assertEqual(0.0, float(empty))
        self.assertAlmostEqual(
            float(low), math.log(logits.shape[1]) * 0.2 / 4.0, places=6
        )

    def test_epoch0_warm_start_remains_best_when_epoch1_is_worse(self) -> None:
        baseline = val_metrics(preferred=0.50, variant_preferred=0.55)
        epoch1 = val_metrics(preferred=0.35, variant_preferred=0.30)
        improved = val_metrics(preferred=0.55, variant_preferred=0.60)

        self.assertFalse(r2._is_val_improvement(epoch1, baseline))
        self.assertTrue(r2._is_val_improvement(improved, baseline))

    def test_domain_moment_is_unweighted_even_when_work_weights_change(self) -> None:
        total_rows = 5  # real2 + full1 + partial1 + synthetic1
        logits = torch.randn(total_rows, r2.v7.mass21.ACTIVE_CANDIDATE_COUNT)
        views = torch.nn.functional.normalize(
            torch.randn(total_rows, 3, 4, 8), p=2, dim=-1
        )
        attention = torch.softmax(torch.randn(total_rows, 3, 4, 5), dim=-1)
        target = torch.zeros(1, r2.v7.mass21.ACTIVE_CANDIDATE_COUNT)
        target[0, 0] = r2.v7.mass21.v3.PREFERRED_CODE
        base_batch = {
            "full_count": 1,
            "full_masks": torch.ones_like(target, dtype=torch.bool),
            "full_targets": target,
            "partial_count": 1,
            "partial_masks": torch.ones_like(target, dtype=torch.bool),
            "partial_targets": target,
            "pseudo_positions": torch.zeros(0, dtype=torch.long),
            "pseudo_targets": None,
            "pseudo_weights": None,
            "real_count": 2,
            "real_loss_denominator": 2,
            "synthetic_count": 1,
            "synthetic_labels": torch.tensor([0]),
        }
        weights = r2.v7.LossWeights(1.0, 6.0, 5.0, 0.15, 0.05, 0.75, 0.01)
        result = {
            "attention": attention,
            "candidate_scores": logits,
            "view_embeddings": views,
        }

        _, first = r2._compute_losses(
            torch=torch,
            result=result,
            batch={**base_batch, "real_weights": torch.tensor([1.0, 0.0])},
            weights=weights,
        )
        _, second = r2._compute_losses(
            torch=torch,
            result=result,
            batch={**base_batch, "real_weights": torch.tensor([0.0, 1.0])},
            weights=weights,
        )

        self.assertTrue(torch.equal(first["domain_moment"], second["domain_moment"]))

    def test_epoch0_and_r2_provenance_are_sealed_in_checkpoint(self) -> None:
        args = r2.build_parser().parse_args(["train"])
        model = torch.nn.Linear(3, 2)
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.head_lr)
        baseline = val_metrics(preferred=0.50, variant_preferred=0.55)
        weighting = {
            "work": {"id": r2.WORK_NORMALIZATION_ID},
            "pseudo_confidence": r2.PSEUDO_CONFIDENCE_MODE,
        }
        with r2._patched_v7_runtime():
            payload = r2._checkpoint_payload(
                torch=torch,
                args=args,
                candidate_ids=r2.v7.mass21.candidate_projection(
                    r2.v7.mass21.legacy15.FULL22_CANDIDATE_IDS
                ).active_ids,
                model=model,
                optimizer=optimizer,
                epoch=1,
                next_step=0,
                stale_epochs=0,
                best_metrics=baseline,
                best_predictions=[],
                best_state=r2.v7.v6._state_cpu(model),
                best_prototypes=torch.zeros(21, 4, 256),
                best_epoch=0,
                history=[],
                epoch_sums={},
                epoch_steps=0,
                source_fingerprint={"master": "sealed"},
                baseline_val=baseline,
                weighting=weighting,
            )

        self.assertEqual(0, payload["best_epoch"])
        self.assertEqual(baseline, payload["baseline_val"])
        self.assertEqual(r2.RUN_STATE_SCHEMA, payload["schema_version"])
        self.assertEqual(
            r2.WORK_NORMALIZATION_ID,
            payload["configuration"]["work_normalization"],
        )
        self.assertEqual(r2._source_provenance(), payload["r2_source_provenance"])

    def test_two_slot_checkpoint_survives_interrupted_slot_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "r2-atomic-state"
            r2._write_run_checkpoint(
                torch=torch, run_state_dir=root, payload={"value": 1}
            )
            r2._write_run_checkpoint(
                torch=torch, run_state_dir=root, payload={"value": 2}
            )
            # Simulate generation 3 replacing slot A's checkpoint and crashing
            # before its marker.  Slot B generation 2 must remain recoverable.
            (root / r2.RUN_STATE_CHECKPOINT_A).write_bytes(b"interrupted")
            (root / ".r2-checkpoint-orphan").write_bytes(b"partial")

            latest = r2._latest_checkpoint_path(root)
            payload = torch.load(latest, map_location="cpu", weights_only=False)
            metadata = r2._validate_run_state(root)

        self.assertEqual(r2.RUN_STATE_CHECKPOINT_B, latest.name)
        self.assertEqual(2, payload["value"])
        self.assertEqual(2, metadata["generation"])
        self.assertEqual(1, metadata["valid_slot_count"])

    def test_preflight_exposes_reduced_source_repetition(self) -> None:
        args = r2.build_parser().parse_args(["preflight"])
        inputs = SimpleNamespace(
            epoch_batches=tuple(None for _ in range(1_229)),
            real=SimpleNamespace(entries=tuple(None for _ in range(19_664))),
        )

        exposure = r2._source_exposure_plan(args, inputs)

        self.assertEqual(1.0, exposure["real"]["mean_exposures_per_row"])
        self.assertAlmostEqual(1_229 / 266, exposure["full_human"]["mean_exposures_per_row"])
        self.assertAlmostEqual(
            1_229 / 409, exposure["partial_human"]["mean_exposures_per_row"]
        )
        self.assertAlmostEqual(1_229 / 1_008, exposure["synthetic"]["mean_exposures_per_row"])
        self.assertEqual(1, args.full_human_batch_size)
        self.assertEqual(1, args.partial_human_batch_size)
        self.assertEqual(1, args.synthetic_batch_size)
        self.assertEqual(1e-5, args.head_lr)

    def test_configuration_and_source_provenance_are_r2_specific(self) -> None:
        args = r2.build_parser().parse_args(["train"])
        configuration = r2._configuration(args)
        provenance = r2._source_provenance()

        self.assertEqual(0.75, args.pseudo_weight)
        self.assertEqual(6, args.epochs)
        self.assertEqual(6, args.patience)
        self.assertEqual(
            r2.WORK_NORMALIZATION_ID, configuration["work_normalization"]
        )
        self.assertEqual(
            r2.PSEUDO_CONFIDENCE_MODE, configuration["pseudo_confidence_mode"]
        )
        self.assertEqual(
            r2.v7.base.sha256_file(Path(r2.__file__).resolve()),
            provenance["r2_source_code_sha256"],
        )
        self.assertEqual(
            r2.v7.base.sha256_file(Path(r2.v7.__file__).resolve()),
            provenance["base_v7_source_code_sha256"],
        )

    def test_runtime_overrides_restore_the_imported_baseline_module(self) -> None:
        original_compute = r2.v7._compute_losses
        original_writer = r2.v7._write_run_checkpoint

        with r2._patched_v7_runtime():
            self.assertIs(r2._compute_losses, r2.v7._compute_losses)
            self.assertIs(r2._write_run_checkpoint, r2.v7._write_run_checkpoint)

        self.assertIs(original_compute, r2.v7._compute_losses)
        self.assertIs(original_writer, r2.v7._write_run_checkpoint)

    def test_pseudo_cli_cap_is_one(self) -> None:
        args = r2.build_parser().parse_args(["train", "--pseudo-weight", "1.0"])
        r2._validate_cli_configuration(args)
        rejected = r2.build_parser().parse_args(["train", "--pseudo-weight", "1.01"])
        with self.assertRaises(r2.MangaFontV7Mass21R2Error):
            r2._validate_cli_configuration(rejected)


if __name__ == "__main__":
    unittest.main()
