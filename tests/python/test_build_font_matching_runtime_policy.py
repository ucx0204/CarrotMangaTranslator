from __future__ import annotations

import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"


def load_script(name: str, path: Path):
    specification = importlib.util.spec_from_file_location(name, path)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


POLICY = load_script(
    "build_font_matching_runtime_policy_tested",
    SCRIPTS / "build_font_matching_runtime_policy.py",
)
RUNTIME = load_script(
    "runtime_artifact_policy_consumer_tested",
    SCRIPTS / "build_font_matching_runtime_artifact.py",
)


def build_policy():
    return POLICY.build_policy(
        minimum_calibrated_confidence=0.86,
        minimum_role_confidence=0.82,
        minimum_intentional_override_confidence=0.86,
        intentional_override_minimum_score_margin=0.1,
        chapter_prior_maximum_score_contribution=0.06,
        chapter_prior_minimum_anchor_evidence_count=2,
        chapter_prior_local_override_minimum_score_margin=0.1,
    )


class RuntimePolicyProducerTests(unittest.TestCase):
    def test_producer_matches_runtime_consumer_exact_contract(self) -> None:
        record = build_policy()
        POLICY.validate_policy_record(record, expected=record)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime-policy.json"
            POLICY.write_policy(path, record, replace_existing=False)
            self.assertEqual(RUNTIME._load_policy(path), record)

    def test_tamper_and_resealed_safety_weakening_are_rejected(self) -> None:
        record = build_policy()
        tampered = copy.deepcopy(record)
        tampered["automatic_mutation"]["minimum_calibrated_confidence"] = 0.1
        with self.assertRaisesRegex(POLICY.RuntimePolicyError, "seal mismatch"):
            POLICY.validate_policy_record(tampered)

        weakened = copy.deepcopy(record)
        weakened["fallback"]["semantic_bootstrap"] = "allowed"
        weakened = POLICY.seal_record(weakened)
        with self.assertRaisesRegex(POLICY.RuntimePolicyError, "fixed safety"):
            POLICY.validate_policy_record(weakened)

        extra = copy.deepcopy(record)
        extra["automatic_mutation"]["silent_fallback"] = True
        extra = POLICY.seal_record(extra)
        with self.assertRaisesRegex(POLICY.RuntimePolicyError, "invalid keys"):
            POLICY.validate_policy_record(extra)

    def test_threshold_drift_and_unsafe_chapter_prior_fail_closed(self) -> None:
        record = build_policy()
        expected = POLICY.build_policy(
            minimum_calibrated_confidence=0.9,
            minimum_role_confidence=0.82,
            minimum_intentional_override_confidence=0.86,
            intentional_override_minimum_score_margin=0.1,
            chapter_prior_maximum_score_contribution=0.06,
            chapter_prior_minimum_anchor_evidence_count=2,
            chapter_prior_local_override_minimum_score_margin=0.1,
        )
        with self.assertRaisesRegex(POLICY.RuntimePolicyError, "requested thresholds"):
            POLICY.validate_policy_record(record, expected=expected)
        with self.assertRaisesRegex(POLICY.RuntimePolicyError, "must not exceed"):
            POLICY.build_policy(
                minimum_calibrated_confidence=0.86,
                minimum_role_confidence=0.82,
                minimum_intentional_override_confidence=0.86,
                intentional_override_minimum_score_margin=0.1,
                chapter_prior_maximum_score_contribution=0.11,
                chapter_prior_minimum_anchor_evidence_count=2,
                chapter_prior_local_override_minimum_score_margin=0.1,
            )
        with self.assertRaisesRegex(POLICY.RuntimePolicyError, "integer >= 2"):
            POLICY.build_policy(
                minimum_calibrated_confidence=0.86,
                minimum_role_confidence=0.82,
                minimum_intentional_override_confidence=0.86,
                intentional_override_minimum_score_margin=0.1,
                chapter_prior_maximum_score_contribution=0.06,
                chapter_prior_minimum_anchor_evidence_count=1,
                chapter_prior_local_override_minimum_score_margin=0.1,
            )


if __name__ == "__main__":
    unittest.main()
