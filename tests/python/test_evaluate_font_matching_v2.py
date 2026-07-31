from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "evaluate_font_matching_v2.py"
SPEC = importlib.util.spec_from_file_location("evaluate_font_matching_v2", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT}")
EVAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = EVAL
SPEC.loader.exec_module(EVAL)


CANDIDATES = ("font-a", "font-b", "font-c", "font-d")
MODEL_SHA = EVAL.sha256_bytes(b"fixture-model")
CURRENT_SHA = EVAL.sha256_bytes(b"fixture-current-rule")
MAJORITY_SHA = EVAL.sha256_bytes(b"fixture-role-work-majority")
FONT_CATALOG_SHA = EVAL.sha256_bytes(b"fixture-font-catalog")


def sha(label: str) -> str:
    return EVAL.sha256_bytes(label.encode("utf-8"))


def jsonl_bytes(rows: list[dict]) -> bytes:
    return b"".join(
        json.dumps(
            row, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        + b"\n"
        for row in rows
    )


def write_json(path: Path, value: object) -> None:
    path.write_bytes(EVAL.canonical_json_bytes(value, pretty=True))


def descriptor(path: Path, count: int) -> dict:
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "record_count": count,
        "sha256": EVAL.sha256_file(path),
    }


def judgment(*, none: bool = False) -> dict:
    if none:
        return {
            "preferred": [],
            "acceptable": [],
            "marginal": ["font-a"],
            "unacceptable": ["font-b", "font-c", "font-d"],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": True,
        }
    return {
        "preferred": ["font-a"],
        "acceptable": ["font-b"],
        "marginal": ["font-c"],
        "unacceptable": ["font-d"],
        "unrenderable": [],
        "not_reviewed": [],
        "none_acceptable": False,
    }


def style(*, handwritten: float = 0.0) -> dict:
    return {
        "serifness": 0.25,
        "weight": 0.5,
        "width": 0.5,
        "roundness": 0.25,
        "stroke_contrast": 0.25,
        "handwritten": handwritten,
        "angularity": 0.25,
        "irregularity": handwritten,
        "slant": 0.0,
        "energy": 0.5,
        "unknown_fields": [],
    }


def treatment(
    *, orientation: str = "vertical", outline: str = "none", fill: str = "solid"
) -> dict:
    return {
        "orientation": orientation,
        "outline": outline,
        "shadow": "none",
        "fill": fill,
        "distortion": "none",
    }


SPECS = (
    {
        "sample_id": "test-dialogue",
        "work_id": "work-test-a",
        "split": "test",
        "role": "dialogue",
        "style": style(),
        "treatment": treatment(orientation="vertical"),
        "cohorts": [],
    },
    {
        "sample_id": "test-aside",
        "work_id": "work-test-a",
        "split": "test",
        "role": "aside_balloon_edge",
        "style": style(handwritten=1.0),
        "treatment": treatment(
            orientation="horizontal", outline="double", fill="inverse"
        ),
        "cohorts": ["hard_color_extreme"],
        "manual_recrop": True,
    },
    {
        "sample_id": "test-sfx",
        "work_id": "work-test-b",
        "split": "test",
        "role": "sfx_impact",
        "style": style(handwritten=0.75),
        "treatment": treatment(orientation="vertical", outline="double"),
        "cohorts": ["page_sound"],
    },
    {
        "sample_id": "test-emphasis",
        "work_id": "work-test-b",
        "split": "test",
        "role": "emphasis_dialogue",
        "style": style(),
        "treatment": treatment(orientation="horizontal"),
        "cohorts": [],
    },
    {
        "sample_id": "test-thought",
        "work_id": "work-test-c",
        "split": "test",
        "role": "thought",
        "style": style(),
        "treatment": treatment(orientation="vertical"),
        "cohorts": [],
    },
    {
        "sample_id": "test-none",
        "work_id": "work-test-c",
        "split": "test",
        "role": "sfx_ambient",
        "style": style(handwritten=1.0),
        "treatment": treatment(orientation="horizontal"),
        "cohorts": ["text_free"],
        "none": True,
    },
    {
        "sample_id": "test-narration",
        "work_id": "work-test-d",
        "split": "test",
        "role": "narration",
        "style": style(),
        "treatment": treatment(orientation="horizontal"),
        "cohorts": [],
    },
    {
        "sample_id": "test-sfx-motion",
        "work_id": "work-test-d",
        "split": "test",
        "role": "sfx_motion",
        "style": style(handwritten=0.8),
        "treatment": treatment(orientation="vertical", outline="single"),
        "cohorts": [],
    },
    {
        "sample_id": "train-only",
        "work_id": "work-train",
        "split": "train",
        "role": "dialogue",
        "style": style(),
        "treatment": treatment(),
        "cohorts": [],
    },
    {
        "sample_id": "val-only",
        "work_id": "work-val",
        "split": "val",
        "role": "dialogue",
        "style": style(),
        "treatment": treatment(),
        "cohorts": [],
    },
)


