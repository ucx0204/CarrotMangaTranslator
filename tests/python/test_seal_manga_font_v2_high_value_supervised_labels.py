from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts import seal_manga_font_v2_high_value_supervised_labels as labels


class HighValueSupervisedLabelTests(unittest.TestCase):
    def test_candidate_ids_are_projected_in_active_order(self) -> None:
        order = {"a": 0, "b": 1, "c": 2}
        self.assertEqual(("a", "b"), labels.sorted_candidate_ids(("b", "a", "b"), order))
        with self.assertRaisesRegex(labels.HighValueSupervisedLabelError, "active21"):
            labels.sorted_candidate_ids(("outside",), order)

    def test_output_projection_rejects_private_model_fields(self) -> None:
        labels.assert_no_private_model_fields({"candidate_labels": {"positive": ["a"]}})
        with self.assertRaisesRegex(labels.HighValueSupervisedLabelError, "forbidden"):
            labels.assert_no_private_model_fields({"model_probability_for_sampling": 0.5})
        with self.assertRaisesRegex(labels.HighValueSupervisedLabelError, "forbidden"):
            labels.assert_no_private_model_fields({"nested": {"notes": "leak"}})

    def test_legacy_blind_pool_without_purpose_is_conservatively_held_out(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "private.jsonl"
            path.write_text(
                json.dumps({"sample_id": "legacy-row"})
                + "\n"
                + json.dumps({"sample_id": "cal-row", "purpose": "calibration"})
                + "\n"
                + json.dumps({"sample_id": "eval-row", "purpose": "evaluation"})
                + "\n",
                encoding="utf-8",
            )
            calibration, evaluation, descriptors = labels.blind_pool_ids((path,))
        self.assertEqual({"legacy-row", "cal-row"}, calibration)
        self.assertEqual({"legacy-row", "eval-row"}, evaluation)
        self.assertEqual(3, descriptors[0]["row_count"])

    def test_parser_accepts_disjoint_review_artifacts_for_one_expected_span(self) -> None:
        args = labels.build_parser().parse_args(
            [
                "build",
                "--output-dir",
                "out",
                "--review-dir",
                "review-001-200",
                "--review-dir",
                "review-201-400",
                "--expected-start-row",
                "1",
                "--expected-end-row",
                "400",
            ]
        )
        self.assertEqual(
            [Path("review-001-200"), Path("review-201-400")], args.review_dir
        )
        self.assertEqual((1, 400), (args.expected_start_row, args.expected_end_row))

    def test_adapter_validation_work_is_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "manifest.json").write_text("{}\n", encoding="utf-8")
            np.savez(
                root / "role-family-dataset.npz",
                sample_ids=np.asarray(["train", "val"], dtype="<U8"),
                split=np.asarray([0, 1], dtype=np.int8),
                work_ids=np.asarray(["shared", "shared"], dtype="<U8"),
            )
            with self.assertRaisesRegex(
                labels.HighValueSupervisedLabelError,
                "adapter-validation work leaked",
            ):
                labels.load_base_split(root)


if __name__ == "__main__":
    unittest.main()
