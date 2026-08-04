from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts import build_manga_font_legacy15_train_overlay_v1 as legacy15
from scripts import train_manga_font_student_v3 as v3
from scripts import train_manga_font_student_v6_mass21_data as data


class TrainMangaFontStudentV6Mass21DataTest(unittest.TestCase):
    def setUp(self) -> None:
        self.projection = data.candidate_projection(legacy15.FULL22_CANDIDATE_IDS)

    def test_active_vocabulary_removes_only_gugi(self) -> None:
        self.assertEqual(len(self.projection.source_ids), 22)
        self.assertEqual(len(self.projection.active_ids), 21)
        self.assertEqual(self.projection.source_ids[self.projection.retired_index], "gugi")
        self.assertNotIn("gugi", self.projection.active_ids)
        self.assertEqual(
            self.projection.active_ids,
            tuple(value for value in legacy15.FULL22_CANDIDATE_IDS if value != "gugi"),
        )

    def test_cached_arrays_project_columns_rows_and_labels(self) -> None:
        source_count = len(self.projection.source_ids)
        train_targets = np.zeros((2, source_count), dtype=np.float32)
        train_targets[:, 0] = v3.PREFERRED_CODE
        val_targets = np.zeros((1, source_count), dtype=np.float32)
        val_targets[:, 1] = v3.PREFERRED_CODE
        synthetic_labels = np.repeat(
            np.arange(source_count, dtype=np.int64), data.SYNTHETIC_PER_FONT
        )
        reference_labels = np.repeat(
            np.arange(source_count, dtype=np.int64), data.REFERENCE_PER_FONT
        )
        arrays = {
            "human_train_masks": np.ones_like(train_targets, dtype=np.bool_),
            "human_train_roles": np.zeros(2, dtype=np.int64),
            "human_train_targets": train_targets,
            "human_train_tokens": np.zeros((2, 3, 1, 2), dtype=np.float16),
            "human_val_masks": np.ones_like(val_targets, dtype=np.bool_),
            "human_val_roles": np.zeros(1, dtype=np.int64),
            "human_val_targets": val_targets,
            "human_val_tokens": np.zeros((1, 3, 1, 2), dtype=np.float16),
            "reference_labels": reference_labels,
            "reference_tokens": np.zeros(
                (source_count * data.REFERENCE_PER_FONT, 1, 2), dtype=np.float16
            ),
            "synthetic_labels": synthetic_labels,
            "synthetic_tokens": np.zeros(
                (source_count * data.SYNTHETIC_PER_FONT, 3, 1, 2), dtype=np.float16
            ),
        }

        projected = data.project_cached_arrays_to_active21(arrays, self.projection)

        self.assertEqual(projected["human_train_targets"].shape, (2, 21))
        self.assertEqual(projected["synthetic_labels"].shape, (data.SYNTHETIC21_ROWS,))
        self.assertEqual(projected["reference_labels"].shape, (data.REFERENCE21_ROWS,))
        self.assertTrue(
            np.all(
                np.bincount(projected["synthetic_labels"], minlength=21)
                == data.SYNTHETIC_PER_FONT
            )
        )

    def test_epoch_schedule_covers_every_real_row_once_and_cycles_sources(self) -> None:
        batches = data.build_epoch_batches(
            real_count=10,
            full_human_count=4,
            partial_human_count=4,
            synthetic_count=8,
            real_batch_size=3,
            full_human_batch_size=1,
            partial_human_batch_size=1,
            synthetic_batch_size=2,
            seed=7,
        )
        real = [index for batch in batches for index in batch.real_indices]
        full = [index for batch in batches for index in batch.full_human_indices]
        partial = [index for batch in batches for index in batch.partial_human_indices]
        synthetic = [index for batch in batches for index in batch.synthetic_indices]
        self.assertEqual(len(batches), 4)
        self.assertEqual(len(real), len(set(real)))
        self.assertEqual(set(real), set(range(10)))
        self.assertEqual(set(full), set(range(4)))
        self.assertEqual(set(partial), set(range(4)))
        self.assertEqual(set(synthetic), set(range(8)))

    def _pseudo_row(self, sample_id: str) -> dict[str, object]:
        return {
            "schema_version": data.PSEUDO_SCHEMA,
            "sample_id": sample_id,
            "split": "train",
            "candidate_ids": list(self.projection.active_ids),
            "probabilities": [1.0 / 21.0] * 21,
            "weight": 0.5,
            "label_authority": "pseudo_soft_not_gold",
            "training_eligible": False,
            "teacher_bindings": {"teacher": "sealed-test-teacher"},
            "round": 1,
        }

    def _write_jsonl(self, root: Path, rows: list[dict[str, object]]) -> Path:
        path = root / "pseudo.jsonl"
        path.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
            encoding="utf-8",
        )
        return path

    def test_pseudo_loader_accepts_dense_active21_and_excludes_human_gold(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self._write_jsonl(
                Path(directory), [self._pseudo_row("real"), self._pseudo_row("gold")]
            )
            result = data.load_pseudo_targets(
                path,
                candidate_ids=self.projection.active_ids,
                real_train_ids=frozenset({"real", "gold"}),
                human_gold_ids=frozenset({"gold"}),
            )
        self.assertEqual(set(result.targets), {"real"})
        self.assertEqual(result.excluded_human_gold_rows, 1)
        self.assertAlmostEqual(sum(result.targets["real"].probabilities), 1.0)

    def test_pseudo_loader_rejects_sparse_order_gugi_val_and_gemma(self) -> None:
        invalid_rows: list[dict[str, object]] = []
        sparse = self._pseudo_row("real")
        sparse.pop("probabilities")
        sparse["soft_labels"] = {self.projection.active_ids[0]: 1.0}
        invalid_rows.append(sparse)
        reordered = self._pseudo_row("real")
        reordered["candidate_ids"] = list(reversed(self.projection.active_ids))
        invalid_rows.append(reordered)
        with_gugi = self._pseudo_row("real")
        with_gugi["candidate_ids"] = list(legacy15.FULL22_CANDIDATE_IDS)
        with_gugi["probabilities"] = [1.0 / 22.0] * 22
        invalid_rows.append(with_gugi)
        validation = self._pseudo_row("real")
        validation["split"] = "val"
        invalid_rows.append(validation)
        gemma = self._pseudo_row("real")
        gemma["teacher_bindings"] = {"model_id": "google/gemma-3-27b-it"}
        invalid_rows.append(gemma)

        for index, row in enumerate(invalid_rows):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                path = self._write_jsonl(Path(directory), [row])
                with self.assertRaises(data.MangaFontMass21DataError):
                    data.load_pseudo_targets(
                        path,
                        candidate_ids=self.projection.active_ids,
                        real_train_ids=frozenset({"real"}),
                        human_gold_ids=frozenset(),
                    )

    def test_human_scheduler_space_maps_cached109_then_upgraded160(self) -> None:
        self.assertEqual(
            data.resolve_full_human_index(108),
            data.HumanBatchSource("cached_original_full21", 108),
        )
        self.assertEqual(
            data.resolve_full_human_index(109),
            data.HumanBatchSource("upgraded_full21_pixels", 0),
        )
        self.assertEqual(
            data.resolve_full_human_index(265),
            data.HumanBatchSource("upgraded_full21_pixels", 156),
        )
        with self.assertRaises(data.MangaFontMass21DataError):
            data.resolve_full_human_index(266)

    def test_losses_honor_masks_and_three_view_domains(self) -> None:
        import torch

        logits = torch.zeros((1, 21))
        targets = torch.zeros((1, 21))
        targets[0, 0] = v3.PREFERRED_CODE
        masks = torch.zeros((1, 21), dtype=torch.bool)
        masks[0, :2] = True
        baseline = data.masked_human_loss(torch, logits, targets, masks)
        changed = logits.clone()
        changed[0, 20] = 10_000.0
        masked = data.masked_human_loss(torch, changed, targets, masks)
        self.assertTrue(torch.allclose(baseline, masked))

        embeddings = torch.nn.functional.normalize(
            torch.randn(2, 1, 2, 4), p=2, dim=-1
        ).repeat(1, 3, 1, 1)
        consistency = data.three_view_consistency_loss(torch, embeddings)
        domain = data.domain_moment_loss(torch, embeddings, embeddings)
        self.assertAlmostEqual(float(consistency), 0.0, places=6)
        self.assertAlmostEqual(float(domain), 0.0, places=6)

        pseudo_targets = torch.full((2, 21), 1.0 / 21.0)
        pseudo = data.pseudo_soft_target_loss(
            torch, torch.zeros((2, 21)), pseudo_targets, torch.tensor([1.0, 0.0])
        )
        self.assertTrue(bool(torch.isfinite(pseudo)))

    def test_indexed_row_detects_manifest_mutation(self) -> None:
        raw = b'{"id":"real","split":"train"}\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.jsonl"
            path.write_bytes(raw)
            index = data.RealTrainIndex(
                master_dir=Path(directory),
                manifest_path=path,
                manifest_sha256=data.base.sha256_bytes(raw),
                split_map_sha256="0" * 64,
                entries=(),
                skipped_val_rows=0,
                skipped_test_rows=0,
            )
            entry = data.RealTrainIndexEntry(
                row_index=0,
                line_number=1,
                byte_offset=0,
                byte_length=len(raw),
                line_sha256=data.base.sha256_bytes(raw),
                sample_id="real",
                work_id="work",
                work_weight=1.0,
                source_catalog_id="catalog",
            )
            self.assertEqual(data.read_real_train_row(index, entry)["id"], "real")
            path.write_bytes(raw.replace(b"real", b"fake"))
            with self.assertRaises(data.MangaFontMass21DataError):
                data.read_real_train_row(index, entry)

    def test_cli_is_preflight_or_bounded_smoke_only(self) -> None:
        parser = data.build_parser()
        self.assertEqual(parser.parse_args(["preflight"]).command, "preflight")
        smoke = parser.parse_args(["smoke", "--smoke-rows", "2"])
        self.assertEqual(smoke.smoke_rows, 2)
        with self.assertRaises(SystemExit):
            parser.parse_args(["train"])


if __name__ == "__main__":
    unittest.main()
