from __future__ import annotations

import unittest
from types import SimpleNamespace

import numpy as np

from scripts import build_manga_font_student_v8_role_family_dataset as dataset
from scripts import train_manga_font_student_v6_mass21_data as mass21


class V8RoleFamilyDatasetTests(unittest.TestCase):
    def arrays(self) -> dict[str, np.ndarray]:
        candidate_ids = mass21.candidate_projection(
            mass21.legacy15.FULL22_CANDIDATE_IDS
        ).active_ids
        count = 4
        prototypes = np.zeros((21, 4, 256), dtype=np.float32)
        prototypes[:, :, 0] = 1.0
        positive = np.zeros((count, 21), dtype=np.bool_)
        preferred = np.zeros_like(positive)
        eligible = np.zeros_like(positive)
        positive[0, 0] = preferred[0, 0] = True
        eligible[0, :5] = True
        positive[1, 1] = preferred[1, 1] = True
        eligible[1, 1] = True
        return {
            "candidate_ids": np.asarray(candidate_ids, dtype="<U32"),
            "query_views": np.zeros((count, 3, 4, 256), dtype=np.float16),
            "prototype_queries": prototypes,
            "family_labels": np.asarray([1, 0, 0, 1], dtype=np.int8),
            "family_label_weights": np.asarray([0.7, 1.0, 0.8, 0.5], dtype=np.float32),
            "positive_mask": positive,
            "preferred_mask": preferred,
            "candidate_eligible_mask": eligible,
            "font_supervision_weights": np.asarray([0.9, 1.0, 0.0, 0.0], dtype=np.float32),
            "single_day_body_negative": np.asarray([False, True, True, False]),
            "font_authority": np.asarray(["visual", "human", "none", "none"], dtype="<U6"),
            "sample_ids": np.asarray(["s0", "s1", "s2", "s3"], dtype="<U40"),
            "work_ids": np.asarray(["val-a", "train-a", "train-b", "val-b"], dtype="<U40"),
            "split": np.asarray([1, 0, 0, 1], dtype=np.int8),
        }

    def test_valid_exact_contract(self) -> None:
        result = dataset.validate_dataset_arrays(
            self.arrays(), expected_train_rows=2, expected_val_rows=2
        )
        self.assertEqual(result["row_count"], 4)
        self.assertEqual(result["font_authority_counts"], {"human": 1, "none": 2, "visual": 1})

    def test_none_authority_cannot_carry_font_masks(self) -> None:
        arrays = self.arrays()
        arrays["positive_mask"][2, 3] = True
        arrays["candidate_eligible_mask"][2, 3] = True
        with self.assertRaisesRegex(dataset.V8RoleFamilyDatasetError, "pseudo-only"):
            dataset.validate_dataset_arrays(arrays)

    def test_visual_scope_is_exactly_five_candidates(self) -> None:
        arrays = self.arrays()
        arrays["candidate_eligible_mask"][0, 5] = True
        with self.assertRaisesRegex(dataset.V8RoleFamilyDatasetError, "shown five"):
            dataset.validate_dataset_arrays(arrays)

    def test_train_validation_work_overlap_fails(self) -> None:
        arrays = self.arrays()
        arrays["work_ids"][0] = "train-a"
        with self.assertRaisesRegex(dataset.V8RoleFamilyDatasetError, "work leakage"):
            dataset.validate_dataset_arrays(arrays)

    def test_single_day_positive_cancels_body_negative(self) -> None:
        arrays = self.arrays()
        single_day = tuple(arrays["candidate_ids"].tolist()).index("single-day")
        arrays["positive_mask"][1, single_day] = True
        arrays["candidate_eligible_mask"][1, single_day] = True
        with self.assertRaisesRegex(dataset.V8RoleFamilyDatasetError, "Single Day"):
            dataset.validate_dataset_arrays(arrays)

    def test_role_family_partition(self) -> None:
        self.assertEqual(dataset.role_family("dialogue"), dataset.BODY_FAMILY)
        self.assertEqual(dataset.role_family("whisper"), dataset.VARIANT_FAMILY)
        self.assertEqual(dataset.role_family("aside_balloon_edge"), dataset.VARIANT_FAMILY)
        self.assertEqual(dataset.role_family("sfx_impact"), dataset.VARIANT_FAMILY)
        with self.assertRaises(dataset.V8RoleFamilyDatasetError):
            dataset.role_family("not-a-role")

    def test_zero_family_weight_fails(self) -> None:
        arrays = self.arrays()
        arrays["family_label_weights"][2] = 0.0
        with self.assertRaisesRegex(dataset.V8RoleFamilyDatasetError, "family weights"):
            dataset.validate_dataset_arrays(arrays)

    def test_source_category_is_family_authority_for_non_human_rows(self) -> None:
        self.assertEqual(dataset.source_category_role("ordinary"), "dialogue")
        self.assertEqual(dataset.source_category_role("bubble_edge"), "aside_balloon_edge")
        self.assertEqual(
            dataset.role_family(dataset.source_category_role("bubble_edge")),
            dataset.VARIANT_FAMILY,
        )

    def test_validation_slices_use_existing_authority_and_family_fields(self) -> None:
        slices = dataset.validation_slice_counts(self.arrays())
        self.assertEqual(slices["row_count"], 2)
        self.assertEqual(
            slices["authority_counts"], {"human": 0, "none": 1, "visual": 1}
        )
        self.assertEqual(slices["family_counts"], {"body": 0, "variant": 2})
        self.assertEqual(slices["font_supervised_rows"], 1)

    def test_r3_npz_inventory_remains_trainer_compatible(self) -> None:
        self.assertTrue(dataset.SCHEMA.endswith("-v3"))
        self.assertEqual(set(self.arrays()), dataset.NPZ_FIELDS)

    def test_complete_supported_work_moves_to_adapter_validation(self) -> None:
        rows = (
            SimpleNamespace(sample_id="a", split="train", work_id="train-a"),
            SimpleNamespace(
                sample_id="b",
                split="train",
                work_id=dataset.BODY_HOLDOUT_WORK_ID,
            ),
            SimpleNamespace(
                sample_id="c",
                split="train",
                work_id=dataset.BODY_HOLDOUT_WORK_ID,
            ),
            SimpleNamespace(sample_id="d", split="val", work_id="val-a"),
            SimpleNamespace(sample_id="e", split="test", work_id="test-a"),
        )
        train, val, moved = dataset.partition_master_rows(
            rows, (dataset.BODY_HOLDOUT_WORK_ID,)
        )
        self.assertEqual([row.sample_id for row in train], ["a"])
        self.assertEqual([row.sample_id for row in val], ["d", "b", "c"])
        self.assertEqual([row.sample_id for row in moved], ["b", "c"])
        self.assertNotIn("e", {row.sample_id for row in (*train, *val)})

    def test_unsupported_adapter_validation_work_fails_closed(self) -> None:
        rows = (SimpleNamespace(sample_id="a", split="train", work_id="x"),)
        with self.assertRaisesRegex(dataset.V8RoleFamilyDatasetError, "unsupported"):
            dataset.partition_master_rows(rows, ("x",))

    def test_split_slices_include_single_day_counts(self) -> None:
        slices = dataset.split_slice_counts(self.arrays())
        self.assertEqual(slices["train"]["row_count"], 2)
        self.assertEqual(slices["val"]["row_count"], 2)
        self.assertEqual(slices["train"]["single_day_body_negative_rows"], 2)
        self.assertEqual(slices["val"]["single_day_positive_rows"], 0)


if __name__ == "__main__":
    unittest.main()
