from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from scripts import build_manga_font_student_v8_role_family_dataset as dataset
from scripts import evaluate_manga_font_student_v8_role_family as evaluator


class MangaFontV8VisualHoldoutEvaluationTests(unittest.TestCase):
    def _candidate_ids(self) -> tuple[str, ...]:
        return tuple(f"font-{index:02d}" for index in range(20)) + ("single-day",)

    def _mock_evaluation_inputs(
        self, root: Path, *, row_count: int = 400, overlap: bool = False
    ) -> tuple[dict[str, np.ndarray], dict[str, object], dict[str, object]]:
        candidates = self._candidate_ids()
        train_rows = 1
        total = train_rows + row_count
        split = np.ones(total, dtype=np.int8)
        split[0] = 0
        authorities = np.full(total, "visual", dtype="<U6")
        authorities[0] = "none"
        weights = np.ones(total, dtype=np.float32)
        weights[0] = 0.0
        work_ids = np.asarray(
            ["work-0" if overlap else "train-work"]
            + [f"work-{index % 4}" for index in range(row_count)],
            dtype="<U16",
        )
        sample_ids = np.asarray(
            ["train-sample"] + [f"sample-{index:04d}" for index in range(row_count)],
            dtype="<U24",
        )
        positive = np.zeros((total, len(candidates)), dtype=bool)
        preferred = np.zeros_like(positive)
        eligible = np.zeros_like(positive)
        positive[1:, 0] = True
        preferred[1:, 0] = True
        eligible[1:, :5] = True
        arrays = {
            "candidate_ids": np.asarray(candidates, dtype="<U32"),
            "query_views": np.zeros((total, 3, 4, 256), dtype=np.float16),
            "prototype_queries": np.zeros((len(candidates), 4, 256), dtype=np.float32),
            "family_labels": np.zeros(total, dtype=np.int8),
            "family_label_weights": np.ones(total, dtype=np.float32),
            "positive_mask": positive,
            "preferred_mask": preferred,
            "candidate_eligible_mask": eligible,
            "font_supervision_weights": weights,
            "single_day_body_negative": np.zeros(total, dtype=bool),
            "font_authority": authorities,
            "sample_ids": sample_ids,
            "work_ids": work_ids,
            "split": split,
        }
        manifest: dict[str, object] = {
            "counts": {"val_visual_completed_rows": row_count}
        }
        roles = {
            sample_id: dataset.PassRow(
                sample_id=sample_id,
                work_id=str(work_ids[index]),
                split="val",
                role="dialogue",
                source_category="ordinary",
                master_row_sha256="a" * 64,
            )
            for index, sample_id in enumerate(sample_ids[1:].tolist(), 1)
        }
        visual = {
            sample_id: dataset.VisualFontLabel(
                sample_id=sample_id,
                selected_id=candidates[0],
                acceptable_ids=(),
                reviewed_ids=tuple(reversed(candidates[:5])),
                confidence=1.0,
                decision_kind="confirmed",
            )
            for sample_id in sample_ids[1:].tolist()
        }
        auxiliary = {"roles": roles, "visual": visual}
        (root / dataset.DATASET_FILE).write_bytes(b"sealed-dataset")
        (root / dataset.MANIFEST_FILE).write_text("{}\n", encoding="utf-8")
        return arrays, manifest, auxiliary

    def test_build_rows_accepts_reviewed_set_in_display_order(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            arrays, _manifest, auxiliary = self._mock_evaluation_inputs(
                root, row_count=1
            )
            outputs = {
                "body_candidate_scores": np.asarray(
                    [[10.0, *([0.0] * 20)]], dtype=np.float32
                ),
                "variant_candidate_scores": np.asarray(
                    [[9.0, *([0.0] * 20)]], dtype=np.float32
                ),
                "family_logits": np.asarray([[10.0, 0.0]], dtype=np.float32),
            }

            rows = evaluator._build_rows(  # noqa: SLF001
                arrays=arrays,
                indices=np.asarray([1]),
                outputs=outputs,
                roles=auxiliary["roles"],
                visual_labels=auxiliary["visual"],
            )

        self.assertEqual(rows[0]["preferred_font_id"], "font-00")
        self.assertTrue(rows[0]["preferred_hit"])
        self.assertFalse(rows[0]["human_gold"])
        self.assertEqual(rows[0]["authority"], evaluator.AUTHORITY)

    def test_production_route_masks_single_day_before_top1_metrics(self) -> None:
        outputs = {
            "body_candidate_scores": np.asarray(
                [[0.0, 3.0], [0.0, 0.0], [0.0, 0.0]], dtype=np.float32
            ),
            "variant_candidate_scores": np.asarray(
                [[0.0, 0.0], [0.0, 3.0], [0.0, 1.0]], dtype=np.float32
            ),
            "family_logits": np.asarray(
                [[3.0, -3.0], [-0.4, 0.4], [-2.0, 2.0]], dtype=np.float32
            ),
        }

        routed = evaluator._production_route(  # noqa: SLF001
            outputs, single_day_index=1
        )

        self.assertEqual([1, 1, 1], routed["raw_scores"].argmax(axis=1).tolist())
        self.assertEqual(
            [0, 0, 1], routed["deployed_scores"].argmax(axis=1).tolist()
        )
        self.assertEqual([False, False, True], routed["single_day_allowed"].tolist())

    def test_evaluate_rejects_small_or_work_overlapping_holdout(self) -> None:
        for row_count, overlap in ((399, False), (400, True)):
            with self.subTest(row_count=row_count, overlap=overlap):
                with tempfile.TemporaryDirectory() as raw:
                    root = Path(raw)
                    arrays, manifest, _auxiliary = self._mock_evaluation_inputs(
                        root, row_count=row_count, overlap=overlap
                    )
                    with mock.patch.object(
                        evaluator,
                        "_load_dataset",
                        return_value=(
                            root / dataset.DATASET_FILE,
                            arrays,
                            manifest,
                            {},
                        ),
                    ):
                        with self.assertRaisesRegex(
                            evaluator.MangaFontV8EvaluationError,
                            ">=400 completed visual rows",
                        ):
                            evaluator.evaluate(
                                dataset_npz=root / dataset.DATASET_FILE,
                                adapter_dir=root / "adapter",
                                output_dir=root / "output",
                                device="cpu",
                            )

    def test_sealed_producer_and_authority_tamper_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            arrays, manifest, auxiliary = self._mock_evaluation_inputs(root)
            row_count = 400
            arrays["positive_mask"][201:, 0] = False
            arrays["preferred_mask"][201:, 0] = False
            arrays["positive_mask"][201:, 1] = True
            arrays["preferred_mask"][201:, 1] = True
            for sample_id in arrays["sample_ids"][201:].tolist():
                auxiliary["visual"][sample_id] = dataset.VisualFontLabel(
                    sample_id=sample_id,
                    selected_id="font-01",
                    acceptable_ids=(),
                    reviewed_ids=tuple(reversed(self._candidate_ids()[:5])),
                    confidence=1.0,
                    decision_kind="confirmed",
                )
            body_scores = np.zeros((row_count, 21), dtype=np.float32)
            body_scores[:200, 0] = 10.0
            body_scores[200:, 1] = 10.0
            outputs = {
                "body_candidate_scores": body_scores,
                "variant_candidate_scores": body_scores.copy(),
                "family_logits": np.tile(
                    np.asarray([[10.0, 0.0]], dtype=np.float32), (row_count, 1)
                ),
            }
            adapter = {
                "checkpoint_sha256": "1" * 64,
                "manifest_sha256": "2" * 64,
                "training_quality_gate_passed": True,
            }
            with (
                mock.patch.object(
                    evaluator,
                    "_load_dataset",
                    return_value=(
                        root / dataset.DATASET_FILE,
                        arrays,
                        manifest,
                        {"work_overlap_count": 0},
                    ),
                ),
                mock.patch.object(
                    evaluator,
                    "_load_reporting_roles",
                    return_value=(
                        auxiliary["roles"],
                        {"report_sha256": "3" * 64, "review_sha256": "4" * 64},
                    ),
                ),
                mock.patch.object(
                    evaluator,
                    "_load_visual_authority",
                    return_value=(
                        auxiliary["visual"],
                        {"manifest_sha256": "5" * 64, "report_sha256": "6" * 64},
                    ),
                ),
                mock.patch.object(
                    evaluator, "_load_adapter", return_value=(None, None, adapter)
                ),
                mock.patch.object(evaluator, "_infer", return_value=outputs),
            ):
                result = evaluator.evaluate(
                    dataset_npz=root / dataset.DATASET_FILE,
                    adapter_dir=root / "adapter",
                    output_dir=root / "output",
                    device="cpu",
                )

            self.assertTrue(result["quality_gate_passed"])
            report_path = root / "output" / evaluator.REPORT_FILE
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["authority"]["human_gold"] = True
            report.pop("record_sha256")
            report_path.write_bytes(
                evaluator._json_bytes(evaluator._seal(report), pretty=True)  # noqa: SLF001
            )
            marker_path = root / "output" / evaluator.MARKER_FILE
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["artifacts"][evaluator.REPORT_FILE] = evaluator._sha256_file(  # noqa: SLF001
                report_path
            )
            marker.pop("record_sha256")
            marker_path.write_bytes(
                evaluator._json_bytes(evaluator._seal(marker), pretty=True)  # noqa: SLF001
            )

            with self.assertRaisesRegex(
                evaluator.MangaFontV8EvaluationError,
                "authority was upgraded",
            ):
                evaluator.validate_output(root / "output")


if __name__ == "__main__":
    unittest.main()
