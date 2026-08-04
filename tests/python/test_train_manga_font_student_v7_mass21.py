from __future__ import annotations

import argparse
import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import save_file


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "train_manga_font_student_v7_mass21.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "train_manga_font_student_v7_mass21_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


TRAINER = load_script()


def active_ids() -> tuple[str, ...]:
    return TRAINER.mass21.candidate_projection(
        TRAINER.mass21.legacy15.FULL22_CANDIDATE_IDS
    ).active_ids


def configuration_args() -> argparse.Namespace:
    return argparse.Namespace(
        attention_diversity_weight=0.01,
        checkpoint_steps=2,
        domain_moment_weight=0.05,
        epochs=2,
        full_human_batch_size=1,
        full_human_weight=6.0,
        gradient_clip=1.0,
        head_lr=8e-5,
        partial_human_batch_size=1,
        partial_human_weight=5.0,
        patience=1,
        pseudo_weight=0.1,
        real_batch_size=2,
        real_consistency_weight=0.15,
        seed=123,
        synthetic_batch_size=2,
        synthetic_weight=1.0,
        weight_decay=1e-4,
    )


class MangaFontV7Mass21Tests(unittest.TestCase):
    def test_epoch_schedule_consumes_every_source(self) -> None:
        batches = TRAINER.mass21.build_epoch_batches(
            real_count=8,
            full_human_count=4,
            partial_human_count=4,
            synthetic_count=4,
            real_batch_size=2,
            full_human_batch_size=1,
            partial_human_batch_size=1,
            synthetic_batch_size=1,
            seed=7,
        )

        coverage = TRAINER._coverage_record(batches)

        self.assertEqual(8, coverage["real_unique"])
        self.assertEqual(4, coverage["full_human_unique"])
        self.assertEqual(4, coverage["partial_human_unique"])
        self.assertEqual(4, coverage["synthetic_unique"])

    def test_inverse_work_weight_changes_three_view_consistency(self) -> None:
        aligned = torch.tensor(
            [[[1.0, 0.0], [1.0, 0.0]], [[1.0, 0.0], [1.0, 0.0]], [[1.0, 0.0], [1.0, 0.0]]]
        )
        divergent = torch.tensor(
            [[[1.0, 0.0], [1.0, 0.0]], [[0.0, 1.0], [0.0, 1.0]], [[-1.0, 0.0], [-1.0, 0.0]]]
        )
        embeddings = torch.stack((aligned, divergent), dim=0)

        aligned_weighted = TRAINER._weighted_three_view_consistency_loss(
            torch, embeddings, torch.tensor([1.0, 0.0])
        )
        divergent_weighted = TRAINER._weighted_three_view_consistency_loss(
            torch, embeddings, torch.tensor([0.0, 1.0])
        )

        self.assertLess(float(aligned_weighted), 1e-6)
        self.assertGreater(float(divergent_weighted), 0.5)

    def test_combined_loss_backpropagates_all_four_sources_and_pseudo(self) -> None:
        torch.manual_seed(4)
        total_rows = 6  # real2 + full1 + partial1 + synthetic2
        logits = torch.randn(
            total_rows, TRAINER.mass21.ACTIVE_CANDIDATE_COUNT, requires_grad=True
        )
        raw_views = torch.randn(total_rows, 3, 4, 8, requires_grad=True)
        views = torch.nn.functional.normalize(raw_views, p=2, dim=-1)
        raw_attention = torch.randn(total_rows, 3, 4, 5, requires_grad=True)
        attention = torch.softmax(raw_attention, dim=-1)
        full_targets = torch.zeros(1, TRAINER.mass21.ACTIVE_CANDIDATE_COUNT)
        full_targets[0, 0] = TRAINER.mass21.v3.PREFERRED_CODE
        partial_targets = torch.zeros(1, TRAINER.mass21.ACTIVE_CANDIDATE_COUNT)
        partial_targets[0, 1] = TRAINER.mass21.v3.PREFERRED_CODE
        pseudo_targets = torch.full(
            (2, TRAINER.mass21.ACTIVE_CANDIDATE_COUNT),
            1.0 / TRAINER.mass21.ACTIVE_CANDIDATE_COUNT,
        )
        batch = {
            "full_count": 1,
            "full_masks": torch.ones(
                1, TRAINER.mass21.ACTIVE_CANDIDATE_COUNT, dtype=torch.bool
            ),
            "full_targets": full_targets,
            "partial_count": 1,
            "partial_masks": torch.tensor(
                [[index < 15 for index in range(TRAINER.mass21.ACTIVE_CANDIDATE_COUNT)]]
            ),
            "partial_targets": partial_targets,
            "pseudo_positions": torch.tensor([0, 1]),
            "pseudo_targets": pseudo_targets,
            "pseudo_weights": torch.tensor([0.2, 0.8]),
            "real_count": 2,
            "real_weights": torch.tensor([0.25, 1.0]),
            "synthetic_count": 2,
            "synthetic_labels": torch.tensor([2, 3]),
        }
        weights = TRAINER.LossWeights(1.0, 6.0, 5.0, 0.15, 0.05, 0.1, 0.01)

        loss, components = TRAINER._compute_losses(
            torch=torch,
            result={
                "attention": attention,
                "candidate_scores": logits,
                "view_embeddings": views,
            },
            batch=batch,
            weights=weights,
        )
        loss.backward()

        self.assertTrue(torch.isfinite(loss))
        self.assertIsNotNone(logits.grad)
        self.assertEqual(2, components["pseudo_rows"])
        self.assertEqual(
            {
                "attention_diversity",
                "domain_moment",
                "full_human",
                "partial_human",
                "pseudo",
                "pseudo_rows",
                "real_consistency",
                "synthetic",
                "total",
            },
            set(components),
        )

    def test_checkpoint_round_trip_rejects_configuration_drift(self) -> None:
        args = configuration_args()
        model = torch.nn.Linear(3, 2)
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.head_lr)
        source = {"master_manifest_sha256": "a" * 64}
        payload = TRAINER._checkpoint_payload(
            torch=torch,
            args=args,
            candidate_ids=active_ids(),
            model=model,
            optimizer=optimizer,
            epoch=1,
            next_step=2,
            stale_epochs=0,
            best_metrics=None,
            best_predictions=None,
            best_state=None,
            best_prototypes=None,
            best_epoch=0,
            history=[],
            epoch_sums={"total": 2.0},
            epoch_steps=2,
            source_fingerprint=source,
        )
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "bounded-run-state"
            TRAINER._write_run_checkpoint(
                torch=torch, run_state_dir=state_dir, payload=payload
            )

            loaded = TRAINER._load_run_checkpoint(
                torch=torch,
                args=args,
                run_state_dir=state_dir,
                source_fingerprint=source,
                candidate_ids=active_ids(),
                device=torch.device("cpu"),
            )
            self.assertEqual(2, loaded["next_step"])

            drifted = copy.copy(args)
            drifted.head_lr = 1e-3
            with self.assertRaises(TRAINER.MangaFontV7Mass21Error):
                TRAINER._load_run_checkpoint(
                    torch=torch,
                    args=drifted,
                    run_state_dir=state_dir,
                    source_fingerprint=source,
                    candidate_ids=active_ids(),
                    device=torch.device("cpu"),
                )

    def test_sealed_output_validator_checks_active21_history_and_val33(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sealed-v7-output"
            output.mkdir()
            save_file({"weight": torch.zeros(1)}, str(output / TRAINER.BEST_HEAD))
            prototype_count = (
                TRAINER.mass21.ACTIVE_CANDIDATE_COUNT
                * TRAINER.QUERY_COUNT
                * TRAINER.QUERY_DIM
            )
            (output / TRAINER.PROTOTYPES).write_bytes(
                np.zeros(prototype_count, dtype="<f4").tobytes()
            )
            ranked = [
                {"candidate_id": candidate_id, "probability": 1.0 / len(active_ids())}
                for candidate_id in active_ids()
            ]
            with (output / TRAINER.PREDICTIONS).open(
                "w", encoding="utf-8", newline="\n"
            ) as handle:
                for row_index in range(TRAINER.VAL_ROWS):
                    handle.write(
                        TRAINER.base.canonical_json(
                            TRAINER.base.seal_record(
                                {
                                    "ranked_candidates": ranked,
                                    "row_index": row_index,
                                    "split": "val",
                                }
                            )
                        )
                        + "\n"
                    )
            history = TRAINER.base.seal_record(
                {
                    "coverage": {"real_unique": TRAINER.mass21.MASTER_TRAIN_ROWS},
                    "epoch": 1,
                    "schema_version": TRAINER.SCHEMA,
                }
            )
            (output / TRAINER.HISTORY).write_text(
                TRAINER.base.canonical_json(history) + "\n", encoding="utf-8"
            )
            (output / TRAINER.LATEST_CHECKPOINT).write_bytes(b"checkpoint")
            boundaries = {
                "gugi_candidate_count": 0,
                "human_test_labels_deserialized": 0,
                "human_test_pixels_opened": 0,
                "master_test_rows_json_deserialized": 0,
                "master_test_pixels_opened": 0,
                "master_val_rows_json_deserialized": 0,
                "master_val_pixels_opened": 0,
                "test_used_for_model_selection": False,
                "val33_count": TRAINER.VAL_ROWS,
                "val33_used_for_early_stop": True,
                "val33_used_for_model_selection": True,
                "val_used_for_optimizer": False,
            }
            files = {
                name: TRAINER._descriptor(output / name)
                for name in (
                    TRAINER.BEST_HEAD,
                    TRAINER.HISTORY,
                    TRAINER.LATEST_CHECKPOINT,
                    TRAINER.PREDICTIONS,
                    TRAINER.PROTOTYPES,
                )
            }
            manifest = TRAINER.base.seal_record(
                {
                    "best_epoch": 1,
                    "best_val": {
                        "evaluated_positive_rows": TRAINER.VAL_ROWS,
                        "variant_val_rows": TRAINER.VARIANT_VAL_ROWS,
                    },
                    "boundaries": boundaries,
                    "candidate_ids": list(active_ids()),
                    "files": files,
                    "history_epochs": 1,
                    "schema_version": TRAINER.SCHEMA,
                    "source_code_sha256": TRAINER.base.sha256_file(TRAINER.SCRIPT if hasattr(TRAINER, "SCRIPT") else SCRIPT),
                }
            )
            (output / TRAINER.MANIFEST).write_bytes(
                TRAINER.base.json_bytes(manifest, pretty=True)
            )
            marker = {
                "artifacts": {
                    name: TRAINER.base.sha256_file(output / name)
                    for name in TRAINER.OUTPUT_FILES - {TRAINER.MARKER}
                },
                "owner": TRAINER.OWNER,
                "safe_replace": True,
                "schema_version": TRAINER.SCHEMA,
            }
            (output / TRAINER.MARKER).write_bytes(
                TRAINER.base.json_bytes(marker, pretty=True)
            )

            result = TRAINER.validate_output(output)

            self.assertEqual(21, result["candidate_count"])
            self.assertEqual(1, result["history_epochs"])


if __name__ == "__main__":
    unittest.main()