class Fixture:
    def __init__(self, root: Path):
        self.root = root
        self.export_root = root / "training-export"
        self.export_root.mkdir()
        self.samples = self.export_root / "samples.jsonl"
        self.listwise = self.export_root / "listwise.jsonl"
        self.manifest = self.export_root / "manifest.json"
        self.model_predictions = root / "model.jsonl"
        self.current_predictions = root / "current.jsonl"
        self.majority_predictions = root / "majority.jsonl"
        self.sample_rows: list[dict] = []
        self.listwise_rows: list[dict] = []
        self._build_export()
        self._write_prediction_sets()

    def _build_export(self) -> None:
        for index, spec in enumerate(SPECS):
            sample_id = str(spec["sample_id"])
            is_manual = bool(spec.get("manual_recrop", False))
            row = EVAL.seal(
                {
                    "chapter_id": f"chapter-{index}",
                    "cohorts": copy.deepcopy(spec["cohorts"]),
                    "consistency": {
                        "policy": "inherit_work_anchor",
                        "reason_code": "ordinary_dialogue",
                    },
                    "example_id": f"example-{sample_id}",
                    "font_judgment": judgment(none=bool(spec.get("none", False))),
                    "input_bindings": {
                        "font_catalog_sha256": FONT_CATALOG_SHA,
                        "master_manifest_sha256": sha("master"),
                        "render_bank_manifest_sha256": sha("render-bank"),
                        "render_specification_sha256": sha("render-spec"),
                        "renderer_hash": sha("renderer"),
                    },
                    "page_id": f"page-{index}",
                    "provenance": {
                        "approval": "completed_human_final_label",
                        "master": {"qa_overlay": False, "synthetic": False},
                        "qa_overlay": False,
                        "synthetic": False,
                    },
                    "review_provenance": {
                        "final_record_sha256": sha(f"final-{sample_id}"),
                        "resolution": {
                            "flags": ["manual_recrop_resolved"] if is_manual else [],
                            "kind": "adjudicated" if is_manual else "primary",
                        },
                        "review_card_used_as_training_input": False,
                        "source_reviews": [],
                    },
                    "role": {"primary": spec["role"], "confidence": 0.95},
                    "sample_id": sample_id,
                    "schema_version": EVAL.SAMPLE_SCHEMA_VERSION,
                    "source": {
                        "geometry": {"bbox_px": [1, 2, 30, 40]},
                        "sample_crop_sha256": sha(f"crop-{sample_id}"),
                        "source_page_sha256": sha(f"page-{sample_id}"),
                        "views": {},
                    },
                    "source_style": copy.deepcopy(spec["style"]),
                    "split": spec["split"],
                    "treatment": copy.deepcopy(spec["treatment"]),
                    "work_id": spec["work_id"],
                }
            )
            target_by_candidate = {
                candidate: tier
                for tier in (*EVAL.RANKED_TIERS, *EVAL.SKIPPED_TIERS)
                for candidate in row["font_judgment"][tier]
            }
            candidate_targets = []
            for candidate in CANDIDATES:
                tier = target_by_candidate[candidate]
                eligible = tier in EVAL.RANKED_TIERS
                candidate_targets.append(
                    {
                        "candidate_id": candidate,
                        "loss_eligible": eligible,
                        "relevance_gain": EVAL.TIER_GAIN[tier] if eligible else None,
                        "tier": tier,
                    }
                )
            listwise = EVAL.seal(
                {
                    "abstain_target": row["font_judgment"]["none_acceptable"],
                    "candidate_targets": candidate_targets,
                    "example_id": f"listwise-{sample_id}",
                    "sample_id": sample_id,
                    "schema_version": EVAL.LISTWISE_SCHEMA_VERSION,
                    "split": spec["split"],
                    "training_sample_record_sha256": row["record_sha256"],
                    "work_id": spec["work_id"],
                }
            )
            self.sample_rows.append(row)
            self.listwise_rows.append(listwise)
        self.samples.write_bytes(jsonl_bytes(self.sample_rows))
        self.listwise.write_bytes(jsonl_bytes(self.listwise_rows))
        work_split = {str(spec["work_id"]): str(spec["split"]) for spec in SPECS}
        write_json(
            self.manifest,
            {
                "artifacts": {
                    "listwise.jsonl": descriptor(
                        self.listwise, len(self.listwise_rows)
                    ),
                    "samples.jsonl": descriptor(self.samples, len(self.sample_rows)),
                },
                "candidate_count": len(CANDIDATES),
                "input_hashes": {
                    "finals_sha256": sha("finals"),
                    "master_manifest_sha256": sha("master"),
                },
                "real_sample_count": len(self.sample_rows),
                "renderer_bindings": {
                    "font_catalog_sha256": FONT_CATALOG_SHA,
                    "render_bank_manifest_sha256": sha("render-bank"),
                    "render_specification_sha256": sha("render-spec"),
                    "renderer_hash": sha("renderer"),
                },
                "schema_version": EVAL.EXPORT_SCHEMA_VERSION,
                "work_split": work_split,
            },
        )
        write_json(
            self.export_root / EVAL.EXPORT_MARKER_FILE,
            {
                "manifest_sha256": EVAL.sha256_file(self.manifest),
                "owner": EVAL.EXPORT_OWNER,
                "report_sha256": sha("export-report"),
                "safe_replace": True,
                "schema_version": EVAL.EXPORT_SCHEMA_VERSION,
            },
        )

    def prediction_rows(
        self,
        *,
        model_id: str,
        model_sha: str,
        good: bool,
        include_semantics: bool,
        genre_good: bool = True,
    ) -> list[dict]:
        manifest_sha = EVAL.sha256_file(self.manifest)
        sample_by_id = {row["sample_id"]: row for row in self.sample_rows}
        listwise_by_id = {row["sample_id"]: row for row in self.listwise_rows}
        output = []
        for spec in SPECS:
            if spec["split"] != "test":
                continue
            sample_id = str(spec["sample_id"])
            sample = sample_by_id[sample_id]
            target_none = bool(sample["font_judgment"]["none_acceptable"])
            ranking = (
                ["font-a", "font-b", "font-c", "font-d"]
                if good
                else ["font-d", "font-c", "font-b", "font-a"]
            )
            genre_ranking = (
                ranking if genre_good else ["font-d", "font-c", "font-b", "font-a"]
            )
            record = {
                "bindings": {
                    "font_catalog_sha256": FONT_CATALOG_SHA,
                    "listwise_target_record_sha256": listwise_by_id[sample_id][
                        "record_sha256"
                    ],
                    "training_export_manifest_sha256": manifest_sha,
                    "training_sample_record_sha256": sample["record_sha256"],
                },
                "confidence": 0.95,
                "model": {"id": model_id, "sha256": model_sha},
                "none_probability": 0.95 if good and target_none else 0.05,
                "ranked_candidate_ids": ranking,
                "sample_id": sample_id,
                "schema_version": EVAL.PREDICTION_SCHEMA_VERSION,
                "split": "test",
                "variants": {
                    "no_genre": {
                        "confidence": 0.95,
                        "none_probability": 0.95 if target_none else 0.05,
                        "ranked_candidate_ids": genre_ranking,
                    },
                    "swapped_genre": {
                        "confidence": 0.95,
                        "none_probability": 0.95 if target_none else 0.05,
                        "ranked_candidate_ids": genre_ranking,
                    },
                },
                "work_id": spec["work_id"],
            }
            if include_semantics:
                record.update(
                    {
                        "role": {"primary": spec["role"]},
                        "source_style": {
                            field: spec["style"][field] for field in EVAL.STYLE_FIELDS
                        },
                        "treatment": copy.deepcopy(spec["treatment"]),
                    }
                )
            output.append(EVAL.seal(record))
        return output

    def _write_prediction_sets(self) -> None:
        self.write_predictions(
            self.model_predictions,
            self.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
            ),
        )
        self.write_predictions(
            self.current_predictions,
            self.prediction_rows(
                model_id="current-rule",
                model_sha=CURRENT_SHA,
                good=False,
                include_semantics=False,
            ),
        )
        self.write_predictions(
            self.majority_predictions,
            self.prediction_rows(
                model_id="role-work-majority",
                model_sha=MAJORITY_SHA,
                good=False,
                include_semantics=False,
            ),
        )

    @staticmethod
    def write_predictions(path: Path, rows: list[dict]) -> None:
        path.write_bytes(jsonl_bytes(rows))

    def kwargs(self) -> dict:
        return {
            "bootstrap_iterations": 300,
            "bootstrap_seed": "fixture-bootstrap-v1",
            "current_rule_predictions": self.current_predictions,
            "evaluation_split": "test",
            "listwise": self.listwise,
            "majority_predictions": self.majority_predictions,
            "none_threshold": 0.5,
            "predictions": self.model_predictions,
            "samples": self.samples,
            "training_export_manifest": self.manifest,
        }


