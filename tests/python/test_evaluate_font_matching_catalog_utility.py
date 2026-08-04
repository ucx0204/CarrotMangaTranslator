from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping

import numpy as np
from safetensors.numpy import save_file


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "evaluate_font_matching_catalog_utility.py"
SPEC = importlib.util.spec_from_file_location(
    "evaluate_font_matching_catalog_utility_tested", SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT}")
UTILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = UTILITY
SPEC.loader.exec_module(UTILITY)


EVAL = UTILITY.offline
TRAINER = UTILITY.trainer
CANDIDATES = tuple(f"font-{index:02d}" for index in range(22))
LEGACY = CANDIDATES[:15]
FONT_CATALOG_SHA = UTILITY.sha256_bytes(b"full-22-font-catalog")


def sha(label: str) -> str:
    return UTILITY.sha256_bytes(label.encode("utf-8"))


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.write_bytes(UTILITY.canonical_json_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: list[Mapping[str, Any]]) -> None:
    path.write_bytes(b"".join(UTILITY.canonical_json_bytes(row) for row in rows))


def artifact(path: Path, *, record_count: int | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": UTILITY.sha256_file(path),
    }
    if record_count is not None:
        value["record_count"] = record_count
    return value


def style() -> dict[str, Any]:
    return {
        "angularity": 0.25,
        "energy": 0.5,
        "handwritten": 0.25,
        "irregularity": 0.25,
        "roundness": 0.25,
        "serifness": 0.25,
        "slant": 0.0,
        "stroke_contrast": 0.25,
        "unknown_fields": [],
        "weight": 0.5,
        "width": 0.5,
    }


def treatment() -> dict[str, str]:
    return {
        "distortion": "none",
        "fill": "solid",
        "orientation": "horizontal",
        "outline": "none",
        "shadow": "none",
    }


