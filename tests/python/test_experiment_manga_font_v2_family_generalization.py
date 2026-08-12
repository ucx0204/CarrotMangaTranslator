from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts import experiment_manga_font_v2_family_generalization as experiment


class MangaFontV2FamilyGeneralizationTests(unittest.TestCase):
    def test_work_class_weights_equalize_cells_and_prioritize_authority(self) -> None:
        mask = np.ones(8, dtype=np.bool_)
        labels = np.asarray([0, 0, 0, 1, 1, 0, 1, 1], dtype=np.int64)
        works = np.asarray(["a", "a", "a", "a", "a", "b", "b", "b"])
        authorities = np.asarray(
            ["none", "human", "none", "visual", "human", "human", "none", "human"]
        )
        result = experiment.work_class_weights(
            mask=mask,
            labels=labels,
            work_ids=works,
            authorities=authorities,
            confidence=np.ones(8, dtype=np.float32),
            authority_multipliers={"none": 0.25, "visual": 2.0, "human": 16.0},
        )
        totals = []
        for work in ("a", "b"):
            for family in (0, 1):
                cell = (works == work) & (labels == family)
                totals.append(float(result[cell].sum()))
        np.testing.assert_allclose(totals, np.full(4, totals[0]), rtol=1e-6)
        self.assertGreater(result[1], result[0])

    def test_deterministic_calibration_mask_is_train_only(self) -> None:
        sample_ids = np.asarray([f"sample-{index}" for index in range(100)])
        train = np.arange(100) < 80
        first = experiment.deterministic_calibration_mask(sample_ids, train)
        second = experiment.deterministic_calibration_mask(sample_ids, train)
        np.testing.assert_array_equal(first, second)
        self.assertFalse(first[~train].any())
        self.assertGreater(int(first.sum()), 5)

    def test_apply_logit_calibration_uses_difference_temperature_and_bias(self) -> None:
        logits = np.asarray([[2.0, 4.0], [3.0, 1.0]], dtype=np.float32)
        result = experiment.apply_logit_calibration(logits, 2.0, -0.5)
        np.testing.assert_allclose(result[:, 1] - result[:, 0], [0.5, -1.5])
        self.assertEqual(result.shape, (2, 2))

    def test_family_metrics_reports_balanced_accuracy(self) -> None:
        logits = np.asarray(
            [[2.0, 0.0], [0.0, 2.0], [0.0, 2.0], [0.0, 2.0]],
            dtype=np.float32,
        )
        labels = np.asarray([0, 0, 1, 1], dtype=np.int64)
        metrics = experiment.family_metrics(
            logits, labels, np.ones(4, dtype=np.bool_)
        )
        self.assertEqual(metrics["accuracy"], 0.75)
        self.assertEqual(metrics["body_recall"], 0.5)
        self.assertEqual(metrics["variant_recall"], 1.0)
        self.assertEqual(metrics["balanced_accuracy"], 0.75)

    def test_val33_identity_loader_never_returns_label_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "val33.jsonl"
            rows = []
            for index in range(33):
                rows.append(
                    json.dumps(
                        {
                            "sample_id": f"sample-{index}",
                            "role": {"primary": "dialogue"},
                            "font_judgment": {"preferred": ["secret-font"]},
                        }
                    )
                )
            path.write_text("\n".join(rows) + "\n", encoding="utf-8")
            identities = experiment.load_val33_identities(path)
            self.assertEqual(len(identities), 33)
            self.assertTrue(all(isinstance(value, str) for value in identities))
            self.assertNotIn("secret-font", identities)


if __name__ == "__main__":
    unittest.main()
