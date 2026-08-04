from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_manga_font_master_v3_siglip2_hidden_cache.py"
SPEC = importlib.util.spec_from_file_location(
    "build_manga_font_master_v3_siglip2_hidden_cache_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
CACHE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CACHE
SPEC.loader.exec_module(CACHE)


class FakeImage:
    def __init__(self, value: int) -> None:
        self.value = value
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeEncoder:
    def __init__(self, *, fail_after_calls: int | None = None) -> None:
        self.calls = 0
        self.closed = False
        self.fail_after_calls = fail_after_calls

    def encode(self, images: tuple[FakeImage, ...]) -> np.ndarray:
        if self.fail_after_calls is not None and self.calls >= self.fail_after_calls:
            raise RuntimeError("injected encoder interruption")
        self.calls += 1
        result = np.empty(
            (len(images), CACHE.PATCH_COUNT, CACHE.HIDDEN_SIZE), dtype="<f2"
        )
        for index, image in enumerate(images):
            result[index].fill(float(image.value))
        return result

    def close(self) -> None:
        self.closed = True


def fake_loader(binding: object, _handle: object) -> tuple[FakeImage, ...]:
    start = int(binding.cache_index) * CACHE.VIEW_COUNT
    return tuple(FakeImage(start + view) for view in range(CACHE.VIEW_COUNT))


def make_plan(
    root: Path,
    *,
    splits: tuple[str, ...] = ("train", "val", "test"),
    master_total_rows: int | None = None,
) -> object:
    rows = tuple(
        CACHE.MasterRowBinding(
            cache_index=index,
            master_row_index=index,
            line_number=index + 1,
            byte_offset=index * 100,
            byte_length=100,
            sample_id=f"fm_{index:024x}",
            split=split,
            work_id=f"work-{split}",
            source_catalog_id="catalog-a",
            master_line_sha256=f"{index + 1:064x}",
            view_contract_sha256=f"{index + 101:064x}",
        )
        for index, split in enumerate(splits)
    )
    payload = CACHE._index_payload(rows)
    selected_counts = {
        name: sum(row.split == name for row in rows)
        for name in ("train", "val", "test")
    }
    total = len(rows) if master_total_rows is None else master_total_rows
    master_counts = dict(selected_counts)
    master_counts["train"] += total - len(rows)
    return CACHE.MasterCachePlan(
        master_dir=root / "master",
        manifest_path=root / "master" / "manifest.jsonl",
        catalog_registry=root / "registry.json",
        source_bindings={
            "catalog_registry_record_sha256": "a" * 64,
            "catalog_registry_sha256": "b" * 64,
            "master_manifest_sha256": "c" * 64,
            "master_report_sha256": "d" * 64,
            "master_split_map_sha256": "e" * 64,
        },
        rows=rows,
        master_total_rows=total,
        master_split_counts=master_counts,
        selected_split_counts=selected_counts,
        max_samples=None if total == len(rows) else len(rows),
        sample_index_payload=payload,
        sample_index_sha256=CACHE._sha256_bytes(payload),
        sample_order_sha256=CACHE._sha256_bytes(
            "\n".join(row.sample_id for row in rows).encode("utf-8")
        ),
    )


class HiddenStateCacheTest(unittest.TestCase):
    def test_exact_patch_tensor_contract_rejects_pooled_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pooled = root / "pooled.npy"
            with pooled.open("wb") as handle:
                np.save(
                    handle,
                    np.zeros((2, 3, CACHE.HIDDEN_SIZE), dtype="<f2"),
                    allow_pickle=False,
                )
            with self.assertRaisesRegex(CACHE.HiddenStateCacheError, "pooled"):
                CACHE.validate_hidden_states_array(pooled, 2)

            malformed_root = root / "old-cache"
            malformed_root.mkdir()
            (malformed_root / "sample-features.npy").write_bytes(b"pooled")
            with self.assertRaisesRegex(CACHE.HiddenStateCacheError, "pooled"):
                CACHE.validate_cache(
                    malformed_root,
                    master_dir=root / "master",
                    catalog_registry=root / "registry.json",
                )

    def test_cache_identity_binds_order_master_model_and_views(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            plan = make_plan(Path(temporary))
            baseline = CACHE.make_build_contract(plan, shard_size=2, device="cuda")

            reversed_rows = tuple(reversed(plan.rows))
            reversed_rows = tuple(
                replace(row, cache_index=index)
                for index, row in enumerate(reversed_rows)
            )
            reversed_payload = CACHE._index_payload(reversed_rows)
            reordered = replace(
                plan,
                rows=reversed_rows,
                sample_index_payload=reversed_payload,
                sample_index_sha256=CACHE._sha256_bytes(reversed_payload),
                sample_order_sha256=CACHE._sha256_bytes(
                    "\n".join(row.sample_id for row in reversed_rows).encode("utf-8")
                ),
            )
            self.assertNotEqual(
                baseline["cache_identity_sha256"],
                CACHE.make_build_contract(reordered, shard_size=2, device="cuda")[
                    "cache_identity_sha256"
                ],
            )

            changed_source = replace(
                plan,
                source_bindings={**plan.source_bindings, "master_manifest_sha256": "f" * 64},
            )
            self.assertNotEqual(
                baseline["cache_identity_sha256"],
                CACHE.make_build_contract(changed_source, shard_size=2, device="cuda")[
                    "cache_identity_sha256"
                ],
            )

            changed_row = replace(plan.rows[0], view_contract_sha256="9" * 64)
            view_rows = (changed_row, *plan.rows[1:])
            view_payload = CACHE._index_payload(view_rows)
            changed_views = replace(
                plan,
                rows=view_rows,
                sample_index_payload=view_payload,
                sample_index_sha256=CACHE._sha256_bytes(view_payload),
            )
            self.assertNotEqual(
                baseline["cache_identity_sha256"],
                CACHE.make_build_contract(changed_views, shard_size=2, device="cuda")[
                    "cache_identity_sha256"
                ],
            )
            with mock.patch.object(CACHE, "MODEL_REVISION", "changed-revision"):
                changed_model = CACHE.make_build_contract(
                    plan, shard_size=2, device="cuda"
                )
            self.assertNotEqual(
                baseline["cache_identity_sha256"],
                changed_model["cache_identity_sha256"],
            )

    def test_mock_build_is_sealed_resumable_and_explicit_about_splits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = make_plan(root)
            output = root / "cache"
            encoder = FakeEncoder()
            report = CACHE.build_cache(
                plan=plan,
                output_dir=output,
                shard_size=2,
                image_batch_size=6,
                device="cuda",
                resume=False,
                encoder_factory=lambda: encoder,
                image_loader=fake_loader,
            )
            self.assertEqual(report["row_count"], 3)
            self.assertEqual(report["shard_count"], 2)
            self.assertTrue(report["includes_validation_features"])
            self.assertTrue(report["includes_test_features"])
            self.assertFalse(report["training_eligible_by_itself"])
            self.assertEqual(report["tensor_shape"], [3, 3, 196, 768])
            self.assertTrue(encoder.closed)

            manifest = CACHE._read_json(output / CACHE.MANIFEST, "manifest")
            self.assertFalse(manifest["authority"]["cache_is_label_authority"])
            self.assertEqual(manifest["boundaries"]["labels_stored"], 0)
            self.assertEqual(manifest["boundaries"]["test_feature_count"], 1)
            self.assertEqual(manifest["boundaries"]["validation_feature_count"], 1)

            resumed = CACHE.build_cache(
                plan=plan,
                output_dir=output,
                shard_size=2,
                image_batch_size=6,
                device="cuda",
                resume=True,
                encoder_factory=lambda: self.fail("completed resume loaded encoder"),
                image_loader=fake_loader,
            )
            self.assertEqual(resumed["cache_identity_sha256"], report["cache_identity_sha256"])

    def test_interrupted_build_reuses_completed_atomic_shard(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = make_plan(root)
            output = root / "cache"
            failing = FakeEncoder(fail_after_calls=1)
            with self.assertRaisesRegex(RuntimeError, "injected"):
                CACHE.build_cache(
                    plan=plan,
                    output_dir=output,
                    shard_size=1,
                    image_batch_size=3,
                    device="cuda",
                    resume=False,
                    encoder_factory=lambda: failing,
                    image_loader=fake_loader,
                )
            completed_before_resume = tuple(
                item
                for item in (output / CACHE.SHARDS_DIR).iterdir()
                if CACHE.SHARD_PATTERN.fullmatch(item.name)
            )
            self.assertEqual(len(completed_before_resume), 1)
            self.assertFalse(
                any(item.name.startswith(".staging") for item in (output / CACHE.SHARDS_DIR).iterdir())
            )

            resumed_encoder = FakeEncoder()
            report = CACHE.build_cache(
                plan=plan,
                output_dir=output,
                shard_size=1,
                image_batch_size=3,
                device="cuda",
                resume=True,
                encoder_factory=lambda: resumed_encoder,
                image_loader=fake_loader,
            )
            self.assertEqual(report["shard_count"], 3)
            self.assertEqual(resumed_encoder.calls, 2)

    def test_tampered_hidden_state_shard_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = make_plan(root, splits=("train",))
            output = root / "cache"
            CACHE.build_cache(
                plan=plan,
                output_dir=output,
                shard_size=1,
                image_batch_size=3,
                device="cuda",
                resume=False,
                encoder_factory=FakeEncoder,
                image_loader=fake_loader,
            )
            shard = next((output / CACHE.SHARDS_DIR).iterdir())
            feature_path = shard / CACHE.SHARD_ARRAY
            with feature_path.open("r+b") as handle:
                handle.seek(-1, 2)
                original = handle.read(1)
                handle.seek(-1, 2)
                handle.write(bytes([original[0] ^ 0x01]))
            with self.assertRaisesRegex(CACHE.HiddenStateCacheError, "descriptor"):
                CACHE.validate_cache_against_plan(output, plan=plan)

    def test_bounded_prefix_reports_capacity_without_gaining_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            plan = make_plan(
                Path(temporary), splits=("test", "train", "val"), master_total_rows=8
            )
            summary = CACHE.preflight_summary(plan, shard_size=2, device="cpu")
            self.assertEqual(summary["selected_row_count"], 3)
            self.assertEqual(summary["master_row_count"], 8)
            self.assertEqual(summary["shard_count"], 2)
            self.assertFalse(summary["authority"]["cache_is_label_authority"])
            self.assertEqual(
                summary["estimated_selected_payload_bytes"],
                3 * CACHE.BYTES_PER_SAMPLE,
            )


if __name__ == "__main__":
    unittest.main()
