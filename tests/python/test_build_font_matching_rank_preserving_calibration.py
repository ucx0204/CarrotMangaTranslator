from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_rank_preserving_calibration.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "build_font_matching_rank_preserving_calibration_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


CAL = load_script()


def sample(
    sample_id: str,
    work_id: str,
    *,
    positive: frozenset[str],
    preferred: frozenset[str],
    role: str = "sfx_impact",
):
    return CAL.base.BoundSample(
        sample_id=sample_id,
        work_id=work_id,
        role=role,
        manifest={},
        label={},
        preferred=preferred,
        positive=positive,
        excluded=frozenset(),
        none_acceptable=False,
        label_confidence=1.0,
    )


def point(*, preferred: float = 0.6):
    return {
        "enabled": True,
        "selection_score_threshold": 0.5,
        "coverage_target": 0.9,
        "coverage_floor_passed": True,
        "precision_target": 0.88,
        "precision_target_passed": True,
        "risk_lcb": 0.5,
        "cohort_count": 10,
        "accepted_count": 10,
        "eligible_count": 10,
        "normal_sample_count": 10,
        "normal_accepted_count": 10,
        "none_sample_count": 0,
        "none_false_accept_count": 0,
        "none_abstained_count": 0,
        "hit_count": 9,
        "miss_count": 1,
        "coverage": 1.0,
        "acceptable_at1": 0.9,
        "preferred_at1": preferred,
        "overall_decision_accuracy": 0.9,
        "none_abstention_rate": 1.0,
    }


def valid_record():
    candidates = [f"font-{index:02d}" for index in range(21)]
    order_sha = CAL.base.sha256_bytes(
        ("\n".join(candidates) + "\n").encode("utf-8")
    )
    raw_hash = "a" * 64
    points = {family: point() for family in ("body", "variant", "global")}
    return CAL.base.seal_record(
        {
            "bindings": {
                "candidate_order_sha256": order_sha,
                "runtime_contract_sha256": "b" * 64,
            },
            "candidate_ids": candidates,
            "confidence_calibration": {
                "c": 0.1,
                "coef": [0.2, -0.3],
                "feature_names": list(CAL.FEATURE_NAMES),
                "intercept": 0.4,
                "schema_version": CAL.CONFIDENCE_SCHEMA,
                "sigmoid": CAL.SIGMOID,
            },
            "leakage_audit": {
                "allowed_split": "val",
                "candidate_reranking": False,
                "hybrid_score_route_source": "pixel_shared_scores_role_downstream_only",
                "non_val_label_rows_parsed": 0,
                "pixel_only_confidence_features": True,
                "pseudo_label_rows_used_for_fit": 0,
                "semantic_feature_count": 0,
                "test_rows_used_for_fit": 0,
                "train_rows_used_for_fit": 0,
            },
            "oof_report": {
                "confidence_log_loss": 0.4,
                "confidence_roc_auc": 0.7,
                "final_C": 0.1,
                "fit_implementation": {},
                "folds": [],
                "full_oof": copy.deepcopy(points),
                "nested_operating_evaluation": copy.deepcopy(points),
                "rank_preservation": {
                    "calibrated_top1_sha256": raw_hash,
                    "changed_top1_count": 0,
                    "evaluated_sample_count": 10,
                    "exact_top1_agreement": 1.0,
                    "raw_top1_sha256": raw_hash,
                },
                "selected_C_values": [0.1],
            },
            "operating_points": copy.deepcopy(points),
            "ranking_policy": copy.deepcopy(CAL.RANKING_POLICY),
            "record_type": CAL.RECORD_TYPE,
            "schema_version": CAL.SCHEMA_VERSION,
            "training_boundary": {
                "raw_top1_sha256": raw_hash,
                "split": "val",
                "supervision": {"pseudo_labels_forbidden": True},
            },
        }
    )


