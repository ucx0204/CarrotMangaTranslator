from __future__ import annotations

import copy
import unittest

from scripts import promote_manga_font_r3h_manual_v2_release as release


class ManualV2ReleaseAcceptanceTests(unittest.TestCase):
    def build(self):
        return release.build_release_acceptance(
            source_contract_sha256="a" * 64,
            accepted_at="2026-08-12T03:00:00Z",
        )

    def test_fixed_acceptance_validates(self) -> None:
        record = self.build()
        release.validate_release_acceptance(
            record, source_contract_sha256="a" * 64
        )
        self.assertFalse(
            record["quality_gate"]["calibration_release_quality_gate_passed"]
        )
        self.assertTrue(record["quality_gate"]["calibration_gate_waiver"]["approved"])

    def test_resealed_metric_drift_is_rejected(self) -> None:
        record = self.build()
        record["quality_gate"]["usable_pages"] = 24
        from scripts import attach_font_matching_selection_calibration as attach

        resealed = attach.seal_record(
            {key: value for key, value in record.items() if key != "record_sha256"}
        )
        with self.assertRaisesRegex(
            release.ManualV2PromotionError, "envelope drifted"
        ):
            release.validate_release_acceptance(
                resealed, source_contract_sha256="a" * 64
            )

    def test_resealed_source_binding_drift_is_rejected(self) -> None:
        record = self.build()
        drifted = copy.deepcopy(record)
        drifted["evidence"]["source_evaluation_runtime_contract_sha256"] = "b" * 64
        from scripts import attach_font_matching_selection_calibration as attach

        resealed = attach.seal_record(
            {key: value for key, value in drifted.items() if key != "record_sha256"}
        )
        with self.assertRaisesRegex(
            release.ManualV2PromotionError, "envelope drifted"
        ):
            release.validate_release_acceptance(
                resealed, source_contract_sha256="a" * 64
            )


if __name__ == "__main__":
    unittest.main()
