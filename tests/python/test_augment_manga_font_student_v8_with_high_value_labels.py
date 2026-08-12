from __future__ import annotations

import unittest

import numpy as np

from scripts import augment_manga_font_student_v8_with_high_value_labels as overlay
from scripts import seal_manga_font_v2_high_value_supervised_labels as labels_artifact
from scripts import train_manga_font_student_v6_mass21_data as mass21


class HighValueDatasetOverlayTests(unittest.TestCase):
    def arrays(self) -> dict[str, np.ndarray]:
        candidates = mass21.candidate_projection(
            mass21.legacy15.FULL22_CANDIDATE_IDS
        ).active_ids
        count = 6
        positive = np.zeros((count, 21), dtype=np.bool_)
        preferred = np.zeros_like(positive)
        eligible = np.zeros_like(positive)
        positive[0, 0] = preferred[0, 0] = eligible[0, 0] = True
        positive[4, 1] = preferred[4, 1] = eligible[4, 1] = True
        prototypes = np.zeros((21, 4, 256), dtype=np.float32)
        prototypes[:, :, 0] = 1.0
        return {
            "candidate_ids": np.asarray(candidates, dtype="<U32"),
            "query_views": np.zeros((count, 3, 4, 256), dtype=np.float16),
            "prototype_queries": prototypes,
            "family_labels": np.asarray([1, 0, 1, 0, 0, 1], dtype=np.int8),
            "family_label_weights": np.ones(count, dtype=np.float32),
            "positive_mask": positive,
            "preferred_mask": preferred,
            "candidate_eligible_mask": eligible,
            "font_supervision_weights": np.asarray(
                [0.8, 0.0, 0.0, 0.0, 1.0, 0.0], dtype=np.float32
            ),
            "single_day_body_negative": np.asarray(
                [False, True, False, True, True, False], dtype=np.bool_
            ),
            "font_authority": np.asarray(
                ["visual", "none", "none", "none", "human", "none"], dtype="<U6"
            ),
            "sample_ids": np.asarray(
                ["train-old", "train-new", "train-b", "train-c", "val-old", "val-b"],
                dtype="<U40",
            ),
            "work_ids": np.asarray(
                ["train-a", "train-a", "train-b", "train-c", "val-a", "val-b"],
                dtype="<U40",
            ),
            "split": np.asarray([0, 0, 0, 0, 1, 1], dtype=np.int8),
        }

    def label(
        self,
        *,
        sample_id: str = "train-new",
        role: str = "dialogue",
        preferred: tuple[str, ...] = ("single-day",),
        positive: tuple[str, ...] = ("single-day", "nanum-gothic"),
        eligible: tuple[str, ...] = ("single-day", "nanum-gothic", "dohyeon"),
    ) -> dict[str, object]:
        family = "body" if role in overlay.BODY_ROLES else "variant"
        return labels_artifact.seal_record(
            {
                "authority": {
                    "automatic_release_authority": False,
                    "calibration_eligible": False,
                    "evaluation_eligible": False,
                    "human_gold": False,
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "training_eligible": True,
                    "training_only": True,
                },
                "candidate_labels": {
                    "eligible_candidate_ids": list(eligible),
                    "positive_candidate_ids": list(positive),
                    "preferred_candidate_ids": list(preferred),
                },
                "family": family,
                "record_type": "manga_font_v2_high_value_training_label",
                "role": role,
                "role_confidence": 0.92,
                "sample_id": sample_id,
                "schema_version": labels_artifact.SCHEMA,
                "supervision_weight": 0.88,
            }
        )

    def test_train_overlay_uses_human_authority_and_masks_body_single_day(self) -> None:
        arrays, summary = overlay.apply_overlay_arrays(self.arrays(), (self.label(),))
        index = tuple(arrays["sample_ids"].tolist()).index("train-new")
        candidates = tuple(arrays["candidate_ids"].tolist())
        single_day = candidates.index("single-day")
        gothic = candidates.index("nanum-gothic")
        self.assertEqual("human", arrays["font_authority"][index])
        self.assertFalse(arrays["positive_mask"][index, single_day])
        self.assertTrue(arrays["candidate_eligible_mask"][index, single_day])
        self.assertTrue(arrays["positive_mask"][index, gothic])
        self.assertFalse(arrays["preferred_mask"][index].any())
        self.assertTrue(arrays["single_day_body_negative"][index])
        self.assertEqual(1, summary["body_single_day_positive_rows_removed"])
        self.assertEqual({"none": 1}, summary["replaced_authority_counts"])

    def test_new_train_label_takes_precedence_over_existing_visual(self) -> None:
        label = self.label(
            sample_id="train-old",
            role="shout",
            preferred=("dohyeon",),
            positive=("dohyeon",),
            eligible=("dohyeon", "nanum-gothic"),
        )
        arrays, summary = overlay.apply_overlay_arrays(self.arrays(), (label,))
        self.assertEqual("human", arrays["font_authority"][0])
        self.assertEqual(1, arrays["family_labels"][0])
        self.assertEqual({"visual": 1}, summary["replaced_authority_counts"])

    def test_validation_identity_is_fail_closed(self) -> None:
        with self.assertRaisesRegex(overlay.HighValueDatasetOverlayError, "optimizer train"):
            overlay.apply_overlay_arrays(
                self.arrays(), (self.label(sample_id="val-old"),)
            )

    def test_human_gold_authority_is_rejected(self) -> None:
        row = self.label()
        row["authority"]["human_gold"] = True  # type: ignore[index]
        row = labels_artifact.seal_record(row)
        with self.assertRaisesRegex(
            overlay.HighValueDatasetOverlayError, "training-only"
        ):
            overlay.apply_overlay_arrays(self.arrays(), (row,))

    def test_candidate_nesting_and_only_single_day_body_fail_closed(self) -> None:
        invalid = self.label(
            preferred=("dohyeon",),
            positive=("nanum-gothic",),
            eligible=("nanum-gothic", "dohyeon"),
        )
        with self.assertRaisesRegex(overlay.HighValueDatasetOverlayError, "nesting"):
            overlay.apply_overlay_arrays(self.arrays(), (invalid,))
        only_single_day = self.label(
            preferred=("single-day",),
            positive=("single-day",),
            eligible=("single-day", "nanum-gothic"),
        )
        with self.assertRaisesRegex(overlay.HighValueDatasetOverlayError, "only positive"):
            overlay.apply_overlay_arrays(self.arrays(), (only_single_day,))


if __name__ == "__main__":
    unittest.main()