class RankPreservingCalibrationTests(unittest.TestCase):
    def test_table_uses_only_raw_top1_score_and_margin_without_reranking(self) -> None:
        candidates = [f"font-{index:02d}" for index in range(21)]
        samples = [
            sample(
                "sample-a",
                "work-a",
                positive=frozenset({candidates[1]}),
                preferred=frozenset({candidates[1]}),
            ),
            sample(
                "sample-b",
                "work-b",
                positive=frozenset({candidates[2]}),
                preferred=frozenset({candidates[2]}),
            ),
        ]
        scores = np.zeros((2, 21), dtype=np.float32)
        scores[0, 1], scores[0, 2] = 4.0, 3.25
        scores[1, 3], scores[1, 2] = 5.0, 4.5

        table = CAL.build_confidence_table(
            samples, candidates, {"candidate_scores": scores}
        )

        self.assertEqual(table.top1_ids, (candidates[1], candidates[3]))
        np.testing.assert_allclose(table.features, [[4.0, 0.75], [5.0, 0.5]])
        np.testing.assert_array_equal(table.labels, [1, 0])
        self.assertEqual(tuple(CAL.FEATURE_NAMES), ("top1_raw_score", "top1_raw_margin"))

    def test_validator_rejects_reranking_semantic_features_and_rank_drift(self) -> None:
        record = valid_record()
        self.assertEqual(
            CAL.validate_calibration(record)["ranking_policy"], CAL.RANKING_POLICY
        )

        reranking = copy.deepcopy(record)
        reranking.pop("record_sha256")
        reranking["ranking_policy"]["candidate_reranking"] = True
        with self.assertRaisesRegex(
            CAL.RankPreservingCalibrationError, "schema/policy"
        ):
            CAL.validate_calibration(CAL.base.seal_record(reranking))

        semantic = copy.deepcopy(record)
        semantic.pop("record_sha256")
        semantic["confidence_calibration"]["feature_names"] = [
            "top1_raw_score",
            "gemma_role",
        ]
        with self.assertRaisesRegex(
            CAL.RankPreservingCalibrationError, "feature contract"
        ):
            CAL.validate_calibration(CAL.base.seal_record(semantic))

        rank_drift = copy.deepcopy(record)
        rank_drift.pop("record_sha256")
        rank_drift["oof_report"]["rank_preservation"]["changed_top1_count"] = 1
        with self.assertRaisesRegex(
            CAL.RankPreservingCalibrationError, "rank-preservation"
        ):
            CAL.validate_calibration(CAL.base.seal_record(rank_drift))

        retired = copy.deepcopy(record)
        retired.pop("record_sha256")
        retired["candidate_ids"][18] = "gugi"
        retired["bindings"]["candidate_order_sha256"] = CAL.base.sha256_bytes(
            ("\n".join(retired["candidate_ids"]) + "\n").encode("utf-8")
        )
        with self.assertRaisesRegex(
            CAL.RankPreservingCalibrationError, "active21 candidate inventory"
        ):
            CAL.validate_calibration(CAL.base.seal_record(retired))

    def test_deployment_quality_gate_keeps_existing_preferred_floors(self) -> None:
        record = valid_record()
        self.assertTrue(CAL.require_deployment_quality(record)["passed"])

        drifted = copy.deepcopy(record)
        drifted.pop("record_sha256")
        drifted["oof_report"]["nested_operating_evaluation"]["variant"][
            "preferred_at1"
        ] = 0.49
        with self.assertRaisesRegex(
            CAL.RankPreservingCalibrationError, "preferred@1"
        ):
            CAL.require_deployment_quality(CAL.base.seal_record(drifted))

    def test_raw_space_coefficients_reproduce_standardized_platt_probability(self) -> None:
        features = np.asarray(
            [[0.2, 0.01], [0.4, 0.1], [0.6, 0.2], [0.8, 0.4]], dtype=np.float64
        )
        table = CAL.ConfidenceTable(
            features=features,
            labels=np.asarray([0, 0, 1, 1]),
            weights=np.ones(4),
            top1_indices=np.zeros(4, dtype=np.int64),
            top1_ids=("a", "a", "a", "a"),
            raw_top1_sha256="a" * 64,
        )

        probability, coef, intercept = CAL._fit_predict(
            np.arange(4), np.arange(4), table, 0.1
        )
        reconstructed = 1.0 / (1.0 + np.exp(-(features @ coef + intercept)))

        np.testing.assert_allclose(probability, reconstructed, rtol=1e-10, atol=1e-12)


if __name__ == "__main__":
    unittest.main()
