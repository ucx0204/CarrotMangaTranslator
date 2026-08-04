from __future__ import annotations

import unittest
from types import MappingProxyType

import numpy as np

from scripts import prepare_manga_font_student_v5 as prep
from scripts import train_manga_font_student_v1 as base


def authority(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "base_partial_record_sha256": "a" * 64,
        "completed_human_visual_provenance": True,
        "fabricated_new7_negative_count": 0,
        "fresh64_overlap_count": 0,
        "legacy15_membership_sha256": "b" * 64,
        "new7_candidate_ids": ["new-c"],
        "new7_visual_judgment_record_count": 1,
        "old15_membership_mutation_count": 0,
        "qa40_overlap_count": 0,
        "split": "train",
        "status": prep.UPGRADE_STATUS,
        "test_overlap_count": 0,
        "upgraded_record_count": 1,
        "val_overlap_count": 0,
    }
    value.update(overrides)
    return value


def full22_example() -> base.HumanExample:
    return base.HumanExample(
        sample_id="legacy-one",
        work_id="train-work",
        split="train",
        positive_indices=(0, 2),
        eligible_indices=(0, 1, 2),
        none_target=0.0,
        role_index=base.ROLE_VALUES.index("sfx_impact"),
        style_values=tuple(0.0 for _ in base.STYLE_FIELDS),
        style_mask=tuple(False for _ in base.STYLE_FIELDS),
        treatment_indices=tuple(0 for _ in base.TREATMENT_VALUES),
        row=MappingProxyType(
            {
                "font_judgment": {
                    "acceptable": ["new-c"],
                    "not_reviewed": [],
                    "preferred": ["old-a"],
                    "unrenderable": [],
                },
                "provenance": {"approval": "completed_human_final_label"},
                "review_provenance": {
                    "authority": {"new7_visual_judgment_completed": True}
                },
            }
        ),
    )


class PrepareMangaFontStudentV5Test(unittest.TestCase):
    def test_expected_hit_gate_is_exact(self) -> None:
        metrics = {
            "acceptable_at1": 21 / 33,
            "evaluated_positive_rows": 33,
            "preferred_at1": 13 / 33,
            "variant_acceptable_at1": 16 / 28,
            "variant_preferred_at1": 8 / 28,
            "variant_val_rows": 28,
        }
        prep._assert_expected_hits(metrics, location="test")  # noqa: SLF001
        metrics["preferred_at1"] = 12 / 33
        with self.assertRaisesRegex(prep.MangaFontV5PreparationError, "expected 13"):
            prep._assert_expected_hits(metrics, location="test")  # noqa: SLF001

    def test_upgrade_authority_rejects_fabricated_new7_negative(self) -> None:
        with self.assertRaisesRegex(prep.MangaFontV5PreparationError, "unsafe"):
            prep.validate_upgrade_authority(
                authority(fabricated_new7_negative_count=1),
                expected_new7=("new-c",),
            )

    def test_full22_upgrade_changes_only_supervision_arrays(self) -> None:
        candidates = ("old-a", "old-b", "new-c")
        contract = {
            "human_train": [
                {
                    "sample_id": "legacy-one",
                    "supervision": {
                        "not_reviewed_candidate_ids": ["new-c"],
                        "partial_candidate_supervision": True,
                    },
                }
            ]
        }
        arrays = {
            "human_train_embeddings": np.ones((1, 3, 2), dtype="<f4"),
            "human_train_full22": np.asarray([False], dtype=np.bool_),
            "human_train_masks": np.asarray([[True, True, False]], dtype=np.bool_),
            "human_train_none": np.asarray([0.0], dtype="<f4"),
            "human_train_none_mask": np.asarray([False], dtype=np.bool_),
            "human_train_role": np.asarray(
                [base.ROLE_VALUES.index("sfx_impact")], dtype="<i8"
            ),
            "human_train_style": np.zeros((1, len(base.STYLE_FIELDS)), dtype="<f4"),
            "human_train_targets": np.asarray([[2.0, 0.0, 0.0]], dtype="<f4"),
            "human_train_treatment": np.zeros(
                (1, len(base.TREATMENT_VALUES)), dtype="<i8"
            ),
        }
        upgraded, report = prep.apply_full22_upgrade_examples_to_cache(
            contract=contract,
            arrays=arrays,
            examples=(full22_example(),),
            candidate_ids=candidates,
            authority_validation=authority(),
        )
        np.testing.assert_array_equal(
            upgraded["human_train_targets"], [[2.0, 0.0, 1.0]]
        )
        np.testing.assert_array_equal(
            upgraded["human_train_masks"], [[True, True, True]]
        )
        np.testing.assert_array_equal(upgraded["human_train_full22"], [True])
        np.testing.assert_array_equal(
            upgraded["human_train_embeddings"], arrays["human_train_embeddings"]
        )
        self.assertEqual(report["fabricated_new7_negative_count"], 0)

    def test_continuation_plan_keeps_encoder_blocked(self) -> None:
        plan = prep._continuation_plan()  # noqa: SLF001
        self.assertEqual(plan["encoder_policy"]["initial_phase_encoder_executions"], 0)
        self.assertFalse(plan["encoder_policy"]["unfreeze_allowed"])
        self.assertEqual(plan["maximum_trials"], 4)


if __name__ == "__main__":
    unittest.main()
