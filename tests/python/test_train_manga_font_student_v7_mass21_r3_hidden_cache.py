from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
import torch

from scripts import train_manga_font_student_v7_mass21_r3 as r3


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


class MangaFontV7Mass21R3HiddenCacheTests(unittest.TestCase):
    def _fixture(self, root: Path) -> tuple[SimpleNamespace, SimpleNamespace]:
        cache = root / "cache"
        shards_root = cache / r3.hidden_cache.SHARDS_DIR
        shards_root.mkdir(parents=True)
        descriptors: list[dict[str, object]] = []
        for ordinal, (start, stop) in enumerate(((0, 2), (2, 4))):
            directory = f"shard-{ordinal}"
            shard_dir = shards_root / directory
            shard_dir.mkdir()
            values = np.empty(
                (
                    stop - start,
                    len(r3.v7.base.VIEW_NAMES),
                    r3.v7.PATCH_COUNT,
                    r3.v7.HIDDEN_SIZE,
                ),
                dtype="<f2",
            )
            for local_index in range(stop - start):
                values[local_index].fill(float(start + local_index + 1))
            np.save(shard_dir / r3.hidden_cache.SHARD_ARRAY, values)
            descriptors.append(
                {
                    "directory": directory,
                    "end_cache_index_exclusive": stop,
                    "row_count": stop - start,
                    "shard_ordinal": ordinal,
                    "start_cache_index": start,
                }
            )

        model = {
            "base_model_id": r3.v7.base.MODEL_ID,
            "base_model_revision": r3.v7.base.MODEL_REVISION,
            "cached_tensor": "last_hidden_state",
            "compute_device_kind": "cuda",
            "compute_dtype": "bfloat16",
            "hidden_size": r3.v7.HIDDEN_SIZE,
            "image_size": r3.hidden_cache.IMAGE_SIZE,
            "patch_count": r3.v7.PATCH_COUNT,
            "patch_size": r3.hidden_cache.PATCH_SIZE,
            "pooler_output_used": False,
            "processor_use_fast": r3.v7.base.PROCESSOR_USE_FAST,
        }
        build_contract = {
            "model": model,
            "tensor": r3.hidden_cache._tensor_contract(),  # noqa: SLF001
            "views": r3.hidden_cache._view_contract(),  # noqa: SLF001
        }
        _write_json(cache / r3.hidden_cache.BUILD_CONTRACT, build_contract)
        _write_json(cache / r3.hidden_cache.MANIFEST, {"shards": descriptors})
        (cache / r3.hidden_cache.SAMPLE_INDEX).write_text("sealed-index\n")

        sha = "a" * 64
        rows = (
            SimpleNamespace(
                cache_index=0,
                master_row_index=0,
                line_number=1,
                master_line_sha256="1" * 64,
                sample_id="train-a",
                split="train",
                work_id="work-a",
                source_catalog_id="catalog-a",
            ),
            SimpleNamespace(
                cache_index=1,
                master_row_index=1,
                line_number=2,
                master_line_sha256="2" * 64,
                sample_id="val-a",
                split="val",
                work_id="work-v",
                source_catalog_id="catalog-v",
            ),
            SimpleNamespace(
                cache_index=2,
                master_row_index=2,
                line_number=3,
                master_line_sha256="3" * 64,
                sample_id="train-b",
                split="train",
                work_id="work-b",
                source_catalog_id="catalog-b",
            ),
            SimpleNamespace(
                cache_index=3,
                master_row_index=3,
                line_number=4,
                master_line_sha256="4" * 64,
                sample_id="test-a",
                split="test",
                work_id="work-t",
                source_catalog_id="catalog-t",
            ),
        )
        plan = SimpleNamespace(
            rows=rows,
            source_bindings={"master_manifest_sha256": sha},
        )
        real = SimpleNamespace(
            manifest_sha256=sha,
            entries=(
                SimpleNamespace(
                    row_index=0,
                    line_number=1,
                    line_sha256="1" * 64,
                    sample_id="train-a",
                    work_id="work-a",
                    source_catalog_id="catalog-a",
                    work_weight=1.0,
                ),
                SimpleNamespace(
                    row_index=1,
                    line_number=3,
                    line_sha256="3" * 64,
                    sample_id="train-b",
                    work_id="work-b",
                    source_catalog_id="catalog-b",
                    work_weight=1.0,
                ),
            ),
        )
        validation = {
            "build_contract_sha256": r3.v7.base.sha256_file(
                cache / r3.hidden_cache.BUILD_CONTRACT
            ),
            "cache_identity_sha256": "b" * 64,
            "manifest_sha256": r3.v7.base.sha256_file(
                cache / r3.hidden_cache.MANIFEST
            ),
            "master_manifest_sha256": sha,
            "model_contract_sha256": r3.v7.base.sha256_bytes(
                r3.v7.base.canonical_json(model).encode("utf-8")
            ),
            "row_count": 4,
            "sample_index_sha256": r3.v7.base.sha256_file(
                cache / r3.hidden_cache.SAMPLE_INDEX
            ),
            "sample_order_sha256": "c" * 64,
            "status": "valid_siglip2_last_hidden_state_cache",
            "tensor_shape": [
                4,
                len(r3.v7.base.VIEW_NAMES),
                r3.v7.PATCH_COUNT,
                r3.v7.HIDDEN_SIZE,
            ],
            "training_eligible_by_itself": False,
            "view_contract_sha256": r3.v7.base.sha256_bytes(
                r3.v7.base.canonical_json(
                    r3.hidden_cache._view_contract()  # noqa: SLF001
                ).encode("utf-8")
            ),
        }
        args = SimpleNamespace(
            master_hidden_cache_dir=cache,
            master_dir=root / "master",
            master_catalog_registry=root / "registry.json",
        )
        return SimpleNamespace(args=args, plan=plan, validation=validation), real

    def test_loader_binds_only_train_rows_and_reads_random_order(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fixture, real = self._fixture(Path(raw))
            with (
                mock.patch.object(r3.v7.mass21, "MASTER_TOTAL_ROWS", 4),
                mock.patch.object(r3.v7.mass21, "MASTER_TRAIN_ROWS", 2),
                mock.patch.object(
                    r3.hidden_cache, "load_master_plan", return_value=fixture.plan
                ),
                mock.patch.object(
                    r3.hidden_cache,
                    "validate_cache_against_plan",
                    return_value=fixture.validation,
                ),
            ):
                reader = r3._load_master_train_hidden_cache_reader(
                    fixture.args, real
                )

            assert reader is not None
            self.assertEqual([0, 2], [row.cache_index for row in reader.train_rows])
            reversed_entries = (real.entries[1], real.entries[0])
            values = reader.read_real_entries(reversed_entries)
            self.assertEqual(
                (2, 3, r3.v7.PATCH_COUNT, r3.v7.HIDDEN_SIZE), values.shape
            )
            self.assertTrue(np.all(values[0] == np.float16(3.0)))
            self.assertTrue(np.all(values[1] == np.float16(1.0)))

    def test_loader_fails_closed_on_train_sample_identity_drift(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fixture, real = self._fixture(Path(raw))
            drifted = SimpleNamespace(
                manifest_sha256=real.manifest_sha256,
                entries=(
                    SimpleNamespace(**{**vars(real.entries[0]), "sample_id": "wrong"}),
                    real.entries[1],
                ),
            )
            with (
                mock.patch.object(r3.v7.mass21, "MASTER_TOTAL_ROWS", 4),
                mock.patch.object(r3.v7.mass21, "MASTER_TRAIN_ROWS", 2),
                mock.patch.object(
                    r3.hidden_cache, "load_master_plan", return_value=fixture.plan
                ),
                mock.patch.object(
                    r3.hidden_cache,
                    "validate_cache_against_plan",
                    return_value=fixture.validation,
                ),
                self.assertRaises(r3.MangaFontV7Mass21R3Error),
            ):
                r3._load_master_train_hidden_cache_reader(fixture.args, drifted)

    def test_reader_rejects_pooled_tensor_even_after_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fixture, real = self._fixture(Path(raw))
            with (
                mock.patch.object(r3.v7.mass21, "MASTER_TOTAL_ROWS", 4),
                mock.patch.object(r3.v7.mass21, "MASTER_TRAIN_ROWS", 2),
                mock.patch.object(
                    r3.hidden_cache, "load_master_plan", return_value=fixture.plan
                ),
                mock.patch.object(
                    r3.hidden_cache,
                    "validate_cache_against_plan",
                    return_value=fixture.validation,
                ),
            ):
                reader = r3._load_master_train_hidden_cache_reader(
                    fixture.args, real
                )
            assert reader is not None
            descriptor = reader.shards[0]
            array_path = (
                reader.binding.root
                / r3.hidden_cache.SHARDS_DIR
                / str(descriptor["directory"])
                / r3.hidden_cache.SHARD_ARRAY
            )
            np.save(
                array_path,
                np.zeros((2, 3, r3.v7.HIDDEN_SIZE), dtype="<f2"),
            )
            stat = array_path.stat()
            unsafe = r3.MasterTrainHiddenCacheReader(
                binding=reader.binding,
                shards=reader.shards,
                shard_by_cache_index=reader.shard_by_cache_index,
                shard_array_stats=((stat.st_size, stat.st_mtime_ns),)
                + reader.shard_array_stats[1:],
                train_rows=reader.train_rows,
            )
            with self.assertRaisesRegex(
                r3.MangaFontV7Mass21R3Error, "pooled.*forbidden"
            ):
                unsafe.read_real_entries((real.entries[0],))

    def test_cached_batch_does_not_open_or_encode_real_pixels(self) -> None:
        tokens = np.full(
            (1, 3, r3.v7.PATCH_COUNT, r3.v7.HIDDEN_SIZE),
            0.25,
            dtype="<f2",
        )

        class Reader:
            def read_real_entries(self, entries: object) -> np.ndarray:
                self.entries = entries
                return tokens

        reader = Reader()
        entry = SimpleNamespace(row_index=0, sample_id="train-a", work_weight=1.0)
        inputs = SimpleNamespace(
            real=SimpleNamespace(entries=(entry,)),
            human=SimpleNamespace(
                upgraded_full_examples=(),
                partial_examples=(),
            ),
            pseudo=SimpleNamespace(targets={}),
        )
        arrays = {
            "synthetic_tokens": np.empty(
                (0, 3, r3.v7.PATCH_COUNT, r3.v7.HIDDEN_SIZE), dtype="<f2"
            ),
            "synthetic_labels": np.empty((0,), dtype="<i8"),
        }
        batch = r3.v7.mass21.Mass21EpochBatch((0,), (), (), ())
        with (
            r3._activated_master_hidden_cache(reader),
            mock.patch.object(
                r3.v7,
                "_encode_image_groups",
                side_effect=AssertionError("real pixels must not be encoded"),
            ),
            mock.patch.object(
                r3.r2,
                "_normalization_for_inputs",
                return_value=SimpleNamespace(scale=1.0),
            ),
            mock.patch.object(r3.r2, "_nominal_real_batch_size", return_value=1),
        ):
            prepared = r3._open_training_batch(
                torch=torch,
                batch=batch,
                inputs=inputs,
                arrays=arrays,
                lookup=SimpleNamespace(addition_index_by_id={}),
                master_handle=io.BytesIO(),
                master_resolver=None,
                human_resolver=None,
                encoder=None,
                processor=None,
                device=torch.device("cpu"),
            )
        self.assertEqual((1, 3, 196, 768), tuple(prepared["tokens"].shape))
        self.assertTrue(torch.all(prepared["tokens"] == 0.25))
        self.assertEqual(1, prepared["real_count"])


if __name__ == "__main__":
    unittest.main()
