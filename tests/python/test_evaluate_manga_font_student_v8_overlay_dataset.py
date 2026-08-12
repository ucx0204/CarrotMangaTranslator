from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from scripts import augment_manga_font_student_v8_with_high_value_labels as overlay
from scripts import build_manga_font_student_v8_role_family_dataset as dataset
from scripts import evaluate_manga_font_student_v8_role_family as evaluator
from scripts import package_manga_font_student_v8_qa_runtime as package


class MangaFontV8OverlayDatasetEvaluationTests(unittest.TestCase):
    def _fold(self) -> dict[str, object]:
        return {
            "master_source_split": "train",
            "optimizer_split": "val",
            "row_count": 4815,
            "work_ids": ["heldout-work"],
        }

    def test_overlay_profile_preserves_r3_selection_authority(self) -> None:
        profile = evaluator._evaluation_profile(  # noqa: SLF001
            dataset_manifest={
                "adapter_validation_fold": self._fold(),
                "evaluation_base_dataset_npz_sha256": evaluator.R3_DATASET_SHA256,
                "schema_version": overlay.SCHEMA,
            },
            dataset_sha256="a" * 64,
        )
        self.assertEqual(package.ADAPTER_SELECTION_AUTHORITY, profile["authority"])
        self.assertEqual(evaluator.R3_DATASET_SHA256, profile["base_dataset_npz_sha256"])
        self.assertEqual("a" * 64, profile["dataset_npz_sha256"])

    def test_overlay_artifact_requires_explicit_nonrelease_authority_and_base_binding(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "overlay"
            base_root = Path(raw) / "base"
            root.mkdir()
            base_root.mkdir()
            for name in overlay.OUTPUT_FILES:
                (root / name).write_bytes(b"overlay")
            for name in dataset.OUTPUT_FILES:
                (base_root / name).write_bytes(b"base")
            (base_root / dataset.DATASET_FILE).write_bytes(b"base npz")
            (base_root / dataset.MANIFEST_FILE).write_bytes(b"base manifest")
            overlay_npz = root / overlay.DATASET_FILE
            overlay_manifest = {
                "adapter_validation_fold": self._fold(),
                "authority": {
                    "automatic_release_authority": False,
                    "evaluation_authority": False,
                    "human_gold": False,
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "training_eligible": True,
                    "training_only": True,
                },
                "counts": {"val_rows": 9033},
                "dataset": {
                    "byte_size": overlay_npz.stat().st_size,
                    "file": overlay.DATASET_FILE,
                    "sha256": evaluator._sha256_file(overlay_npz),  # noqa: SLF001
                },
                "record_sha256": "1" * 64,
                "record_type": "manga_font_student_v8_high_value_overlay_manifest",
                "schema_version": overlay.SCHEMA,
                "sources": {
                    "base_dataset": {
                        "manifest_sha256": evaluator._sha256_file(  # noqa: SLF001
                            base_root / dataset.MANIFEST_FILE
                        ),
                        "npz_sha256": evaluator._sha256_file(  # noqa: SLF001
                            base_root / dataset.DATASET_FILE
                        ),
                        "output_dir": str(base_root),
                    }
                },
            }
            overlay_report = {
                "record_type": "manga_font_student_v8_high_value_overlay_report",
                "schema_version": overlay.SCHEMA,
            }
            base_manifest = {
                "adapter_validation_fold": self._fold(),
                "counts": {"val_visual_completed_rows": 1047},
                "sources": {"pass": {}, "visual": {}},
            }

            def read_json(path: Path, _location: str) -> dict[str, object]:
                if path == root / overlay.MANIFEST_FILE:
                    return overlay_manifest
                if path == root / overlay.REPORT_FILE:
                    return overlay_report
                if path == base_root / dataset.MANIFEST_FILE:
                    return base_manifest
                raise AssertionError(path)

            with (
                mock.patch.object(overlay, "validate_output", return_value={}),
                mock.patch.object(
                    dataset,
                    "validate_output",
                    return_value={"val_rows": 9033, "work_overlap_count": 0},
                ),
                mock.patch.object(evaluator, "_read_json", side_effect=read_json),
            ):
                artifact = evaluator._validate_dataset_artifact(  # noqa: SLF001
                    root, overlay_npz
                )
                self.assertEqual(
                    evaluator.R3_DATASET_SHA256,
                    artifact["manifest"].get(
                        "evaluation_base_dataset_npz_sha256", ""
                    ),
                ) if evaluator._sha256_file(  # noqa: SLF001
                    base_root / dataset.DATASET_FILE
                ) == evaluator.R3_DATASET_SHA256 else self.assertEqual(
                    evaluator._sha256_file(base_root / dataset.DATASET_FILE),  # noqa: SLF001
                    artifact["manifest"]["evaluation_base_dataset_npz_sha256"],
                )
                self.assertEqual(
                    base_manifest["sources"], artifact["manifest"]["sources"]
                )

                overlay_manifest["authority"]["evaluation_authority"] = True
                with self.assertRaisesRegex(
                    evaluator.MangaFontV8EvaluationError, "authority/source"
                ):
                    evaluator._validate_dataset_artifact(root, overlay_npz)  # noqa: SLF001

    def test_load_overlay_requires_byte_identical_validation_arrays(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            overlay_path = root / "overlay" / dataset.DATASET_FILE
            base_path = root / "base" / dataset.DATASET_FILE
            overlay_path.parent.mkdir()
            base_path.parent.mkdir()
            arrays = {
                "candidate_ids": np.asarray(["font", "single-day"], dtype="<U10"),
                "prototype_queries": np.zeros((2, 1, 1), dtype=np.float32),
                "query_views": np.asarray([[[[1.0]]], [[[2.0]]]], dtype=np.float16),
                "sample_ids": np.asarray(["train", "val"], dtype="<U8"),
                "split": np.asarray([0, 1], dtype=np.int8),
            }
            np.savez(overlay_path, **arrays)
            np.savez(base_path, **arrays)
            contract = {
                name: {"dtype": str(value.dtype), "shape": list(value.shape)}
                for name, value in sorted(arrays.items())
            }
            artifact = {
                "base_dataset_path": base_path,
                "manifest": {
                    "array_contract": contract,
                    "counts": {
                        "train_rows": 1,
                        "val_rows": 1,
                        "work_overlap_count": 0,
                    },
                },
            }
            inventory = {
                "train_rows": 1,
                "val_rows": 1,
                "work_overlap_count": 0,
            }
            with (
                mock.patch.object(
                    evaluator, "_validate_dataset_artifact", return_value=artifact
                ),
                mock.patch.object(
                    dataset, "validate_dataset_arrays", return_value=inventory
                ),
            ):
                _path, _arrays, _manifest, checked = evaluator._load_dataset(  # noqa: SLF001
                    overlay_path
                )
                self.assertTrue(checked["validation_arrays_byte_identical_to_base"])

                drifted = dict(arrays)
                drifted["query_views"] = arrays["query_views"].copy()
                drifted["query_views"][1, 0, 0, 0] = 3.0
                np.savez(base_path, **drifted)
                with self.assertRaisesRegex(
                    evaluator.MangaFontV8EvaluationError,
                    "validation arrays differ",
                ):
                    evaluator._load_dataset(overlay_path)  # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
