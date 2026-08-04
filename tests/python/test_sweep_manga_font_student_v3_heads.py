from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType

import numpy as np
import torch

from scripts import sweep_manga_font_student_v3_heads as sweep
from scripts import train_manga_font_student_v1 as base


def synthetic(sample_id: str, font_id: str) -> base.SyntheticExample:
    return base.SyntheticExample(
        sample_id=sample_id,
        split="train",
        font_id=font_id,
        label_index=0,
        views=MappingProxyType({}),
    )


class SweepMangaFontStudentV3HeadsTest(unittest.TestCase):
    def test_balanced_subset_is_equal_per_font_and_signature_diverse(self) -> None:
        candidates = ("font-a", "font-b")
        examples = []
        metadata = {}
        roles = ("dialogue", "shout", "sfx_impact", "sign_ui_title")
        for font_id in candidates:
            for index in range(32):
                sample_id = f"{font_id}-{index:02d}"
                examples.append(synthetic(sample_id, font_id))
                metadata[sample_id] = {
                    "augmentation": {
                        "angle_degrees": 8.0 if (index // 8) % 2 else 0.0,
                        "slant": 0.0,
                        "stroke_width_px": 1,
                    },
                    "orientation": (
                        "vertical" if (index // 4) % 2 else "horizontal"
                    ),
                    "role": roles[index % len(roles)],
                    "text": "테스트",
                }
        selected = sweep.select_balanced_synthetic_subset(
            examples,
            candidate_ids=candidates,
            metadata=metadata,
            per_font=16,
        )
        self.assertEqual(len(selected), 32)
        self.assertEqual(sum(row.font_id == "font-a" for row in selected), 16)
        self.assertEqual(sum(row.font_id == "font-b" for row in selected), 16)

    def test_trial_grid_is_bounded_to_four(self) -> None:
        grid = sweep._trial_grid(4)  # noqa: SLF001
        self.assertEqual(len(grid), 4)
        self.assertEqual({row["partial_row_weight"] for row in grid}, {0.75, 1.0})
        with self.assertRaisesRegex(sweep.MangaFontV3SweepError, "1..4"):
            sweep._trial_grid(5)  # noqa: SLF001

    def test_cache_and_sweep_inventories_are_distinct(self) -> None:
        self.assertIn(sweep.CACHE_ARRAYS, sweep.CACHE_FILES)
        self.assertIn(sweep.SWEEP_CHECKPOINT, sweep.SWEEP_FILES)
        self.assertNotEqual(sweep.CACHE_SCHEMA, sweep.SWEEP_SCHEMA)

    def test_human_arrays_preserve_partial_candidate_and_none_masks(self) -> None:
        candidates = ("old-a", "old-b", "new-c")
        example = base.HumanExample(
            sample_id="legacy-row",
            work_id="train-work",
            split="train",
            positive_indices=(0,),
            eligible_indices=(0, 1),
            none_target=0.0,
            role_index=base.ROLE_VALUES.index("sfx_impact"),
            style_values=tuple(0.0 for _ in base.STYLE_FIELDS),
            style_mask=tuple(False for _ in base.STYLE_FIELDS),
            treatment_indices=tuple(0 for _ in base.TREATMENT_VALUES),
            row=MappingProxyType(
                {
                    "font_judgment": {
                        "preferred": ["old-a"],
                        "acceptable": [],
                        "not_reviewed": ["new-c"],
                        "unrenderable": [],
                    }
                }
            ),
        )
        arrays = sweep._human_arrays((example,), candidates)  # noqa: SLF001
        np.testing.assert_array_equal(arrays["masks"], [[True, True, False]])
        np.testing.assert_array_equal(arrays["none_mask"], [False])
        np.testing.assert_array_equal(arrays["full22"], [False])

    def test_source_balanced_batch_is_half_full22_half_partial(self) -> None:
        mask = torch.tensor([True, True, False, False, False, False])
        indices = sweep._source_balanced_human_indices(  # noqa: SLF001
            torch,
            full22_mask=mask,
            batch_size=8,
            generator=torch.Generator().manual_seed(3),
        )
        self.assertEqual(int(mask[indices].sum()), 4)
        self.assertEqual(int((~mask[indices]).sum()), 4)

    def test_cache_npz_roundtrip_preserves_partial_scope_keys(self) -> None:
        arrays = {
            "human_train_full22": np.asarray([True, False], dtype=np.bool_),
            "human_train_none_mask": np.asarray([True, False], dtype=np.bool_),
            "human_train_masks": np.asarray(
                [[True, True, True], [True, True, False]], dtype=np.bool_
            ),
        }
        contract = sweep._array_contract(arrays)  # noqa: SLF001
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "cache.npz"
            np.savez(path, **arrays)
            with np.load(path, allow_pickle=False) as restored:
                self.assertEqual(set(restored.files), set(contract))
                for name in restored.files:
                    self.assertEqual(list(restored[name].shape), contract[name]["shape"])
                    self.assertEqual(str(restored[name].dtype), contract[name]["dtype"])
        self.assertEqual(contract["human_train_full22"]["shape"], [2])


if __name__ == "__main__":
    unittest.main()
