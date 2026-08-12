from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

from scripts import build_manga_font_v8_selection_calibration as calibration
from scripts import package_manga_font_student_v8_qa_runtime as package


class MangaFontV8SelectionCalibrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "runtime"
        self.runtime.mkdir()
        self.candidate_ids = tuple(
            f"font-{index:02d}" for index in range(20)
        ) + ("single-day",)
        self.runtime_record = {
            "candidate_ids": self.candidate_ids,
            "hybrid_score_routing": {
                "body_output": "body_candidate_scores",
                "variant_output": "variant_candidate_scores",
            },
            "retired_label_candidates": (),
        }
        self._write_contract()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_contract(self, *, shared: bool = False) -> None:
        contract = package.attach.seal_record(
            {
                "v8_font_family_evidence": {
                    "body_and_variant_share_exact_scores": shared,
                    "candidate_scores_compatibility_alias": "body_candidate_scores",
                    "forbidden_model_inputs": [
                        "font_name",
                        "gemma",
                        "genre",
                        "text",
                    ],
                    "role_logits": "pixel_query_role_family_adapter",
                    "schema_version": package.V8_EVIDENCE_SCHEMA,
                },
                "v8_runtime_packaging": {
                    "quality_gate_bypassed": False,
                    "schema_version": package.SCHEMA_VERSION,
                    "selection_calibration_required": True,
                },
            }
        )
        (self.runtime / "runtime-contract.json").write_bytes(
            package.attach.json_bytes(contract, pretty=True)
        )

    def test_projects_only_retired_gugi_for_distinct_branch_v8(self) -> None:
        prototype = object()

        def fake_bindings(_runtime_dir: Path):
            return {"model_version": "v8"}, dict(self.runtime_record), prototype

        with mock.patch.object(
            calibration, "_BASE_RUNTIME_BINDINGS", side_effect=fake_bindings
        ):
            bindings, runtime, actual_prototype = calibration._v8_runtime_bindings(  # noqa: SLF001
                self.runtime
            )

        self.assertEqual(bindings["model_version"], "v8")
        self.assertIs(actual_prototype, prototype)
        self.assertEqual(runtime["retired_label_candidates"], ("gugi",))
        self.assertNotIn("gugi", runtime["candidate_ids"])

    def test_rejects_shared_score_claim(self) -> None:
        self._write_contract(shared=True)

        def fake_bindings(_runtime_dir: Path):
            return {}, dict(self.runtime_record), object()

        with (
            mock.patch.object(
                calibration, "_BASE_RUNTIME_BINDINGS", side_effect=fake_bindings
            ),
            self.assertRaisesRegex(
                calibration.MangaFontV8SelectionCalibrationError,
                "distinct-branch v8",
            ),
        ):
            calibration._v8_runtime_bindings(self.runtime)  # noqa: SLF001

    def test_build_temporarily_installs_and_restores_binding_adapter(self) -> None:
        sentinel = calibration.base._runtime_bindings  # noqa: SLF001
        router = calibration.base._route_hybrid_candidate_scores  # noqa: SLF001
        winner_rows = calibration.base._winner_rows  # noqa: SLF001

        def fake_build(**_kwargs):
            self.assertIs(
                calibration.base._runtime_bindings,  # noqa: SLF001
                calibration._v8_runtime_bindings,  # noqa: SLF001
            )
            self.assertIs(
                calibration.base._route_hybrid_candidate_scores,  # noqa: SLF001
                calibration._v8_production_score_route,  # noqa: SLF001
            )
            self.assertIs(
                calibration.base._winner_rows,  # noqa: SLF001
                calibration._v8_production_winner_rows,  # noqa: SLF001
            )
            return {"record_sha256": "a" * 64}

        with mock.patch.object(
            calibration.base, "build_calibration", side_effect=fake_build
        ):
            result = calibration.build_calibration(
                finals_path=Path("finals"),
                master_manifest_path=Path("master"),
                catalog_registry_path=Path("registry"),
                runtime_dir=self.runtime,
                coverage_target=0.9,
                precision_target=0.88,
            )

        self.assertEqual(result["record_sha256"], "a" * 64)
        self.assertIs(calibration.base._runtime_bindings, sentinel)  # noqa: SLF001
        self.assertIs(  # noqa: SLF001
            calibration.base._route_hybrid_candidate_scores, router
        )
        self.assertIs(calibration.base._winner_rows, winner_rows)  # noqa: SLF001

    def test_winner_cohorts_use_predicted_pixel_family_not_gold_role(self) -> None:
        samples = [
            SimpleNamespace(
                role="dialogue",
                work_id="work-a",
                positive=frozenset({self.candidate_ids[0]}),
                preferred=frozenset({self.candidate_ids[0]}),
                none_acceptable=False,
            ),
            SimpleNamespace(
                role="emphasis_dialogue",
                work_id="work-b",
                positive=frozenset({self.candidate_ids[0]}),
                preferred=frozenset({self.candidate_ids[0]}),
                none_acceptable=False,
            ),
        ]
        table = SimpleNamespace(
            sample_indices=np.asarray([0, 1], dtype=np.int64),
            candidate_indices=np.asarray([0, 0], dtype=np.int64),
        )
        role_logits = np.full(
            (2, len(calibration.base.ROLE_VALUES)), -10.0, dtype=np.float32
        )
        role_logits[
            0, calibration.base.ROLE_VALUES.index("emphasis_dialogue")
        ] = 10.0
        role_logits[1, calibration.base.ROLE_VALUES.index("dialogue")] = 10.0
        outputs = {
            "candidate_scores": np.zeros((2, 21), dtype=np.float32),
            "none_logits": np.full(2, -10.0, dtype=np.float32),
            "role_logits": role_logits,
        }

        rows = calibration._v8_production_winner_rows(  # noqa: SLF001
            np.asarray([0.9, 0.8], dtype=np.float32),
            table,
            samples,
            outputs,
            self.candidate_ids,
            0.5,
        )

        self.assertEqual(["variant", "body"], [row["family"] for row in rows])

    def test_production_route_uses_pixel_role_and_single_day_eligibility(self) -> None:
        samples = [
            SimpleNamespace(role="sfx_impact"),
            SimpleNamespace(role="dialogue"),
            SimpleNamespace(role="dialogue"),
        ]
        body = np.zeros((3, 21), dtype=np.float32)
        variant = np.zeros((3, 21), dtype=np.float32)
        body[:, 0] = 1.0
        body[:, 20] = 5.0
        variant[:, 0] = 0.0
        variant[:, 20] = 1.0
        role_logits = np.full(
            (3, len(calibration.base.ROLE_VALUES)), -10.0, dtype=np.float32
        )
        role_logits[0, calibration.base.ROLE_VALUES.index("dialogue")] = 5.0
        role_logits[1, calibration.base.ROLE_VALUES.index("emphasis_dialogue")] = 5.0
        role_logits[2, calibration.base.ROLE_VALUES.index("emphasis_dialogue")] = 1.0
        role_logits[2, calibration.base.ROLE_VALUES.index("dialogue")] = 0.5
        outputs = {
            "body_candidate_scores": body,
            "candidate_scores": body.copy(),
            "variant_candidate_scores": variant,
            "role_logits": role_logits,
        }
        runtime = {
            "candidate_ids": self.candidate_ids,
            "hybrid_score_routing": {
                "body_output": "body_candidate_scores",
                "body_roles": ("dialogue", "narration", "thought"),
                "variant_output": "variant_candidate_scores",
            },
        }

        routed = calibration._v8_production_score_route(  # noqa: SLF001
            samples, outputs, runtime
        )["candidate_scores"]

        self.assertEqual(0, int(routed[0].argmax()))
        self.assertEqual(20, int(routed[1].argmax()))
        self.assertEqual(0, int(routed[2].argmax()))
        self.assertLess(float(routed[0, 20]), float(routed[0, 0]))

    def test_cli_exposes_no_failed_quality_override(self) -> None:
        self.assertNotIn("allow-failed", calibration.build_parser().format_help())


if __name__ == "__main__":
    unittest.main()