class FontMatchingV2EvaluationTest(unittest.TestCase):
    def test_passing_report_has_metrics_breakdowns_bootstraps_and_gates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            report = EVAL.evaluate_files(**fixture.kwargs())
            self.assertTrue(report["frozen_test"])
            self.assertTrue(report["all_gates_pass"])
            self.assertEqual(0, report["not_evaluable_gate_count"])
            overall = report["systems"]["model"]["overall"]
            self.assertEqual(1.0, overall["preferred_at_1"])
            self.assertEqual(1.0, overall["acceptable_at_1"])
            self.assertEqual(1.0, overall["acceptable_at_3"])
            self.assertEqual(1.0, overall["tier_ndcg"])
            self.assertEqual(1.0, overall["pairwise_agreement"])
            self.assertEqual(1.0, overall["none"]["precision"])
            self.assertEqual(1.0, overall["none"]["recall"])
            self.assertEqual(1.0, overall["none"]["f1"])
            self.assertEqual(1.0, overall["role_accuracy"])
            self.assertEqual(0.0, overall["style_mae"])
            self.assertEqual(1.0, overall["treatment_accuracy"])
            self.assertEqual(4, len(report["systems"]["model"]["by_work"]))
            self.assertIn(
                "lower_10_percentile",
                report["systems"]["model"]["macro"]["work"]["acceptable_at_1"],
            )
            for cohort in EVAL.CORE_COHORTS:
                self.assertIn(cohort, report["systems"]["model"]["by_cohort"])
                self.assertEqual(
                    "pass",
                    report["gates"]["core_cohort_regression"][cohort]["status"],
                )
            self.assertGreater(
                report["comparisons"]["current_rule"]["ci95"]["lower"], 0.0
            )
            self.assertEqual(
                report,
                EVAL.evaluate_files(**fixture.kwargs()),
            )

    def test_failing_baselines_and_genre_counterfactuals_fail_gates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            equal_rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=False,
                include_semantics=True,
            )
            fixture.write_predictions(fixture.model_predictions, equal_rows)
            report = EVAL.evaluate_files(**fixture.kwargs())
            self.assertFalse(report["all_gates_pass"])
            self.assertEqual(
                "fail",
                report["gates"]["baseline_superiority"]["current_rule"]["status"],
            )

        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            genre_rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
                genre_good=False,
            )
            fixture.write_predictions(fixture.model_predictions, genre_rows)
            report = EVAL.evaluate_files(**fixture.kwargs())
            self.assertFalse(report["all_gates_pass"])
            self.assertEqual(
                "fail", report["gates"]["genre_robustness"]["no_genre"]["status"]
            )
            self.assertGreater(
                report["gates"]["genre_robustness"]["no_genre"]["observed"],
                EVAL.GENRE_REMOVAL_MAX_DROP,
            )

    def test_frozen_test_rejects_train_or_val_predictions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
            )
            leaked = copy.deepcopy(rows[0])
            leaked["sample_id"] = "train-only"
            leaked["split"] = "train"
            leaked["work_id"] = "work-train"
            train_sample = next(
                row for row in fixture.sample_rows if row["sample_id"] == "train-only"
            )
            train_listwise = next(
                row for row in fixture.listwise_rows if row["sample_id"] == "train-only"
            )
            leaked["bindings"]["training_sample_record_sha256"] = train_sample[
                "record_sha256"
            ]
            leaked["bindings"]["listwise_target_record_sha256"] = train_listwise[
                "record_sha256"
            ]
            rows.append(EVAL.seal(leaked))
            fixture.write_predictions(fixture.model_predictions, rows)
            with self.assertRaisesRegex(EVAL.EvaluationError, "split leakage"):
                EVAL.evaluate_files(**fixture.kwargs())

    def test_duplicate_missing_catalog_and_model_mismatches_hard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
            )
            fixture.write_predictions(fixture.model_predictions, [*rows, rows[0]])
            with self.assertRaisesRegex(EVAL.EvaluationError, "duplicate prediction"):
                EVAL.evaluate_files(**fixture.kwargs())
            fixture.write_predictions(fixture.model_predictions, rows[:-1])
            with self.assertRaisesRegex(EVAL.EvaluationError, "inventory mismatch"):
                EVAL.evaluate_files(**fixture.kwargs())

        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
            )
            rows[0]["bindings"]["font_catalog_sha256"] = sha("other-catalog")
            rows[0] = EVAL.seal(rows[0])
            fixture.write_predictions(fixture.model_predictions, rows)
            with self.assertRaisesRegex(
                EVAL.EvaluationError, "font_catalog_sha256 mismatch"
            ):
                EVAL.evaluate_files(**fixture.kwargs())

        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
            )
            rows[1]["model"]["sha256"] = sha("different-model")
            rows[1] = EVAL.seal(rows[1])
            fixture.write_predictions(fixture.model_predictions, rows)
            with self.assertRaisesRegex(
                EVAL.EvaluationError, "mixes model IDs or hashes"
            ):
                EVAL.evaluate_files(**fixture.kwargs())

    def test_export_and_prediction_tamper_hard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            with fixture.samples.open("ab") as handle:
                handle.write(b"{}\n")
            with self.assertRaisesRegex(
                EVAL.EvaluationError, "artifact hash/count/size mismatch"
            ):
                EVAL.evaluate_files(**fixture.kwargs())

        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows = fixture.prediction_rows(
                model_id="font-matching-v2",
                model_sha=MODEL_SHA,
                good=True,
                include_semantics=True,
            )
            rows[0]["confidence"] = 0.1
            fixture.write_predictions(fixture.model_predictions, rows)
            with self.assertRaisesRegex(
                EVAL.EvaluationError, "record hash binding failed"
            ):
                EVAL.evaluate_files(**fixture.kwargs())

    def test_cli_require_gates_is_machine_enforceable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            output = Path(temporary) / "report.json"
            result = EVAL.main(
                [
                    "--training-export-manifest",
                    str(fixture.manifest),
                    "--samples",
                    str(fixture.samples),
                    "--listwise",
                    str(fixture.listwise),
                    "--predictions",
                    str(fixture.model_predictions),
                    "--current-rule-predictions",
                    str(fixture.current_predictions),
                    "--majority-predictions",
                    str(fixture.majority_predictions),
                    "--bootstrap-iterations",
                    "100",
                    "--output",
                    str(output),
                    "--require-gates",
                ]
            )
            self.assertEqual(0, result)
            self.assertTrue(
                json.loads(output.read_text(encoding="utf-8"))["all_gates_pass"]
            )


if __name__ == "__main__":
    unittest.main()
