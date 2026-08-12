from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str, filename: str):
    specification = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


exporter = load_script(
    "export_manga_font_v2_blind_r3h_score_bundle_tested",
    "export_manga_font_v2_blind_r3h_score_bundle.py",
)
ablation = load_script(
    "ablate_manga_font_v2_blind_tiered_rerank_tested",
    "ablate_manga_font_v2_blind_tiered_rerank.py",
)
comparison = load_script(
    "compare_manga_font_v2_blind_role_family_adapters_tested",
    "compare_manga_font_v2_blind_role_family_adapters.py",
)
binding = exporter.bound

R3H_ARTIFACT = (
    ROOT / "artifacts" / "manga-font-v2-blind-r3h-production-route-calibration-v1"
)
TIERED_ARTIFACT = (
    ROOT / "artifacts" / "manga-font-v2-blind-tiered-rerank-ablation-cal145-v1"
)
COMPARISON_ARTIFACT = (
    ROOT
    / "artifacts"
    / "manga-font-v2-blind145-role-family-adapter-comparison-r3h-r4a25-r5a50-v1"
)


class BlindR3HEvidenceTests(unittest.TestCase):
    def test_repository_r3h_bundle_is_sealed_calibration_only(self) -> None:
        report = exporter.validate_bundle(R3H_ARTIFACT)

        self.assertEqual(report["boundary"]["blind_calibration_rows_used"], 145)
        self.assertEqual(report["boundary"]["blind_evaluation_rows_161_240_read"], 0)
        self.assertFalse(report["authority"]["deployment_attachment_allowed"])
        self.assertEqual(
            report["record_sha256"],
            "463bf6319be17ed4615c9e6d9bf7611f6904d34f25870b4306e91ceccb9aa3c7",
        )
        evidence = binding._read_json(  # noqa: SLF001
            R3H_ARTIFACT / "family-threshold-evidence.json", "test evidence"
        )
        self.assertEqual(
            [row["threshold"] for row in evidence["threshold_sweep"]],
            list(exporter.THRESHOLDS),
        )
        self.assertEqual(len(evidence["nested_work_logo"]["folds"]), 3)

    def test_threshold_routes_low_confidence_variant_to_body(self) -> None:
        candidate_ids = [f"font-{index}" for index in range(20)] + ["single-day"]
        labels = [
            binding.FitLabel(
                sample_id="body",
                work_token="work-a",
                page_token="page-a",
                role="dialogue",
                confidence=1.0,
                preferred=frozenset({"font-0"}),
                positive=frozenset({"font-0"}),
                unrenderable=frozenset(),
            ),
            binding.FitLabel(
                sample_id="variant",
                work_token="work-b",
                page_token="page-b",
                role="sfx_motion",
                confidence=1.0,
                preferred=frozenset({"font-1"}),
                positive=frozenset({"font-1"}),
                unrenderable=frozenset(),
            ),
        ]
        body_scores = np.zeros((2, 21), dtype=np.float32)
        variant_scores = np.zeros((2, 21), dtype=np.float32)
        body_scores[:, 0] = 2.0
        variant_scores[:, 1] = 2.0
        probabilities = np.asarray([[0.8, 0.2], [0.4, 0.6]], dtype=np.float64)

        low = exporter.evaluate_threshold(
            labels=labels,
            candidate_ids=candidate_ids,
            body_scores=body_scores,
            variant_scores=variant_scores,
            family_probabilities=probabilities,
            threshold=0.5,
        )
        high = exporter.evaluate_threshold(
            labels=labels,
            candidate_ids=candidate_ids,
            body_scores=body_scores,
            variant_scores=variant_scores,
            family_probabilities=probabilities,
            threshold=0.75,
        )

        self.assertEqual(low["variant_routed_count"], 1)
        self.assertEqual(high["variant_routed_count"], 0)
        self.assertEqual(low["confusion"]["variant_as_variant"], 1)
        self.assertEqual(high["confusion"]["variant_as_body"], 1)

    def test_tiered_nested_logo_fails_closed_to_raw(self) -> None:
        report = ablation.validate_ablation(TIERED_ARTIFACT)

        self.assertFalse(report["nested_work_logo"]["dual_floor_passed"])
        self.assertEqual(report["decision"]["production_action"], "retain_raw_r3h_route")
        self.assertFalse(report["decision"]["tiered_reranker_attachment_allowed"])
        self.assertFalse(report["decision"]["family_threshold_change_allowed"])
        self.assertFalse(report["decision"]["existing_acceptable_only_calibration_safe"])
        self.assertEqual(report["boundary"]["blind_evaluation_rows_161_240_read"], 0)
        self.assertEqual(
            report["record_sha256"],
            "3f7fdc267e6bc56e7c49ca7ee8bcb76f9f863ab01a8ae37021b5b1f9c5add44f",
        )

    def test_three_way_adapter_comparison_selects_r4_for_qa40_only(self) -> None:
        report = comparison.validate_comparison(COMPARISON_ARTIFACT)
        table = {row["label"]: row for row in report["comparison_table"]}

        self.assertEqual(report["decision"]["qa40_candidate_label"], "r4a25")
        self.assertEqual(
            report["decision"]["safety_gate_eligible_labels"], ["r3h", "r4a25"]
        )
        self.assertGreater(table["r4a25"]["preferred_at1"], table["r3h"]["preferred_at1"])
        self.assertGreaterEqual(
            table["r4a25"]["acceptable_at1"], table["r3h"]["acceptable_at1"]
        )
        self.assertEqual(table["r4a25"]["top1_rows_changed_vs_baseline"], 10)
        self.assertEqual(report["boundary"]["blind_evaluation_rows_161_240_read"], 0)
        self.assertFalse(report["authority"]["deployment_attachment_allowed"])
        self.assertEqual(
            report["record_sha256"],
            "8b78fed4c2bea7dd19d5a134d0ef6e165191abc5b69e9ca43ac5703512dd3ad3",
        )


if __name__ == "__main__":
    unittest.main()
