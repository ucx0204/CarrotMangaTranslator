from __future__ import annotations

import json
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "bind_manga_font_v2_blind_calibration_labels.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "bind_manga_font_v2_blind_calibration_labels_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


binding = load_script()


ARTIFACT = (
    ROOT
    / "artifacts"
    / "manga-font-v2-bound-blind-calibration-labels-cal001-160-v2"
)


class BlindCalibrationBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _score_bundle(
        self, *, extra_first_row: tuple[str, object] | None = None
    ) -> tuple[Path, Path]:
        report = binding.validate_label_artifact(ARTIFACT)
        labels = [
            json.loads(line)
            for line in (ARTIFACT / "calibration-labels.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        candidate_ids = report["candidate_ids"]
        rng = np.random.default_rng(20260811)
        score_rows = []
        for index, label in enumerate(labels):
            scores = rng.normal(0.0, 0.6, len(candidate_ids))
            for candidate_id in label["font_judgment"]["preferred"]:
                scores[candidate_ids.index(candidate_id)] += 0.9
            row = {
                "candidate_ids": candidate_ids,
                "candidate_scores": [float(value) for value in scores],
                "record_type": binding.SCORE_ROW_RECORD,
                "sample_id": label["sample_id"],
                "schema_version": binding.SCORE_ROW_SCHEMA,
            }
            if index == 0 and extra_first_row is not None:
                row[extra_first_row[0]] = extra_first_row[1]
            score_rows.append(binding.seal_record(row))
        scores_path = self.root / "scores.jsonl"
        binding._write_jsonl(scores_path, score_rows)  # noqa: SLF001
        manifest = binding.seal_record(
            {
                "active_catalog_sha256": report["bindings"][
                    "active_catalog_sha256"
                ],
                "calibration_labels_sha256": binding.sha256_file(
                    ARTIFACT / "calibration-labels.jsonl"
                ),
                "candidate_order_sha256": binding._candidate_order_sha(  # noqa: SLF001
                    candidate_ids
                ),
                "record_type": binding.SCORE_MANIFEST_RECORD,
                "row_count": len(labels),
                "runtime_lineage": {
                    "encoder_onnx_sha256": "a" * 64,
                    "ranker_onnx_sha256": "b" * 64,
                    "runtime_contract_sha256": "c" * 64,
                },
                "schema_version": binding.SCORE_MANIFEST_SCHEMA,
                "score_route": binding.SCORE_ROUTE,
                "score_rows_sha256": binding.sha256_file(scores_path),
                "score_semantics": binding.SCORE_SEMANTICS,
            }
        )
        manifest_path = self.root / "score-manifest.json"
        manifest_path.write_bytes(binding.json_bytes(manifest, pretty=True))
        return manifest_path, scores_path

    def test_repository_artifact_is_sealed_145_plus_15_calibration_only(self) -> None:
        report = binding.validate_label_artifact(ARTIFACT)

        self.assertEqual(report["boundary"]["calibration_completed_rows"], 145)
        self.assertEqual(report["boundary"]["catalog_gap_rows_excluded"], 12)
        self.assertEqual(report["boundary"]["crop_reject_rows_excluded"], 3)
        self.assertFalse(report["boundary"]["private_binding_tail_json_decoded"])
        self.assertFalse(report["boundary"]["private_binding_tail_raw_bytes_read"])
        self.assertEqual(report["split_statistics"]["fold_count"], 3)
        self.assertEqual(report["split_statistics"]["unique_page_count"], 115)
        self.assertTrue(report["split_statistics"]["page_group_isolation"])
        self.assertFalse(
            report["authority"]["automatic_model_training_human_promotion_allowed"]
        )
        self.assertFalse(report["authority"]["human_gold"])
        self.assertFalse(report["authority"]["training_eligible"])
        labels = [
            json.loads(line)
            for line in (ARTIFACT / "calibration-labels.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        self.assertTrue(
            all(
                set(row["font_judgment"]["preferred"])
                <= set(row["font_judgment"]["acceptable"])
                for row in labels
            )
        )

    def test_prefix_reader_never_decodes_the_tail(self) -> None:
        path = self.root / "private.jsonl"
        path.write_text('{"sample_id":"calibration"}\nNOT-JSON-EVALUATION-TAIL\n', encoding="utf-8")

        rows = binding._read_jsonl_prefix(path, 1, "test prefix")  # noqa: SLF001

        self.assertEqual(rows, [{"sample_id": "calibration"}])
        with self.assertRaisesRegex(binding.BlindCalibrationBindingError, "invalid JSON"):
            binding._read_jsonl_prefix(path, 2, "test prefix")  # noqa: SLF001

    def test_all_160_materialized_blind_decisions_have_valid_row_seals(self) -> None:
        crossreview = (
            ROOT
            / "artifacts"
            / "manga-font-v2-blind-crossreview-public-cal001-160-r1"
        )
        paths = (
            crossreview / "validated-decisions-cal001-080.jsonl",
            crossreview / "validated-decisions-cal081-160.jsonl",
        )
        rows = []
        for path in paths:
            rows.extend(json.loads(line) for line in path.read_text(encoding="utf-8").splitlines())

        self.assertEqual(len(rows), 160)
        for index, row in enumerate(rows, 1):
            binding.validate_record_seal(row, f"decision:{index}")

    def test_score_bundle_rejects_selection_reason_even_when_resealed(self) -> None:
        manifest_path, scores_path = self._score_bundle(
            extra_first_row=("selection_reason", "forbidden")
        )
        labels, candidate_ids, report = binding._load_fit_labels(ARTIFACT)  # noqa: SLF001

        with self.assertRaisesRegex(
            binding.BlindCalibrationBindingError, "exact-key contract"
        ):
            binding._load_scores(  # noqa: SLF001
                score_manifest_path=manifest_path,
                scores_path=scores_path,
                labels_path=ARTIFACT / "calibration-labels.jsonl",
                active_catalog_sha256=report["bindings"][
                    "active_catalog_sha256"
                ],
                candidate_ids=candidate_ids,
                expected_sample_ids=[label.sample_id for label in labels],
            )

    def test_synthetic_r3h_scores_produce_sealed_three_work_oof_fit(self) -> None:
        manifest_path, scores_path = self._score_bundle()
        output = self.root / "fit.json"

        record = binding.fit_r3h_scores(
            artifact_dir=ARTIFACT,
            score_manifest_path=manifest_path,
            scores_path=scores_path,
            output_path=output,
            C_grid=(0.03, 0.1),
        )

        self.assertEqual(binding.validate_fit(record)["record_sha256"], record["record_sha256"])
        self.assertEqual(len(record["oof_report"]["folds"]), 3)
        self.assertTrue(record["oof_report"]["work_group_oof"])
        self.assertEqual(record["supervision_boundary"]["sample_count"], 145)
        self.assertEqual(record["supervision_boundary"]["evaluation_rows_used"], 0)
        self.assertFalse(record["authority"]["deployment_attachment_allowed"])
        self.assertFalse(record["authority"]["human_gold"])
        self.assertNotIn("predictions", binding.canonical_json(record))
        self.assertNotIn("selection_reason", binding.canonical_json(record))


if __name__ == "__main__":
    unittest.main()