class Fixture:
    def __init__(self, root: Path, *, formal: bool = False):
        self.root = root
        self.export = root / "training-export"
        self.cache = root / "feature-cache"
        self.reference = root / "ordinary-reference"
        self.successor = root / "successor"
        self.registry = root / "font-matching-catalog-registry-v2.json"
        self.render = root / "render-bank-manifest.json"
        self.output = root / "utility.json"
        self.formal = formal
        self.sample_rows: list[dict[str, Any]] = []
        self.listwise_rows: list[dict[str, Any]] = []
        self._write_registry_and_render()
        self._write_export()
        self.model_inputs = {
            "catalog_registry_sha256": UTILITY.sha256_file(self.registry),
            "font_catalog_sha256": FONT_CATALOG_SHA,
            "render_bank_manifest_sha256": UTILITY.sha256_file(self.render),
            "samples_sha256": UTILITY.sha256_file(self.export / "samples.jsonl"),
            "training_export_manifest_sha256": UTILITY.sha256_file(
                self.export / "manifest.json"
            ),
        }
        self._write_cache()
        self._write_reference()
        self._write_successor()

    @property
    def kwargs(self) -> dict[str, Path]:
        return {
            "catalog_registry": self.registry,
            "feature_cache_dir": self.cache,
            "ordinary_reference_output_dir": self.reference,
            "render_bank_manifest": self.render,
            "trainer_output_dir": self.successor,
            "training_export_dir": self.export,
        }

    def _write_registry_and_render(self) -> None:
        write_json(
            self.registry,
            UTILITY.seal(
                {
                    "record_type": "font_matching_catalog_registry",
                    "schema_version": "font-matching-catalog-registry-v1",
                }
            ),
        )
        render_candidates = [
            {
                "font_id": candidate,
                "production_400_normal_canonical": True,
            }
            for candidate in CANDIDATES
        ]
        render_candidates.append(
            {
                "font_id": CANDIDATES[0],
                "production_400_normal_canonical": False,
            }
        )
        write_json(
            self.render,
            {
                "candidate_count": len(render_candidates),
                "candidates": render_candidates,
                "generation": {"complete_against_production_assets": True},
                "render_spec": {"qa_overlay": False},
                "rendered_candidate_count": len(render_candidates),
                "schema_version": "font-render-bank-v1",
                "source_contract": {"manifest_sha256": FONT_CATALOG_SHA},
                "specification_sha256": sha("render-specification"),
            },
        )

    def _judgment(
        self,
        *,
        preferred: tuple[str, ...],
        acceptable: tuple[str, ...] = (),
        unrenderable: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        assigned = set(preferred) | set(acceptable) | set(unrenderable)
        return {
            "acceptable": list(acceptable),
            "marginal": [],
            "none_acceptable": False,
            "not_reviewed": [],
            "preferred": list(preferred),
            "unacceptable": [
                candidate for candidate in CANDIDATES if candidate not in assigned
            ],
            "unrenderable": list(unrenderable),
        }

    def _write_export(self) -> None:
        self.export.mkdir()
        specs = (
            ("train-p0", "work-00", "train", "dialogue", 0, (CANDIDATES[0],), ()),
            ("train-p1", "work-01", "train", "sfx_impact", 1, (CANDIDATES[15],), ()),
            ("train-p2", "work-02", "train", "dialogue", 2, (CANDIDATES[1],), ()),
            (
                "val-p1",
                "work-03",
                "val",
                "aside_balloon_edge",
                1,
                (CANDIDATES[15],),
                (CANDIDATES[0],),
            ),
            ("val-p2", "work-04", "val", "dialogue", 2, (CANDIDATES[2],), ()),
            (
                "val-p0",
                "work-05",
                "val",
                "narration",
                0,
                (CANDIDATES[16],),
                (),
            ),
        ) + tuple(
            (
                f"val-p2-extra-{index:02d}",
                f"work-extra-{index:02d}",
                "val",
                "dialogue",
                2,
                (CANDIDATES[2],),
                (),
            )
            for index in range(19)
        )
        for index, (
            sample_id,
            work_id,
            split,
            role,
            priority,
            preferred,
            acceptable,
        ) in enumerate(specs):
            unrenderable = (CANDIDATES[-1],) if sample_id == "val-p0" else ()
            judgment = self._judgment(
                preferred=preferred,
                acceptable=acceptable,
                unrenderable=unrenderable,
            )
            sample = EVAL.seal(
                {
                    "chapter_id": f"chapter-{index}",
                    "cohorts": ["variant"] if priority == 1 else [],
                    "consistency": {
                        "action": "inherit_anchor",
                        "policy": "inherit_work_anchor",
                        "reason_code": "fixture_consistency",
                    },
                    "example_id": f"example-{sample_id}",
                    "font_judgment": judgment,
                    "input_bindings": {
                        "font_catalog_sha256": FONT_CATALOG_SHA,
                        "master_manifest_sha256": sha("master"),
                        "render_bank_manifest_sha256": UTILITY.sha256_file(self.render),
                        "render_specification_sha256": sha("render-specification"),
                        "renderer_hash": UTILITY.sha256_file(self.render),
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
                        "resolution": {"flags": [], "kind": "blind_agreement"},
                        "review_card_used_as_training_input": False,
                        "source_reviews": [],
                    },
                    "role": {"confidence": 0.95, "primary": role},
                    "sample_id": sample_id,
                    "schema_version": EVAL.SAMPLE_SCHEMA_VERSION,
                    "source": {
                        "geometry": {"bbox_px": [1, 2, 30, 40]},
                        "sample_crop_sha256": sha(f"crop-{sample_id}"),
                        "source_page_sha256": sha(f"page-{sample_id}"),
                        "views": {},
                    },
                    "source_style": style(),
                    "split": split,
                    "treatment": treatment(),
                    "variant": {
                        "class": TRAINER.PRIORITY_NAMES[priority],
                        "priority": priority,
                    },
                    "work_id": work_id,
                }
            )
            tier_by_candidate = {
                candidate: tier
                for tier in (*EVAL.RANKED_TIERS, *EVAL.SKIPPED_TIERS)
                for candidate in judgment[tier]
            }
            listwise = EVAL.seal(
                {
                    "abstain_target": False,
                    "candidate_targets": [
                        {
                            "candidate_id": candidate,
                            "loss_eligible": tier_by_candidate[candidate]
                            in EVAL.RANKED_TIERS,
                            "relevance_gain": (
                                EVAL.TIER_GAIN[tier_by_candidate[candidate]]
                                if tier_by_candidate[candidate] in EVAL.RANKED_TIERS
                                else None
                            ),
                            "tier": tier_by_candidate[candidate],
                        }
                        for candidate in CANDIDATES
                    ],
                    "example_id": f"listwise-{sample_id}",
                    "sample_id": sample_id,
                    "schema_version": EVAL.LISTWISE_SCHEMA_VERSION,
                    "split": split,
                    "training_sample_record_sha256": sample["record_sha256"],
                    "work_id": work_id,
                }
            )
            self.sample_rows.append(sample)
            self.listwise_rows.append(listwise)
        samples_path = self.export / "samples.jsonl"
        listwise_path = self.export / "listwise.jsonl"
        write_jsonl(samples_path, self.sample_rows)
        write_jsonl(listwise_path, self.listwise_rows)
        authority = {
            "all_22_candidates_retained_for_utility_audit": True,
            "candidate_count": 22,
            "catalog_disposition_record_sha256": (
                sha("disposition") if self.formal else None
            ),
            "eligibility_exceptions_excluded": True,
            "formal_calibration_gate_passed": self.formal,
            "old_tier_mutation_allowed": False,
            "provisional_catalog_record_sha256": (
                sha("provisional") if self.formal else None
            ),
            "resolved_label_file": "resolved-labels-full22.jsonl",
            "schema_version": "font-matching-provisional-full22-export-v1",
            "selection_mode": (
                UTILITY.FORMAL_SELECTION_MODE
                if self.formal
                else UTILITY.STRICT_SELECTION_MODE
            ),
            "tier_merge": "immutable_prior15_plus_exact_resolved_delta7",
            "top1_synthesis_allowed": False,
            "training_only": True,
            "training_quarantine_excluded": True,
        }
        manifest_path = self.export / "manifest.json"
        write_json(
            manifest_path,
            {
                "artifacts": {
                    "listwise.jsonl": artifact(
                        listwise_path, record_count=len(self.listwise_rows)
                    ),
                    "samples.jsonl": artifact(
                        samples_path, record_count=len(self.sample_rows)
                    ),
                },
                "candidate_count": len(CANDIDATES),
                "contracts": {"provisional_full22": authority},
                "input_hashes": {
                    "catalog_registry_sha256": UTILITY.sha256_file(self.registry),
                    "font_catalog_sha256": FONT_CATALOG_SHA,
                    "render_bank_manifest_sha256": UTILITY.sha256_file(self.render),
                },
                "real_sample_count": len(self.sample_rows),
                "renderer_bindings": {
                    "font_catalog_sha256": FONT_CATALOG_SHA,
                    "render_bank_manifest_sha256": UTILITY.sha256_file(self.render),
                    "render_specification_sha256": sha("render-specification"),
                    "renderer_hash": UTILITY.sha256_file(self.render),
                },
                "schema_version": EVAL.EXPORT_SCHEMA_VERSION,
                "work_split": {
                    row["work_id"]: row["split"] for row in self.sample_rows
                },
            },
        )
        write_json(
            self.export / EVAL.EXPORT_MARKER_FILE,
            {
                "manifest_sha256": UTILITY.sha256_file(manifest_path),
                "owner": EVAL.EXPORT_OWNER,
                "report_sha256": sha("export-report"),
                "safe_replace": True,
                "schema_version": EVAL.EXPORT_SCHEMA_VERSION,
            },
        )

    def _projection_state(self) -> dict[str, np.ndarray]:
        return {
            "prototype_projection.0.bias": np.zeros(4, dtype=np.float32),
            "prototype_projection.0.weight": np.ones(4, dtype=np.float32),
            "prototype_projection.1.weight": np.asarray(
                [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
                dtype=np.float32,
            ),
        }

    def _write_cache(self) -> None:
        self.cache.mkdir()
        rng = np.random.default_rng(20260802)
        prototype = rng.normal(size=(len(CANDIDATES) * 2, 4)).astype(np.float32)
        sample = rng.normal(size=(len(self.sample_rows), 3, 4)).astype(np.float32)
        prototype_path = self.cache / "prototype-features.npy"
        sample_path = self.cache / "sample-features.npy"
        np.save(prototype_path, prototype, allow_pickle=False)
        np.save(sample_path, sample, allow_pickle=False)
        prototype_index = []
        for candidate in CANDIDATES:
            for probe_id, writing_mode in (
                ("dialogue-body", "horizontal"),
                ("sfx-impact", "vertical"),
            ):
                prototype_index.append(
                    {
                        "font_id": candidate,
                        "probe_id": probe_id,
                        "render_id": f"render-{len(prototype_index):03d}",
                        "row_index": len(prototype_index),
                        "writing_mode": writing_mode,
                    }
                )

        def array_artifact(path: Path, value: np.ndarray) -> dict[str, Any]:
            return {
                **artifact(path),
                "dtype": str(value.dtype),
                "shape": list(value.shape),
            }

        manifest_path = self.cache / "manifest.json"
        write_json(
            manifest_path,
            UTILITY.seal(
                {
                    "artifacts": {
                        "prototype-features.npy": array_artifact(
                            prototype_path, prototype
                        ),
                        "sample-features.npy": array_artifact(sample_path, sample),
                    },
                    "contract": {
                        "inputs": {
                            key: copy.deepcopy(value)
                            for key, value in self.model_inputs.items()
                            if key not in {"chapter_pairs", "font_catalog_sha256"}
                        }
                    },
                    "prototype_index": prototype_index,
                    "processor_config_sha256": sha("processor-config"),
                    "record_type": "font_matching_siglip_feature_cache",
                    "schema_version": TRAINER.CACHE_SCHEMA_VERSION,
                }
            ),
        )
        write_json(
            self.cache / ".font-matching-siglip-feature-cache-owned.json",
            {
                "manifest_sha256": UTILITY.sha256_file(manifest_path),
                "owner": TRAINER.CACHE_OWNER,
                "safe_replace": True,
                "schema_version": TRAINER.CACHE_SCHEMA_VERSION,
            },
        )

    def _write_reference(self) -> None:
        self.reference.mkdir()
        checkpoint = self.reference / "checkpoint.safetensors"
        save_file(self._projection_state(), checkpoint)
        predictions = self.reference / "predictions-val.jsonl"
        predictions.write_bytes(b"")
        contract_path = self.reference / "model-contract.json"
        reference_inputs = {"training_export_manifest_sha256": sha("old-export")}
        write_json(
            contract_path,
            UTILITY.seal(
                {
                    "checkpoint": {
                        "file": checkpoint.name,
                        "sha256": UTILITY.sha256_file(checkpoint),
                    },
                    "inputs": reference_inputs,
                    "record_type": "font_matching_siglip_model_contract",
                    "schema_version": TRAINER.MODEL_CONTRACT_SCHEMA_VERSION,
                    "vocabulary": {"candidate_ids": list(LEGACY)},
                }
            ),
        )
        report_path = self.reference / "report.json"
        write_json(
            report_path,
            UTILITY.seal(
                {
                    "artifacts": {
                        checkpoint.name: artifact(checkpoint),
                        contract_path.name: artifact(contract_path),
                        predictions.name: artifact(predictions),
                    },
                    "checks": {
                        "candidate_id_classifier_parameters": 0,
                        "encoder_fully_frozen": True,
                        "prediction_semantics_from_model_heads": True,
                        "synthetic_or_qa_inputs": 0,
                        "test_pixels_opened_or_cached": 0,
                    },
                    "input_hashes": reference_inputs,
                    "model_contract_sha256": UTILITY.sha256_file(contract_path),
                    "record_type": "font_matching_siglip_training_report",
                    "schema_version": TRAINER.REPORT_SCHEMA_VERSION,
                }
            ),
        )
        self._write_trainer_marker(self.reference)

    def _prediction_rows(self, checkpoint_sha: str) -> list[dict[str, Any]]:
        sample_by_id = {row["sample_id"]: row for row in self.sample_rows}
        listwise_by_id = {row["sample_id"]: row for row in self.listwise_rows}
        tops = {
            "val-p0": CANDIDATES[16],
            "val-p1": CANDIDATES[15],
            "val-p2": CANDIDATES[3],
        }
        tops.update(
            {
                str(row["sample_id"]): CANDIDATES[2]
                for row in self.sample_rows
                if str(row["sample_id"]).startswith("val-p2-extra-")
            }
        )
        output = []
        manifest_sha = UTILITY.sha256_file(self.export / "manifest.json")
        for sample_id in sorted(tops):
            sample = sample_by_id[sample_id]
            top = tops[sample_id]
            ranking = [top] + [
                candidate for candidate in CANDIDATES if candidate != top
            ]
            output.append(
                EVAL.seal(
                    {
                        "bindings": {
                            "font_catalog_sha256": FONT_CATALOG_SHA,
                            "listwise_target_record_sha256": listwise_by_id[sample_id][
                                "record_sha256"
                            ],
                            "training_export_manifest_sha256": manifest_sha,
                            "training_sample_record_sha256": sample["record_sha256"],
                        },
                        "confidence": 0.9,
                        "model": {
                            "id": "font-matching-siglip-full22",
                            "sha256": checkpoint_sha,
                        },
                        "none_probability": 0.05,
                        "ranked_candidate_ids": ranking,
                        "role": {"primary": sample["role"]["primary"]},
                        "sample_id": sample_id,
                        "schema_version": EVAL.PREDICTION_SCHEMA_VERSION,
                        "source_style": {
                            field: sample["source_style"][field]
                            for field in EVAL.STYLE_FIELDS
                        },
                        "split": "val",
                        "treatment": copy.deepcopy(sample["treatment"]),
                        "variants": {},
                        "work_id": sample["work_id"],
                    }
                )
            )
        return output

    def _write_successor(self) -> None:
        self.successor.mkdir()
        checkpoint = self.successor / "checkpoint.safetensors"
        save_file(self._projection_state(), checkpoint)
        checkpoint_sha = UTILITY.sha256_file(checkpoint)
        predictions = self.successor / "predictions-val.jsonl"
        write_jsonl(predictions, self._prediction_rows(checkpoint_sha))
        reference_binding = {
            "checkpoint_sha256": UTILITY.sha256_file(
                self.reference / "checkpoint.safetensors"
            ),
            "model_contract_sha256": UTILITY.sha256_file(
                self.reference / "model-contract.json"
            ),
            "output_marker_sha256": UTILITY.sha256_file(
                self.reference / ".font-matching-siglip-baseline-owned.json"
            ),
            "report_sha256": UTILITY.sha256_file(self.reference / "report.json"),
            "source_code_sha256": sha("ordinary-reference-code"),
            "source_candidate_count": len(LEGACY),
            "source_inputs_sha256": sha("ordinary-reference-inputs"),
            "optimizer_seed_allowed": False,
            "test_pixels_opened_from_reference": 0,
            "usage": "evaluation_only_ordinary_regression_baseline",
        }
        baseline_metrics = {
            "overall": {"acceptable_at_1": 0.5},
            "priority": {"2": {"acceptable_at_1": 0.5, "sample_count": 20}},
            "split": "val_original_distribution",
        }
        best_metrics = {
            "overall": {"acceptable_at_1": 0.67},
            "priority": {"2": {"acceptable_at_1": 0.67, "sample_count": 20}},
            "split": "val_original_distribution",
        }
        checkpoint_selection = {
            "baseline_status": "production_reference",
            "baseline_validation_metrics": baseline_metrics,
            "best_ordinary_regression_gate": TRAINER.ordinary_regression_gate(
                metrics=best_metrics,
                baseline_metrics=baseline_metrics,
                production_reference_required=True,
            ),
            "ordinary_acceptable_at_1_regression_limit": (
                TRAINER.ORDINARY_TOP1_REGRESSION_LIMIT
            ),
            "ordinary_baseline_source": (
                "validated_owned_prior_checkpoint_evaluation_only"
            ),
            "ordinary_reference_argument_seeded_optimizer": False,
            "optimizer_seeded_from_ordinary_reference": False,
            "reference": reference_binding,
            "resume_requires_separate_resume_from_argument": True,
        }
        contract_path = self.successor / "model-contract.json"
        write_json(
            contract_path,
            UTILITY.seal(
                {
                    "checkpoint": {
                        "file": checkpoint.name,
                        "sha256": checkpoint_sha,
                    },
                    "feature_cache": {
                        "manifest_sha256": UTILITY.sha256_file(
                            self.cache / "manifest.json"
                        ),
                        "processor_config_sha256": sha("processor-config"),
                    },
                    "inputs": copy.deepcopy(self.model_inputs),
                    "ordinary_regression_safety": copy.deepcopy(checkpoint_selection),
                    "record_type": "font_matching_siglip_model_contract",
                    "schema_version": TRAINER.MODEL_CONTRACT_SCHEMA_VERSION,
                    "vocabulary": {"candidate_ids": list(CANDIDATES)},
                }
            ),
        )
        report_path = self.successor / "report.json"
        write_json(
            report_path,
            UTILITY.seal(
                {
                    "artifacts": {
                        checkpoint.name: artifact(checkpoint),
                        contract_path.name: artifact(contract_path),
                        predictions.name: artifact(predictions),
                    },
                    "checks": {
                        "candidate_id_classifier_parameters": 0,
                        "chapter_pair_test_rows_used": 0,
                        "encoder_fully_frozen": True,
                        "prediction_semantics_from_model_heads": True,
                        "synthetic_or_qa_inputs": 0,
                        "test_pixels_opened_or_cached": 0,
                        "test_rows_used_for_optimizer_calibration_prototypes_or_hard_negatives": 0,
                    },
                    "input_hashes": copy.deepcopy(self.model_inputs),
                    "model_contract_sha256": UTILITY.sha256_file(contract_path),
                    "record_type": "font_matching_siglip_training_report",
                    "schema_version": TRAINER.REPORT_SCHEMA_VERSION,
                    "training": {
                        "best_validation_metrics": best_metrics,
                        "checkpoint_selection": checkpoint_selection,
                    },
                }
            ),
        )
        self._write_trainer_marker(self.successor)

    def rewrite_successor_safety(self, mutate: Any) -> None:
        report_path = self.successor / "report.json"
        contract_path = self.successor / "model-contract.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        selection = report["training"]["checkpoint_selection"]
        mutate(selection)
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract["ordinary_regression_safety"] = copy.deepcopy(selection)
        write_json(contract_path, UTILITY.seal(contract))
        report["model_contract_sha256"] = UTILITY.sha256_file(contract_path)
        report["artifacts"]["model-contract.json"] = artifact(contract_path)
        write_json(report_path, UTILITY.seal(report))
        self._write_trainer_marker(self.successor)

    @staticmethod
    def _write_trainer_marker(root: Path) -> None:
        names = (
            "checkpoint.safetensors",
            "model-contract.json",
            "predictions-val.jsonl",
            "report.json",
        )
        write_json(
            root / ".font-matching-siglip-baseline-owned.json",
            {
                "artifacts": {name: UTILITY.sha256_file(root / name) for name in names},
                "owner": TRAINER.OUTPUT_OWNER,
                "safe_replace": True,
                "schema_version": TRAINER.TRAINER_SCHEMA_VERSION,
            },
        )


class CatalogUtilityEvaluationTest(unittest.TestCase):
    def test_priority_reproduction_preserves_trainer_unknown_style_mask(self) -> None:
        source_style = style()
        source_style["handwritten"] = None
        source_style["unknown_fields"] = ["handwritten"]
        row = {
            "font_judgment": {"none_acceptable": False},
            "source_style": source_style,
        }
        target = SimpleNamespace(sample_id="sample-masked", role="dialogue")
        self.assertEqual(UTILITY._sample_priority(row, target), 2)

        mismatched = copy.deepcopy(row)
        mismatched["source_style"]["handwritten"] = 0.5
        with self.assertRaisesRegex(
            UTILITY.UtilityEvaluationError, "unknown mask/value mismatch"
        ):
            UTILITY._sample_priority(mismatched, target)

    def test_canonical_registry_v2_loader_rejects_v3_substitution(self) -> None:
        registry_v2 = ROOT / "datasets" / "font-matching-catalog-registry-v2.json"
        registry_v3 = ROOT / "datasets" / "font-matching-catalog-registry-v3.json"
        expected_sha = UTILITY.sha256_file(registry_v2)
        _, actual_sha = UTILITY._validate_registry(
            registry_v2,
            expected_sha256=expected_sha,
            manifest_inputs={"catalog_registry_sha256": expected_sha},
        )
        self.assertEqual(actual_sha, expected_sha)
        with self.assertRaisesRegex(
            UTILITY.UtilityEvaluationError, "catalog registry hash binding failed"
        ):
            UTILITY._validate_registry(
                registry_v3,
                expected_sha256=expected_sha,
                manifest_inputs={"catalog_registry_sha256": expected_sha},
            )

    def test_cli_example_uses_bound_registry_v2(self) -> None:
        help_text = UTILITY.build_parser().format_help()
        self.assertIn("datasets/font-matching-catalog-registry-v2.json", help_text)
        self.assertNotIn("font-matching-catalog-registry-v3.json", help_text)

    def test_strict_build_validate_and_metric_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            result = UTILITY.build_output(output=fixture.output, **fixture.kwargs)
            self.assertEqual(result["audit_mode"], "strict_consensus_diagnostic")
            self.assertEqual(result["candidate_count"], 22)
            validated = UTILITY.validate_output(output=fixture.output, **fixture.kwargs)
            self.assertEqual(validated["status"], "valid")

            report = json.loads(fixture.output.read_text(encoding="utf-8"))
            self.assertEqual(
                set(report),
                {
                    "audit_mode",
                    "authority",
                    "candidate_count",
                    "candidate_ids",
                    "candidates",
                    "collision_reference",
                    "decision_boundary",
                    "input_hashes",
                    "record_sha256",
                    "record_type",
                    "schema_version",
                    "summary",
                },
            )
            challenger = next(
                row for row in report["candidates"] if row["candidate_id"] == "font-15"
            )
            self.assertEqual(challenger["metrics"]["human"]["unique_p1_safe_count"], 1)
            self.assertEqual(
                challenger["metrics"]["validation_prediction"]["candidate_recall_at_1"],
                1.0,
            )
            self.assertEqual(set(challenger["by_priority"]), {"0", "1", "2"})
            self.assertEqual(set(challenger["by_role"]), set(TRAINER.ROLE_VALUES))
            self.assertTrue(
                all(
                    row["recommendation"]
                    == {
                        "action": "diagnostic_only",
                        "active_release_eligible": False,
                        "deletion_allowed": False,
                        "reason": "pending_formal_adjudication",
                        "terminal": False,
                    }
                    for row in report["candidates"]
                )
            )

    def test_resealed_terminal_disposition_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            UTILITY.build_output(output=fixture.output, **fixture.kwargs)
            report = json.loads(fixture.output.read_text(encoding="utf-8"))
            report["candidates"][0]["recommendation"]["terminal"] = True
            write_json(fixture.output, UTILITY.seal(report))
            with self.assertRaisesRegex(
                UTILITY.UtilityEvaluationError, "attempted a catalog disposition"
            ):
                UTILITY.validate_output(output=fixture.output, **fixture.kwargs)

    def test_resealed_nested_schema_extension_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            UTILITY.build_output(output=fixture.output, **fixture.kwargs)
            report = json.loads(fixture.output.read_text(encoding="utf-8"))
            report["candidates"][0]["metrics"]["human"]["invented"] = 1
            write_json(fixture.output, UTILITY.seal(report))
            with self.assertRaisesRegex(
                UTILITY.UtilityEvaluationError, "field inventory drifted"
            ):
                UTILITY.validate_output(output=fixture.output, **fixture.kwargs)

    def test_chain_valid_reference_binding_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.rewrite_successor_safety(
                lambda selection: selection["reference"].__setitem__(
                    "checkpoint_sha256", sha("wrong-reference")
                )
            )
            with self.assertRaisesRegex(
                UTILITY.UtilityEvaluationError,
                "ordinary reference binding mismatch: checkpoint_sha256",
            ):
                UTILITY.build_report(**fixture.kwargs)

    def test_chain_valid_optimizer_seed_claim_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.rewrite_successor_safety(
                lambda selection: selection.__setitem__(
                    "optimizer_seeded_from_ordinary_reference", True
                )
            )
            with self.assertRaisesRegex(
                UTILITY.UtilityEvaluationError,
                "ordinary reference safety contract is invalid",
            ):
                UTILITY.build_report(**fixture.kwargs)

    def test_chain_valid_false_floor_claim_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.rewrite_successor_safety(
                lambda selection: selection[
                    "best_ordinary_regression_gate"
                ].__setitem__("current_acceptable_at_1", 0.5)
            )
            with self.assertRaisesRegex(
                UTILITY.UtilityEvaluationError,
                "ordinary regression floor was not reproduced",
            ):
                UTILITY.build_report(**fixture.kwargs)

    def test_chain_valid_priority2_count_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))

            def mutate(selection: dict[str, Any]) -> None:
                gate = selection["best_ordinary_regression_gate"]
                gate["baseline_sample_count"] = 21
                gate["current_sample_count"] = 21

            fixture.rewrite_successor_safety(mutate)
            with self.assertRaisesRegex(
                UTILITY.UtilityEvaluationError,
                "sample_count contract drifted",
            ):
                UTILITY.build_report(**fixture.kwargs)

    def test_formal_input_remains_non_terminal_evidence_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary), formal=True)
            report = UTILITY.build_report(**fixture.kwargs)
            self.assertEqual(report["audit_mode"], "formal_utility_evidence")
            self.assertEqual(
                report["decision_boundary"]["status"], "formal_evidence_only"
            )
            self.assertTrue(
                all(
                    row["recommendation"]["action"] == "evidence_only"
                    and row["recommendation"]["terminal"] is False
                    and row["recommendation"]["deletion_allowed"] is False
                    for row in report["candidates"]
                )
            )


if __name__ == "__main__":
    unittest.main()
