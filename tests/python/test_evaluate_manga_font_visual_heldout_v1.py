from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "evaluate_manga_font_visual_heldout_v1.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "evaluate_manga_font_visual_heldout_v1_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


EVALUATOR = load_script()
ACTIVE = EVALUATOR._active_ids()


def prediction(sample_id: str, ranking: tuple[str, ...], split: str = "val"):
    probabilities = [0.0] * len(ACTIVE)
    for rank, font_id in enumerate(ranking):
        probabilities[ACTIVE.index(font_id)] = float(len(ACTIVE) - rank)
    total = sum(probabilities)
    probabilities = tuple(value / total for value in probabilities)
    return EVALUATOR.Prediction(
        sample_id=sample_id,
        split=split,
        work_id="work",
        chapter_id="chapter",
        page_id=f"page-{sample_id}",
        master_row_sha256=(sample_id.encode().hex() + "0" * 64)[:64],
        source_category="bubble_edge",
        source_kind="hard",
        source_row_index=1,
        candidate_ids=ACTIVE,
        probabilities=probabilities,
        ranking=ranking,
        record_sha256=("a" + sample_id.encode().hex() + "0" * 64)[:64],
    )


def decision(
    sample_id: str,
    kind: str,
    *,
    selected: str | None,
    acceptable: tuple[str, ...] = (),
    cohort: str = "val",
    split: str = "val",
):
    return EVALUATOR.HeldoutDecision(
        sample_id=sample_id,
        split=split,
        cohort=cohort,
        decision_kind=kind,
        review_item_sha256="b" * 64,
        reviewed_font_ids=ACTIVE[:5],
        selected_font_id=selected,
        acceptable_font_ids=acceptable,
        source_top1_font_id=ACTIVE[0],
        decision_sha256="c" * 64,
        role="dialogue",
        source_category="bubble_edge",
    )


class VisualHeldoutEvaluatorTests(unittest.TestCase):
    def fixture(self):
        baseline_ranking = tuple(ACTIVE)
        improved_ranking = (ACTIVE[1], ACTIVE[2], ACTIVE[0], *ACTIVE[3:])
        correction = decision(
            "correction",
            "correction",
            selected=ACTIVE[1],
            acceptable=(ACTIVE[2],),
        )
        confirmed = decision("confirmed", "confirmed", selected=ACTIVE[0])
        unresolved = decision("unresolved", "review_needed", selected=None)
        decisions = {
            row.sample_id: row for row in (correction, confirmed, unresolved)
        }
        baseline = {
            sample_id: prediction(sample_id, baseline_ranking)
            for sample_id in decisions
        }
        candidate = {
            "correction": prediction("correction", improved_ranking),
            "confirmed": prediction("confirmed", baseline_ranking),
            "unresolved": prediction("unresolved", improved_ranking),
        }
        return decisions, baseline, candidate

    def test_metrics_cover_correction_confirmation_and_unresolved(self) -> None:
        decisions, baseline, candidate = self.fixture()
        rows = EVALUATOR.build_evaluation_rows(decisions, baseline, candidate)
        metrics = EVALUATOR.compute_report_metrics(rows)["all_visual_qa"]
        self.assertEqual(1, metrics["correction"]["rows"])
        self.assertEqual(0.0, metrics["correction"]["baseline"]["selected_at1"])
        self.assertEqual(1.0, metrics["correction"]["candidate"]["selected_at1"])
        self.assertEqual(1, metrics["comparison"]["improved"])
        self.assertEqual(1, metrics["comparison"]["same"])
        self.assertEqual(1.0, metrics["confirmed"]["baseline_top1_retention_rate"])
        self.assertEqual(1, metrics["review_needed"]["rows"])
        self.assertTrue(metrics["review_needed"]["correctness_metrics_excluded"])

    def test_identity_drift_fails_closed(self) -> None:
        decisions, baseline, candidate = self.fixture()
        broken = candidate["correction"]
        candidate["correction"] = EVALUATOR.Prediction(
            **{**broken.__dict__, "chapter_id": "wrong-chapter"}
        )
        with self.assertRaisesRegex(
            EVALUATOR.VisualHeldoutEvaluationError, "identity binding drifted"
        ):
            EVALUATOR.build_evaluation_rows(decisions, baseline, candidate)

    def test_evaluate_writes_and_revalidates_read_only_artifact(self) -> None:
        decisions, baseline, candidate = self.fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"

            def load_pass(_path, *, wanted_ids, name):
                self.assertEqual(set(decisions), wanted_ids)
                values = baseline if name == "baseline" else candidate
                return values, {
                    "file": f"{name}.jsonl",
                    "report_sha256": name[0] * 64,
                    "review_predictions_sha256": name[-1] * 64,
                    "row_count": len(values),
                    "model": {"name": name},
                }

            with (
                mock.patch.object(
                    EVALUATOR,
                    "_load_heldout",
                    return_value=(
                        decisions,
                        {
                            "file": "heldout.jsonl",
                            "row_count": len(decisions),
                            "sha256": "d" * 64,
                        },
                    ),
                ),
                mock.patch.object(EVALUATOR, "_load_pass", side_effect=load_pass),
            ):
                result = EVALUATOR.evaluate(
                    baseline_review_predictions=root / "baseline.jsonl",
                    candidate_review_predictions=root / "candidate.jsonl",
                    heldout_decisions=root / "heldout.jsonl",
                    output_dir=output,
                    expected_heldout_rows=3,
                )
            self.assertEqual(3, result["rows"])
            self.assertEqual(
                "validated_read_only_visual_qa_not_independent_gold",
                result["status"],
            )
            report = json.loads((output / EVALUATOR.REPORT_FILE).read_text())
            self.assertFalse(report["authority"]["human_gold"])
            self.assertFalse(report["authority"]["independent_gold"])
            self.assertFalse(report["authority"]["quality_gate_authority"])
            self.assertFalse(report["authority"]["training_eligible"])
            self.assertIn("dialogue", report["metrics"]["by_role"])
            self.assertIn("bubble_edge", report["metrics"]["by_source_category"])

    def test_tampered_evaluation_row_fails_validation(self) -> None:
        decisions, baseline, candidate = self.fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            with (
                mock.patch.object(
                    EVALUATOR,
                    "_load_heldout",
                    return_value=(decisions, {"file": "heldout", "row_count": 3}),
                ),
                mock.patch.object(
                    EVALUATOR,
                    "_load_pass",
                    side_effect=[
                        (baseline, {"file": "baseline"}),
                        (candidate, {"file": "candidate"}),
                    ],
                ),
            ):
                EVALUATOR.evaluate(
                    baseline_review_predictions=root / "baseline.jsonl",
                    candidate_review_predictions=root / "candidate.jsonl",
                    heldout_decisions=root / "heldout.jsonl",
                    output_dir=output,
                    expected_heldout_rows=3,
                )
            rows_path = output / EVALUATOR.ROWS_FILE
            rows = rows_path.read_text(encoding="utf-8").splitlines()
            row = json.loads(rows[0])
            row["training_eligible"] = True
            rows[0] = json.dumps(row)
            rows_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
            with self.assertRaises(EVALUATOR.VisualHeldoutEvaluationError):
                EVALUATOR.validate_output(output)


if __name__ == "__main__":
    unittest.main()
