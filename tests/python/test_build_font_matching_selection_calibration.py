from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_selection_calibration.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "build_font_matching_selection_calibration_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


CAL = load_script()


def point(enabled: bool = True):
    return {
        "enabled": enabled,
        "selection_score_threshold": 0.5 if enabled else None,
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
        "preferred_at1": 0.5,
        "overall_decision_accuracy": 0.9,
        "none_abstention_rate": 1.0,
    }


class SelectionCalibrationTests(unittest.TestCase):
    def test_deployment_quality_gate_requires_precision_and_preferred_accuracy(
        self,
    ) -> None:
        candidate_ids = [f"font-{index:02d}" for index in range(15)]
        feature_names = [
            *CAL.CONTINUOUS_FEATURE_NAMES,
            *(f"candidate_id::{candidate_id}" for candidate_id in candidate_ids),
        ]
        points = {family: point() for family in ("body", "variant", "global")}
        record = CAL.seal_record(
            {
                "bindings": {},
                "candidate_ids": candidate_ids,
                "feature_contract": CAL.feature_contract(),
                "feature_names": feature_names,
                "leakage_audit": {
                    "test_rows_used_for_fit": 0,
                    "train_rows_used_for_fit": 0,
                    "non_val_label_rows_parsed": 0,
                    "pseudo_label_rows_used_for_fit": 0,
                },
                "logistic": {
                    "c": 0.1,
                    "coef": [0.0] * len(feature_names),
                    "intercept": 0.0,
                },
                "oof_report": {
                    "full_oof": copy.deepcopy(points),
                    "nested_operating_evaluation": copy.deepcopy(points),
                },
                "operating_points": copy.deepcopy(points),
                "record_type": CAL.RECORD_TYPE,
                "scaler": {
                    "mean": [0.0] * len(feature_names),
                    "scale": [1.0] * len(feature_names),
                },
                "schema_version": CAL.SCHEMA_VERSION,
                "training_boundary": {},
            }
        )
        self.assertTrue(CAL.require_deployment_quality(record)["passed"])

        precision_miss = copy.deepcopy(record)
        precision_miss.pop("record_sha256")
        for evidence in (
            precision_miss["operating_points"],
            precision_miss["oof_report"]["full_oof"],
            precision_miss["oof_report"]["nested_operating_evaluation"],
        ):
            evidence["variant"]["precision_target_passed"] = False
        with self.assertRaisesRegex(
            CAL.SelectionCalibrationError, "variant: precision target missed"
        ):
            CAL.require_deployment_quality(CAL.seal_record(precision_miss))

        preferred_miss = copy.deepcopy(record)
        preferred_miss.pop("record_sha256")
        preferred_miss["oof_report"]["nested_operating_evaluation"]["variant"][
            "preferred_at1"
        ] = 0.49
        with self.assertRaisesRegex(CAL.SelectionCalibrationError, "preferred@1"):
            CAL.require_deployment_quality(CAL.seal_record(preferred_miss))

    def test_student22_runtime_binds_exact_onnx_prototype_and_contract_hashes(
        self,
    ) -> None:
        candidate_ids = tuple(f"font-{index:02d}" for index in range(22))
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            (runtime / "encoder.onnx").write_bytes(b"student-encoder")
            (runtime / "ranker.onnx").write_bytes(b"student-ranker")
            prototypes = np.arange(44, dtype="<f4").reshape(22, 2)
            prototypes.tofile(runtime / "prototype-features.f32")
            artifacts = {
                name: {"sha256": CAL.sha256_file(runtime / name)}
                for name in (
                    "encoder.onnx",
                    "ranker.onnx",
                    "prototype-features.f32",
                )
            }
            contract = CAL.seal_record(
                {
                    "schema_version": CAL.RUNTIME_SCHEMA_V1,
                    "artifacts": artifacts,
                    "calibration": {"none_threshold": 0.5, "temperature": 1.0},
                    "catalog": {
                        "candidate_count": 22,
                        "candidate_ids": list(candidate_ids),
                        "candidate_order_sha256": CAL.sha256_bytes(
                            ("\n".join(candidate_ids) + "\n").encode("utf-8")
                        ),
                        "catalog_registry_sha256": "c" * 64,
                        "font_prototypes_sha256": artifacts["prototype-features.f32"][
                            "sha256"
                        ],
                        "prototype_bags": [
                            {"candidate_id": candidate_id, "count": 1, "start": index}
                            for index, candidate_id in enumerate(candidate_ids)
                        ],
                        "prototype_count": 22,
                    },
                    "head": {"architecture": {"feature_dim": 2}},
                    "model_version": "manga-font-student-runtime-v1-fixture",
                }
            )
            contract_path = runtime / "runtime-contract.json"
            contract_path.write_text(
                json.dumps(contract, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )

            bindings, loaded, loaded_prototypes = CAL._runtime_bindings(runtime)

            self.assertEqual(loaded["candidate_ids"], candidate_ids)
            self.assertEqual(loaded_prototypes.shape, (22, 2))
            self.assertEqual(bindings["catalog_registry_sha256"], "c" * 64)
            self.assertEqual(
                bindings["runtime_contract_sha256"], CAL.sha256_file(contract_path)
            )
            self.assertEqual(
                bindings["encoder_sha256"], CAL.sha256_file(runtime / "encoder.onnx")
            )
            self.assertEqual(
                bindings["ranker_sha256"], CAL.sha256_file(runtime / "ranker.onnx")
            )
            self.assertEqual(
                bindings["prototype_features_sha256"],
                CAL.sha256_file(runtime / "prototype-features.f32"),
            )

            drifted = copy.deepcopy(contract)
            drifted.pop("record_sha256")
            drifted["catalog"]["candidate_count"] = 21
            contract_path.write_text(
                CAL.canonical_json(CAL.seal_record(drifted)), encoding="utf-8"
            )
            with self.assertRaisesRegex(
                CAL.SelectionCalibrationError, "runtime candidate inventory"
            ):
                CAL._runtime_bindings(runtime)

    def test_active21_pixel_family_contract_bans_semantics_and_shares_scores(
        self,
    ) -> None:
        candidate_ids = tuple(f"font-{index:02d}" for index in range(21))
        evidence = {
            "body_and_variant_share_exact_scores": True,
            "candidate_output": "candidate_scores",
            "candidate_score_inputs": [
                "base_siglip2_last_hidden_state_patch_tokens",
                "active21_four_query_head",
                "active21_candidate_query_prototypes",
            ],
            "forbidden_family_logit_inputs": ["gemma", "genre", "role"],
            "role_policy_stage": "downstream_page_consistency_and_emphasis_only",
            "schema_version": CAL.PIXEL_FAMILY_EVIDENCE_SCHEMA,
        }

        parsed = CAL._parse_pixel_family_evidence(
            {"font_family_evidence": evidence}, candidate_ids
        )

        self.assertTrue(parsed["family_scores_shared"])
        self.assertEqual(parsed["retired_label_candidates"], ("gugi",))
        drifted = copy.deepcopy(evidence)
        drifted["forbidden_family_logit_inputs"] = ["gemma", "genre"]
        with self.assertRaisesRegex(
            CAL.SelectionCalibrationError, "pixel-family evidence contract"
        ):
            CAL._parse_pixel_family_evidence(
                {"font_family_evidence": drifted}, candidate_ids
            )

    def test_hybrid_runtime_uses_gold_role_route_and_legacy_feature_prefix(
        self,
    ) -> None:
        samples = [
            CAL.BoundSample(
                sample_id="body",
                work_id="work-a",
                role="dialogue",
                manifest={},
                label={},
                preferred=frozenset({"a"}),
                positive=frozenset({"a"}),
                excluded=frozenset(),
                none_acceptable=False,
                label_confidence=1.0,
            ),
            CAL.BoundSample(
                sample_id="variant",
                work_id="work-b",
                role="sfx_impact",
                manifest={},
                label={},
                preferred=frozenset({"b"}),
                positive=frozenset({"b"}),
                excluded=frozenset(),
                none_acceptable=False,
                label_confidence=1.0,
            ),
        ]
        body = np.asarray([[9.0, 0.0], [8.0, 1.0]], dtype=np.float32)
        variant = np.asarray([[0.0, 7.0], [0.0, 9.0]], dtype=np.float32)
        outputs = {
            "candidate_scores": body.copy(),
            "body_candidate_scores": body,
            "variant_candidate_scores": variant,
        }
        runtime = {
            "candidate_ids": ("a", "b"),
            "hybrid_score_routing": {
                "body_roles": ("dialogue", "narration", "thought"),
                "body_output": "body_candidate_scores",
                "variant_output": "variant_candidate_scores",
                "selection_feature_dim": 256,
            },
        }

        routed = CAL._route_hybrid_candidate_scores(samples, outputs, runtime)

        np.testing.assert_array_equal(
            routed["candidate_scores"],
            np.asarray([[9.0, 0.0], [0.0, 9.0]], dtype=np.float32),
        )

    def test_hybrid_runtime_rejects_body_alias_drift(self) -> None:
        sample = CAL.BoundSample(
            sample_id="body",
            work_id="work-a",
            role="dialogue",
            manifest={},
            label={},
            preferred=frozenset({"a"}),
            positive=frozenset({"a"}),
            excluded=frozenset(),
            none_acceptable=False,
            label_confidence=1.0,
        )
        runtime = {
            "candidate_ids": ("a", "b"),
            "hybrid_score_routing": {
                "body_roles": ("dialogue", "narration", "thought"),
                "body_output": "body_candidate_scores",
                "variant_output": "variant_candidate_scores",
            },
        }
        outputs = {
            "candidate_scores": np.asarray([[0.0, 1.0]], dtype=np.float32),
            "body_candidate_scores": np.asarray([[1.0, 0.0]], dtype=np.float32),
            "variant_candidate_scores": np.asarray([[0.0, 1.0]], dtype=np.float32),
        }
        with self.assertRaisesRegex(
            CAL.SelectionCalibrationError, "candidate-score outputs drifted"
        ):
            CAL._route_hybrid_candidate_scores([sample], outputs, runtime)

    def test_active21_shared_family_route_rejects_role_specific_scores(self) -> None:
        sample = CAL.BoundSample(
            sample_id="variant",
            work_id="work-a",
            role="sfx_impact",
            manifest={},
            label={},
            preferred=frozenset({"a"}),
            positive=frozenset({"a"}),
            excluded=frozenset(),
            none_acceptable=False,
            label_confidence=1.0,
        )
        body = np.asarray([[1.0, 0.0]], dtype=np.float32)
        runtime = {
            "candidate_ids": ("a", "b"),
            "hybrid_score_routing": {
                "body_roles": ("dialogue", "narration", "thought"),
                "body_output": "body_candidate_scores",
                "variant_output": "variant_candidate_scores",
                "family_scores_shared": True,
            },
        }
        outputs = {
            "candidate_scores": body,
            "body_candidate_scores": body,
            "variant_candidate_scores": np.asarray(
                [[0.0, 1.0]], dtype=np.float32
            ),
        }
        with self.assertRaisesRegex(
            CAL.SelectionCalibrationError, "candidate-score outputs drifted"
        ):
            CAL._route_hybrid_candidate_scores([sample], outputs, runtime)

    def test_student22_feature_table_keeps_top3_acceptability_inputs_dynamic(
        self,
    ) -> None:
        candidate_ids = tuple(f"font-{index:02d}" for index in range(22))
        samples = [
            CAL.BoundSample(
                sample_id="student-val-001",
                work_id="work-a",
                role="sfx_impact",
                manifest={},
                label={},
                preferred=frozenset({candidate_ids[1]}),
                positive=frozenset({candidate_ids[1], candidate_ids[2]}),
                excluded=frozenset(),
                none_acceptable=False,
                label_confidence=1.0,
            )
        ]
        prototypes = np.asarray(
            [[1.0, 0.0] if index % 2 == 0 else [0.0, 1.0] for index in range(22)],
            dtype=np.float32,
        )
        views = np.asarray([[[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]], dtype=np.float32)
        scores = np.linspace(2.2, 0.1, 22, dtype=np.float32)[None, :]
        outputs = {
            "candidate_scores": scores,
            "none_logits": np.asarray([-2.0], dtype=np.float32),
            "role_logits": np.zeros((1, len(CAL.ROLE_VALUES)), dtype=np.float32),
            "style_logits": np.zeros((1, len(CAL.STYLE_NAMES)), dtype=np.float32),
            "treatment_orientation_logits": np.zeros(
                (1, len(CAL.ORIENTATION_VALUES)), dtype=np.float32
            ),
            "view_gate_weights": np.asarray([[0.5, 0.25, 0.25]], dtype=np.float32),
        }
        bags = [
            {"candidate_id": candidate_id, "count": 1, "start": index}
            for index, candidate_id in enumerate(candidate_ids)
        ]

        table = CAL._candidate_feature_table(
            samples, candidate_ids, bags, views, prototypes, outputs, 1.0
        )

        self.assertEqual(table.features.shape, (22, 45 + 22))
        self.assertEqual(
            table.feature_names[-22:],
            tuple(f"candidate_id::{candidate_id}" for candidate_id in candidate_ids),
        )
        self.assertEqual(int(table.labels.sum()), 2)

    def test_finals_parser_never_json_parses_non_val_labels(self) -> None:
        candidates = ("a", "b", "c")
        manifest = {
            "val": {
                "id": "val",
                "work": {"id": "work-val"},
                "page": {"source_page_sha256": "a" * 64},
            }
        }
        final = CAL.seal_record(
            {
                "record_type": "manga_font_label_final",
                "sample_id": "val",
                "work_id": "work-val",
                "source_page_sha256": "a" * 64,
                "role": {"primary": "emphasis_dialogue"},
                "font_judgment": {
                    "preferred": ["a"],
                    "acceptable": ["b"],
                    "marginal": ["c"],
                    "unacceptable": [],
                    "unrenderable": [],
                    "not_reviewed": [],
                    "none_acceptable": False,
                },
                "resolution": {"confidence": 0.9, "kind": "primary"},
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "finals.jsonl"
            path.write_text(
                '{"sample_id":"test","secret": invalid-test-json}\n'
                + CAL.canonical_json(final)
                + "\n",
                encoding="utf-8",
            )
            samples, parsed = CAL.load_allowlisted_finals(path, manifest, candidates)
        self.assertEqual(parsed, 0)
        self.assertEqual([sample.sample_id for sample in samples], ["val"])
        self.assertEqual(samples[0].positive, frozenset({"a", "b"}))
        self.assertEqual(samples[0].role, "emphasis_dialogue")
        self.assertEqual(CAL._role_family(samples[0].role), "variant")

    def test_finals_parser_projects_only_explicitly_retired_gugi(self) -> None:
        manifest = {
            "val": {
                "id": "val",
                "work": {"id": "work-val"},
                "page": {"source_page_sha256": "a" * 64},
            }
        }
        final = CAL.seal_record(
            {
                "record_type": "manga_font_label_final",
                "sample_id": "val",
                "work_id": "work-val",
                "source_page_sha256": "a" * 64,
                "role": {"primary": "dialogue"},
                "font_judgment": {
                    "preferred": ["a"],
                    "acceptable": ["gugi"],
                    "marginal": ["b"],
                    "unacceptable": ["c"],
                    "unrenderable": [],
                    "not_reviewed": [],
                    "none_acceptable": False,
                },
                "resolution": {"confidence": 0.9, "kind": "primary"},
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "finals.jsonl"
            path.write_text(CAL.canonical_json(final) + "\n", encoding="utf-8")
            samples, _ = CAL.load_allowlisted_finals(
                path,
                manifest,
                ("a", "b", "c"),
                retired_candidate_ids=("gugi",),
            )
            with self.assertRaisesRegex(
                CAL.SelectionCalibrationError, "candidate tier partition drift"
            ):
                CAL.load_allowlisted_finals(path, manifest, ("a", "b", "c"))

        self.assertEqual(samples[0].preferred, frozenset({"a"}))
        self.assertEqual(samples[0].positive, frozenset({"a"}))
        self.assertNotIn("gugi", samples[0].positive)

    def test_finals_parser_rejects_pseudo_supervision_in_val(self) -> None:
        manifest = {
            "val": {
                "id": "val",
                "work": {"id": "work-val"},
                "page": {"source_page_sha256": "a" * 64},
            }
        }
        pseudo = CAL.seal_record(
            {
                "record_type": "manga_font_label_pseudo",
                "sample_id": "val",
                "work_id": "work-val",
                "source_page_sha256": "a" * 64,
                "font_judgment": {
                    "preferred": ["a"],
                    "acceptable": ["b"],
                    "marginal": ["c"],
                    "unacceptable": [],
                    "unrenderable": [],
                    "not_reviewed": [],
                    "none_acceptable": False,
                },
                "resolution": {"confidence": 0.9, "kind": "pseudo"},
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "finals.jsonl"
            path.write_text(CAL.canonical_json(pseudo) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(
                CAL.SelectionCalibrationError, "pseudo/non-final"
            ):
                CAL.load_allowlisted_finals(path, manifest, ("a", "b", "c"))

    def test_manifest_rejects_a_group_crossing_splits(self) -> None:
        split_map = {
            "work_assignments": {"wa": "val", "wb": "val", "wc": "val", "wt": "test"}
        }
        rows = [
            self._manifest("a", "wa", "val", "ga"),
            self._manifest("b", "wb", "val", "gb"),
            self._manifest("c", "wc", "val", "gc"),
            self._manifest("t", "wt", "test", "ga"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "manifest.jsonl"
            manifest.write_text(
                "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
            )
            split = root / "split.json"
            split.write_text(json.dumps(split_map), encoding="utf-8")
            with self.assertRaisesRegex(
                CAL.SelectionCalibrationError, "crosses splits"
            ):
                CAL.load_val_manifest(manifest, split)

    def test_master_report_binds_v2_manifest_split_map_and_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            frozen = root / "frozen.json"
            frozen.write_text("{}\n", encoding="utf-8")
            registry = CAL.seal_record(
                {
                    "frozen_split_map": {
                        "path": str(frozen),
                        "sha256": CAL.sha256_file(frozen),
                    }
                }
            )
            registry_path = root / "registry.json"
            registry_path.write_text(
                CAL.canonical_json(registry) + "\n", encoding="utf-8"
            )
            manifest = root / "manifest.jsonl"
            manifest.write_text('{"id":"sample"}\n', encoding="utf-8")
            split_map = root / "split_map.json"
            split_map.write_text(
                CAL.canonical_json(
                    {
                        "algorithm": {
                            "frozen_source": {"sha256": CAL.sha256_file(frozen)}
                        },
                        "work_assignments": {},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            report = {
                "inputs": {
                    "attestation": {
                        "catalog_registry": {
                            "record_sha256": registry["record_sha256"],
                            "sha256": CAL.sha256_file(registry_path),
                        }
                    }
                },
                "outputs": {
                    "master_manifest": manifest.name,
                    "master_manifest_sha256": CAL.sha256_file(manifest),
                    "split_map": split_map.name,
                    "split_map_sha256": CAL.sha256_file(split_map),
                },
            }
            report_path = root / "report.json"
            report_path.write_text(CAL.canonical_json(report) + "\n", encoding="utf-8")

            selected_split, bindings = CAL.validate_master_inputs(
                manifest, registry_path, registry
            )
            self.assertEqual(selected_split, split_map.resolve())
            self.assertEqual(
                bindings["master_split_map_sha256"], CAL.sha256_file(split_map)
            )

            report["inputs"]["attestation"]["catalog_registry"]["sha256"] = "0" * 64
            report_path.write_text(CAL.canonical_json(report) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(
                CAL.SelectionCalibrationError, "catalog-registry file hash mismatch"
            ):
                CAL.validate_master_inputs(manifest, registry_path, registry)

    def test_operating_point_prioritizes_coverage_floor_then_precision(self) -> None:
        rows = []
        for index in range(10):
            rows.append(
                {
                    "family": "variant",
                    "score": 1 - index / 10,
                    "acceptable": index not in {1, 9},
                    "preferred": index < 5,
                    "normal": True,
                    "none_gate_passed": True,
                }
            )
        selected = CAL.select_operating_point(
            rows, "variant", coverage_target=0.9, precision_target=0.88
        )
        self.assertTrue(selected["enabled"])
        self.assertEqual(selected["accepted_count"], 9)
        self.assertEqual(selected["coverage"], 0.9)
        self.assertAlmostEqual(selected["acceptable_at1"], 8 / 9)

    def test_operating_point_counts_a_false_none_selection_as_an_error(self) -> None:
        rows = [
            {
                "family": "variant",
                "score": 0.9 - index / 10,
                "acceptable": True,
                "preferred": True,
                "normal": True,
                "none_gate_passed": True,
            }
            for index in range(10)
        ]
        rows.append(
            {
                "family": "variant",
                "score": 1.0,
                "acceptable": False,
                "preferred": False,
                "normal": False,
                "none_gate_passed": True,
            }
        )
        selected = CAL.select_operating_point(
            rows, "variant", coverage_target=0.9, precision_target=0.88
        )
        self.assertEqual(selected["normal_accepted_count"], 10)
        self.assertEqual(selected["none_false_accept_count"], 1)
        self.assertAlmostEqual(selected["coverage"], 1.0)
        self.assertAlmostEqual(selected["acceptable_at1"], 10 / 11)
        self.assertAlmostEqual(selected["overall_decision_accuracy"], 10 / 11)
        self.assertEqual(selected["none_abstention_rate"], 0.0)

    def test_work_logo_is_complete_and_deterministic(self) -> None:
        samples = []
        features = []
        labels = []
        sample_indices = []
        candidate_indices = []
        for work_index in range(4):
            for local in range(2):
                sample_index = len(samples)
                samples.append(
                    CAL.BoundSample(
                        sample_id=f"s{sample_index}",
                        work_id=f"w{work_index}",
                        role="dialogue",
                        manifest={},
                        label={},
                        preferred=frozenset({"a"}),
                        positive=frozenset({"a"}),
                        excluded=frozenset(),
                        none_acceptable=False,
                        label_confidence=1.0,
                    )
                )
                for candidate in range(2):
                    features.append([1.0 - candidate, work_index / 10, float(local)])
                    labels.append(1 - candidate)
                    sample_indices.append(sample_index)
                    candidate_indices.append(candidate)
        table = CAL.CandidateTable(
            np.asarray(features),
            np.asarray(labels),
            np.ones(len(labels)),
            np.asarray(sample_indices),
            np.asarray(candidate_indices),
            ("x", "work_noise", "local"),
        )
        first, folds, selected = CAL.work_logo_predictions(table, samples, (0.03, 0.1))
        second, _, _ = CAL.work_logo_predictions(table, samples, (0.03, 0.1))
        np.testing.assert_allclose(first, second)
        self.assertTrue(np.isfinite(first).all())
        self.assertEqual(len(folds), 4)
        self.assertEqual(len(selected), 4)

    def test_sealed_artifact_rejects_tamper_and_non_val_leakage(self) -> None:
        candidate_ids = [f"font-{index:02d}" for index in range(15)]
        feature_names = [
            *CAL.CONTINUOUS_FEATURE_NAMES,
            *(f"candidate_id::{candidate_id}" for candidate_id in candidate_ids),
        ]
        record = CAL.seal_record(
            {
                "bindings": {},
                "candidate_ids": candidate_ids,
                "feature_contract": CAL.feature_contract(),
                "feature_names": feature_names,
                "leakage_audit": {
                    "test_rows_used_for_fit": 0,
                    "train_rows_used_for_fit": 0,
                    "non_val_label_rows_parsed": 0,
                },
                "logistic": {
                    "c": 0.1,
                    "coef": [1.0] * len(feature_names),
                    "intercept": 0.0,
                },
                "oof_report": {},
                "operating_points": {
                    "body": point(),
                    "variant": point(),
                    "global": point(),
                },
                "record_type": CAL.RECORD_TYPE,
                "scaler": {
                    "mean": [0.0] * len(feature_names),
                    "scale": [1.0] * len(feature_names),
                },
                "schema_version": CAL.SCHEMA_VERSION,
                "training_boundary": {},
            }
        )
        CAL.validate_calibration(record)
        tampered = copy.deepcopy(record)
        tampered["logistic"]["coef"][0] = 2.0
        with self.assertRaisesRegex(CAL.SelectionCalibrationError, "seal mismatch"):
            CAL.validate_calibration(tampered)
        leaked = copy.deepcopy(record)
        leaked["leakage_audit"]["test_rows_used_for_fit"] = 1
        leaked = CAL.seal_record(leaked)
        with self.assertRaisesRegex(CAL.SelectionCalibrationError, "leaked"):
            CAL.validate_calibration(leaked)

    @staticmethod
    def _manifest(sample_id: str, work_id: str, split: str, group: str):
        return {
            "id": sample_id,
            "split": split,
            "work": {"id": work_id},
            "groups": {
                "split_component": group,
                "normalized_glyph": f"glyph-{group}",
            },
            "page": {"source_page_sha256": f"{ord(sample_id[0]):064x}"[-64:]},
        }


if __name__ == "__main__":
    unittest.main()
