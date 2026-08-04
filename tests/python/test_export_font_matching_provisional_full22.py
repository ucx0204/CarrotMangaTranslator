from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "export_font_matching_provisional_full22.py"
SPEC = importlib.util.spec_from_file_location(
    "export_font_matching_provisional_full22", SCRIPT_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load exporter: {SCRIPT_PATH}")
EXPORT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = EXPORT
SPEC.loader.exec_module(EXPORT)


def judgment(
    *,
    preferred: list[str],
    acceptable: list[str],
    marginal: list[str],
    unacceptable: list[str],
) -> dict:
    return {
        "acceptable": acceptable,
        "marginal": marginal,
        "none_acceptable": not preferred and not acceptable,
        "not_reviewed": [],
        "preferred": preferred,
        "unacceptable": unacceptable,
        "unrenderable": [],
    }


def core_final(font_judgment: dict) -> dict:
    return {
        "consistency": {
            "policy": "inherit_work_anchor",
            "reason_code": "ordinary_dialogue",
        },
        "final_id": "fmfl-merged-authority",
        "font_judgment": copy.deepcopy(font_judgment),
        "record_type": EXPORT.labels.FINAL_RECORD_TYPE,
        "resolution": {
            "adjudication_evidence": None,
            "catalog_sha256": "a" * 64,
            "catalog_version": "font-face-manifest-v1",
            "confidence": 0.95,
            "flags": [],
            "kind": "blind_agreement",
            "notes": "",
            "renderer_hash": "b" * 64,
            "resolved_at": "2026-08-02T00:00:00Z",
            "resolver": "merge-resolver",
            "source_label_ids": ["prior-final", "delta-resolution"],
        },
        "role": {"confidence": 0.95, "primary": "dialogue"},
        "sample_id": "sample-001",
        "schema_version": EXPORT.labels.SCHEMA_VERSION,
        "source_page_sha256": "c" * 64,
        "source_style": {
            "angularity": 0.2,
            "energy": 0.3,
            "handwritten": 0.1,
            "irregularity": 0.1,
            "roundness": 0.4,
            "serifness": 0.2,
            "slant": 0.0,
            "stroke_contrast": 0.2,
            "unknown_fields": [],
            "weight": 0.5,
            "width": 0.5,
        },
        "treatment": {
            "distortion": "none",
            "fill": "solid",
            "orientation": "horizontal",
            "outline": "none",
            "shadow": "none",
        },
        "work_id": "work-001",
    }


class ProvisionalFull22ExporterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.old_judgment = judgment(
            preferred=["old-a", "old-b"],
            acceptable=[],
            marginal=[],
            unacceptable=["old-c"],
        )
        self.delta_judgment = judgment(
            preferred=[],
            acceptable=["new-a"],
            marginal=["new-b"],
            unacceptable=[],
        )
        self.merged_judgment = judgment(
            preferred=["old-a", "old-b"],
            acceptable=["new-a"],
            marginal=["new-b"],
            unacceptable=["old-c"],
        )
        self.prior_sample = {
            "review_provenance": {
                "resolution": {"source_label_ids": ["old-review-a", "old-review-b"]},
                "source_reviews": [
                    {
                        "label_id": "old-review-a",
                        "record_sha256": "1" * 64,
                        "reviewer": "old-reviewer-a",
                        "stage": "primary",
                    },
                    {
                        "label_id": "old-review-b",
                        "record_sha256": "2" * 64,
                        "reviewer": "old-reviewer-b",
                        "stage": "secondary",
                    },
                ],
            }
        }
        self.delta_resolution = EXPORT.base.seal(
            {
                "delta_label_id": "delta-resolution",
                "font_judgment": copy.deepcopy(self.delta_judgment),
                "record_type": "font_catalog_delta_resolved_label",
                "resolution_kind": "blind_agreement",
                "sample_id": "sample-001",
                "source_review_ids": ["v5-review-a", "v5-review-b"],
            }
        )
        self.v5_reviews = {
            "v5-review-a": {
                "assignment_id": "assignment-a",
                "confidence": 0.95,
                "evidence": {
                    "candidate_order_seed": "3" * 64,
                    "review_card_sha256": "4" * 64,
                },
                "record_sha256": "5" * 64,
                "review_id": "v5-review-a",
                "reviewed_at": "2026-08-02T00:00:00Z",
                "reviewer": "v5-reviewer-a",
                "stage": "primary",
            },
            "v5-review-b": {
                "assignment_id": "assignment-b",
                "confidence": 0.93,
                "evidence": {
                    "candidate_order_seed": "6" * 64,
                    "review_card_sha256": "7" * 64,
                },
                "record_sha256": "8" * 64,
                "review_id": "v5-review-b",
                "reviewed_at": "2026-08-02T00:00:01Z",
                "reviewer": "v5-reviewer-b",
                "stage": "secondary",
            },
        }

    def _sealed_prior_training_sample(self) -> dict:
        return EXPORT.base.seal(
            {
                "chapter_id": "chapter-001",
                "page_id": "page-001",
                "provenance": {"qa_overlay": False, "synthetic": False},
                "sample_id": "sample-001",
                "source": {"source_page_sha256": "c" * 64},
                "work_id": "work-001",
            }
        )

    def _training_only_authority(self) -> dict:
        return {
            "all_22_candidates_retained_for_utility_audit": True,
            "candidate_count": 22,
            "catalog_disposition_record_sha256": None,
            "eligibility_exceptions_excluded": True,
            "formal_calibration_gate_passed": False,
            "old_tier_mutation_allowed": False,
            "provisional_catalog_record_sha256": None,
            "resolved_label_file": EXPORT.RESOLVED_LABEL_FILE,
            "schema_version": EXPORT.AUTHORITY_SCHEMA_VERSION,
            "selection_mode": "unfinalized_exact_independent_consensus_only",
            "tier_merge": "immutable_prior15_plus_exact_resolved_delta7",
            "top1_synthesis_allowed": False,
            "training_only": True,
            "training_quarantine_excluded": True,
        }

    def _calibration_supplement(self) -> dict:
        supplemental_ids = [f"supplement-{index}" for index in range(7)]
        return {
            "manifest_record_sha256": "1" * 64,
            "manifest_file_sha256": "2" * 64,
            "preflight_final_report_record_sha256": "3" * 64,
            "preflight_scored_samples_record_sha256": "4" * 64,
            "preflight_quarantine_record_sha256": "5" * 64,
            "successor_master_manifest_sha256": "6" * 64,
            "successor_master_split_map_sha256": "0" * 64,
            "successor_catalog_registry_sha256": "7" * 64,
            "supplemental_sample_ids": supplemental_ids,
            "training_quarantine_sample_ids": [
                *supplemental_ids,
                "closure-only",
            ],
        }

    def _projection_prior(self, sample_id: str, *, split: str = "train") -> dict:
        master_provenance = {
            "approval": "exhaustive_manual_visual_review",
            "qa_overlay": False,
            "synthetic": False,
        }
        return {
            "chapter_id": f"chapter-{sample_id}",
            "input_bindings": {
                "catalog_registry_sha256": "a" * 64,
                "master_manifest_sha256": "b" * 64,
            },
            "page_id": f"page-{sample_id}",
            "provenance": {"master": master_provenance},
            "sample_id": sample_id,
            "source": {
                "geometry": {"height": 20, "width": 30, "x": 1, "y": 2},
                "sample_crop_sha256": "c" * 64,
                "source_page_sha256": "d" * 64,
                "views": {"raw_224": {"file_sha256": "e" * 64}},
            },
            "split": split,
            "work_id": f"work-{sample_id}",
        }

    def _projection_master(self, prior: dict) -> dict:
        source = prior["source"]
        return {
            "chapter_id": prior["chapter_id"],
            "geometry": copy.deepcopy(source["geometry"]),
            "master_provenance": copy.deepcopy(prior["provenance"]["master"]),
            "page_id": prior["page_id"],
            "sample_crop_sha256": source["sample_crop_sha256"],
            "sample_id": prior["sample_id"],
            "source_page_sha256": source["source_page_sha256"],
            "split": prior["split"],
            "views": copy.deepcopy(source["views"]),
            "work_id": prior["work_id"],
        }

    def test_training_sample_seals_exact_audited_parent_in_both_authorities(
        self,
    ) -> None:
        prior = self._sealed_prior_training_sample()
        final = EXPORT.base.seal(core_final(self.merged_judgment))
        sample = EXPORT._build_training_sample(
            prior_sample=prior,
            final=final,
            source_reviews=(),
            input_bindings={"catalog_registry_sha256": "a" * 64},
            authority=self._training_only_authority(),
        )

        EXPORT.base.validate_seal(sample, location="full22 successor sample")
        provenance_binding = sample["provenance"]["font_signal_audit_successor"]
        review_binding = sample["review_provenance"]["authority"][
            "font_signal_audit_successor"
        ]
        self.assertEqual(provenance_binding, review_binding)
        self.assertEqual(
            prior["record_sha256"],
            review_binding["parent_training_sample_record_sha256"],
        )
        self.assertEqual(
            {
                "chapter_id": "chapter-001",
                "page_id": "page-001",
                "sample_id": "sample-001",
                "source_page_sha256": "c" * 64,
                "work_id": "work-001",
            },
            review_binding["parent_identity"],
        )

    def test_training_sample_rejects_missing_or_tampered_parent_seal(self) -> None:
        final = EXPORT.base.seal(core_final(self.merged_judgment))
        for prior in (
            {
                key: value
                for key, value in self._sealed_prior_training_sample().items()
                if key != "record_sha256"
            },
            {**self._sealed_prior_training_sample(), "work_id": "work-tampered"},
        ):
            with (
                self.subTest(prior=prior),
                self.assertRaises(EXPORT.base.TrainingExportError),
            ):
                EXPORT._build_training_sample(
                    prior_sample=prior,
                    final=final,
                    source_reviews=(),
                    input_bindings={"catalog_registry_sha256": "a" * 64},
                    authority=self._training_only_authority(),
                )

    def test_rebind_preserves_exact_tiers_and_does_not_invent_top1(self) -> None:
        merged = EXPORT.base.seal(core_final(self.merged_judgment))
        final, source_reviews = EXPORT.rebind_merged_final_to_human_sources(
            merged_final=merged,
            prior_sample=self.prior_sample,
            prior_judgment=self.old_judgment,
            delta_resolution=self.delta_resolution,
            v5_reviews_by_id=self.v5_reviews,
            candidate_ids=("old-a", "old-b", "old-c", "new-a", "new-b"),
            resolver="full22-exporter",
        )

        self.assertEqual(["old-a", "old-b"], final["font_judgment"]["preferred"])
        self.assertEqual(["new-a"], final["font_judgment"]["acceptable"])
        self.assertEqual(["new-b"], final["font_judgment"]["marginal"])
        self.assertEqual(
            ["old-review-a", "old-review-b", "v5-review-a", "v5-review-b"],
            final["resolution"]["source_label_ids"],
        )
        self.assertEqual(
            set(final["resolution"]["source_label_ids"]),
            {row["label_id"] for row in source_reviews},
        )
        EXPORT.labels.validate_final_record(
            final,
            candidate_ids=("old-a", "old-b", "old-c", "new-a", "new-b"),
        )

    def test_rebind_rejects_any_prior_tier_mutation(self) -> None:
        changed = copy.deepcopy(self.merged_judgment)
        changed["preferred"].remove("old-b")
        changed["acceptable"].append("old-b")
        merged = EXPORT.base.seal(core_final(changed))

        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "mutated or reordered the sealed preferred tier",
        ):
            EXPORT.rebind_merged_final_to_human_sources(
                merged_final=merged,
                prior_sample=self.prior_sample,
                prior_judgment=self.old_judgment,
                delta_resolution=self.delta_resolution,
                v5_reviews_by_id=self.v5_reviews,
                candidate_ids=("old-a", "old-b", "old-c", "new-a", "new-b"),
                resolver="full22-exporter",
            )

    def test_successor_projection_requires_every_sealed_supplement_hash(self) -> None:
        supplement = self._calibration_supplement()
        expected_records = EXPORT.delta._calibration_supplement_source_records(
            supplement
        )
        rescue_inputs = {
            "catalog_registry_sha256": "8" * 64,
            "master_manifest_sha256": "9" * 64,
            "master_split_map_sha256": "a" * 64,
        }
        source_records = {
            **expected_records,
            "catalog_registry_sha256": rescue_inputs["catalog_registry_sha256"],
            "master_manifest_sha256": rescue_inputs["master_manifest_sha256"],
            "master_split_map_sha256": supplement["successor_master_split_map_sha256"],
        }

        projection = EXPORT._resolve_master_registry_projection(
            state_source={"calibration_only_supplement": supplement},
            source_records=source_records,
            rescue_report_inputs=rescue_inputs,
            actual_master_sha256=supplement["successor_master_manifest_sha256"],
            actual_catalog_registry_sha256=supplement[
                "successor_catalog_registry_sha256"
            ],
            formal_finalized=True,
            allow_unfinalized_strict_consensus=False,
        )
        self.assertEqual("sealed_calibration_supplement_successor", projection["mode"])
        self.assertEqual(7, len(projection["supplemental_sample_ids"]))

        for key in expected_records:
            with self.subTest(key=key):
                tampered = {**source_records, key: "f" * 64}
                with self.assertRaisesRegex(
                    EXPORT.ProvisionalFull22ExportError,
                    "supplement source record changed",
                ):
                    EXPORT._resolve_master_registry_projection(
                        state_source={"calibration_only_supplement": supplement},
                        source_records=tampered,
                        rescue_report_inputs=rescue_inputs,
                        actual_master_sha256=supplement[
                            "successor_master_manifest_sha256"
                        ],
                        actual_catalog_registry_sha256=supplement[
                            "successor_catalog_registry_sha256"
                        ],
                        formal_finalized=True,
                        allow_unfinalized_strict_consensus=False,
                    )

    def test_successor_projection_rejects_unsealed_or_unfinalized_authority(
        self,
    ) -> None:
        rescue_inputs = {
            "catalog_registry_sha256": "8" * 64,
            "master_manifest_sha256": "9" * 64,
            "master_split_map_sha256": "a" * 64,
        }
        base_records = {
            "catalog_registry_sha256": rescue_inputs["catalog_registry_sha256"],
            "master_manifest_sha256": rescue_inputs["master_manifest_sha256"],
            "master_split_map_sha256": rescue_inputs["master_split_map_sha256"],
        }
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "exact authority sealed by v4/v5",
        ):
            EXPORT._resolve_master_registry_projection(
                state_source={},
                source_records=base_records,
                rescue_report_inputs=rescue_inputs,
                actual_master_sha256="6" * 64,
                actual_catalog_registry_sha256="7" * 64,
                formal_finalized=True,
                allow_unfinalized_strict_consensus=False,
            )

        supplement = self._calibration_supplement()
        source_records = {
            **base_records,
            **EXPORT.delta._calibration_supplement_source_records(supplement),
            "master_split_map_sha256": supplement["successor_master_split_map_sha256"],
        }
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "requires formal finalized calibration",
        ):
            EXPORT._resolve_master_registry_projection(
                state_source={"calibration_only_supplement": supplement},
                source_records=source_records,
                rescue_report_inputs=rescue_inputs,
                actual_master_sha256=supplement["successor_master_manifest_sha256"],
                actual_catalog_registry_sha256=supplement[
                    "successor_catalog_registry_sha256"
                ],
                formal_finalized=False,
                allow_unfinalized_strict_consensus=False,
            )

    def test_supplement_samples_never_require_or_accept_prior_labels(self) -> None:
        supplemental = {
            "baseline_label_fields_present": False,
            "candidate_score_or_rank_fields_present": False,
            "record_type": "font_matching_calibration_only_supplement_sample",
            "schema_version": EXPORT.delta.CALIBRATION_SUPPLEMENT_SCHEMA_VERSION,
            "training_disposition": (
                EXPORT.delta.CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION
            ),
        }
        selected = EXPORT._prior_label_selection_ids(
            {"base": {"merge_provenance": {}}, "supplement": supplemental},
            supplemental_sample_ids=("supplement",),
        )
        self.assertEqual({"base"}, selected)

        inherited = {
            **supplemental,
            "baseline_label_fields_present": True,
        }
        with self.assertRaises(EXPORT.delta.DeltaLedgerError):
            EXPORT._prior_label_selection_ids(
                {"base": {"merge_provenance": {}}, "supplement": inherited},
                supplemental_sample_ids=("supplement",),
            )

    def test_master_projection_allows_only_registry_invalidated_prior_absence(
        self,
    ) -> None:
        active = self._projection_prior("active")
        invalidated = self._projection_prior("invalidated")
        registry = mock.Mock(
            invalidated_parent_ids=frozenset({"invalidated", "unselected"})
        )
        missing = EXPORT._validate_master_projection(
            master_by_sample={"active": self._projection_master(active)},
            prior_by_sample={"active": active, "invalidated": invalidated},
            registry=registry,
            prior_master_manifest_sha256="b" * 64,
            prior_catalog_registry_sha256="a" * 64,
        )
        self.assertEqual(("invalidated",), missing)

        arbitrary = self._projection_prior("arbitrary")
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "differs from registry invalidations",
        ):
            EXPORT._validate_master_projection(
                master_by_sample={"active": self._projection_master(active)},
                prior_by_sample={"active": active, "arbitrary": arbitrary},
                registry=registry,
                prior_master_manifest_sha256="b" * 64,
                prior_catalog_registry_sha256="a" * 64,
            )

    def test_master_projection_rejects_pixel_provenance_split_or_binding_drift(
        self,
    ) -> None:
        prior = self._projection_prior("active")
        registry = mock.Mock(invalidated_parent_ids=frozenset())
        mutations = {
            "pixel": lambda master: master.update(sample_crop_sha256="f" * 64),
            "provenance": lambda master: master.update(
                master_provenance={"approval": "changed"}
            ),
            "split": lambda master: master.update(split="val"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                master = self._projection_master(prior)
                mutate(master)
                with self.assertRaises(EXPORT.ProvisionalFull22ExportError):
                    EXPORT._validate_master_projection(
                        master_by_sample={"active": master},
                        prior_by_sample={"active": prior},
                        registry=registry,
                        prior_master_manifest_sha256="b" * 64,
                        prior_catalog_registry_sha256="a" * 64,
                    )

        wrong_binding = copy.deepcopy(prior)
        wrong_binding["input_bindings"]["master_manifest_sha256"] = "f" * 64
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "escaped its sealed base master/registry",
        ):
            EXPORT._validate_master_projection(
                master_by_sample={"active": self._projection_master(wrong_binding)},
                prior_by_sample={"active": wrong_binding},
                registry=registry,
                prior_master_manifest_sha256="b" * 64,
                prior_catalog_registry_sha256="a" * 64,
            )

    def test_scope_excludes_exceptions_and_training_quarantine(self) -> None:
        included, excluded = EXPORT.select_training_sample_ids(
            selected_ids=("sample-a", "sample-b", "sample-c", "sample-e"),
            source_ids=(
                "sample-a",
                "sample-b",
                "sample-c",
                "sample-d",
                "sample-e",
            ),
            eligibility_exception_ids=("sample-b",),
            training_quarantine_ids=("sample-c", "closure-only"),
            registry_invalidated_prior_ids=("sample-e",),
            authorized_training_quarantine_ids=(
                "sample-a",
                "sample-b",
                "sample-c",
                "sample-d",
                "sample-e",
                "closure-only",
            ),
            split_by_sample={
                "closure-only": "train",
                "sample-a": "train",
                "sample-b": "train",
                "sample-c": "train",
                "sample-d": "val",
                "sample-e": "train",
            },
        )
        self.assertEqual(("sample-a",), included)
        self.assertEqual(("sample-b", "sample-c", "sample-d", "sample-e"), excluded)

    def test_scope_rejects_evaluation_quarantine(self) -> None:
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "training quarantine contains evaluation samples",
        ):
            EXPORT.select_training_sample_ids(
                selected_ids=("sample-a", "sample-b"),
                source_ids=("sample-a", "sample-b"),
                eligibility_exception_ids=(),
                training_quarantine_ids=("sample-b",),
                split_by_sample={"sample-a": "train", "sample-b": "val"},
            )

    def test_staging_mode_keeps_only_exact_independent_consensus(self) -> None:
        def review(*, preferred: str, none: bool = False) -> dict:
            value = judgment(
                preferred=[] if none else [preferred],
                acceptable=[],
                marginal=[preferred] if none else [],
                unacceptable=["new-b"] if preferred != "new-b" else ["new-a"],
            )
            return {
                "confidence": 0.95,
                "eligibility": "font_signal_present",
                "font_judgment": value,
                "role": {"confidence": 0.95, "primary": "dialogue"},
            }

        exact_primary = review(preferred="new-a")
        exact_secondary = copy.deepcopy(exact_primary)
        disagree_secondary = review(preferred="new-b")
        none_primary = review(preferred="new-a", none=True)
        none_secondary = copy.deepcopy(none_primary)
        state = {
            "bindings_by_sample": {
                "exact": {"primary": {}, "secondary": {}},
                "disagree": {"primary": {}, "secondary": {}},
                "none": {"primary": {}, "secondary": {}},
                "primary-only": {"primary": {}},
            }
        }
        stages = {
            "exact": {
                "primary": exact_primary,
                "secondary": exact_secondary,
            },
            "disagree": {
                "primary": exact_primary,
                "secondary": disagree_secondary,
            },
            "none": {"primary": none_primary, "secondary": none_secondary},
            "primary-only": {"primary": exact_primary},
        }

        selected = EXPORT.strict_consensus_sample_ids(
            state=state,
            stages_by_sample=stages,
            validation={"missing_primary_count": 0, "missing_secondary_count": 0},
        )
        self.assertEqual(("exact",), selected)

    def test_staging_mode_waits_for_all_assigned_double_reviews(self) -> None:
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError,
            "waits for every assigned primary/secondary review",
        ):
            EXPORT.strict_consensus_sample_ids(
                state={"bindings_by_sample": {}},
                stages_by_sample={},
                validation={"missing_primary_count": 0, "missing_secondary_count": 1},
            )

    def test_trainer_compatibility_requires_train_and_val(self) -> None:
        EXPORT.require_trainer_splits(
            [{"split": "train"}, {"split": "val"}, {"split": "test"}]
        )
        with self.assertRaisesRegex(
            EXPORT.ProvisionalFull22ExportError, r"missing split\(s\): val"
        ):
            EXPORT.require_trainer_splits([{"split": "train"}])

    def test_load_context_reuses_one_fully_verified_workspace_load(self) -> None:
        class StopAfterWorkspaceValidation(RuntimeError):
            pass

        state = {
            "contract": {
                "mode": "production",
                "v5_derivation_required": True,
            }
        }
        validation = {"complete": False}
        workspace = Path("delta-workspace")
        with (
            mock.patch.object(
                EXPORT.delta, "_load_workspace", return_value=state
            ) as load_workspace,
            mock.patch.object(
                EXPORT.delta,
                "_validate_workspace_state",
                return_value=validation,
            ) as validate_state,
            mock.patch.object(
                EXPORT.delta,
                "validate_workspace",
                side_effect=AssertionError("path wrapper would reload the workspace"),
            ) as validate_path,
            mock.patch.object(
                EXPORT.delta,
                "_validate_review_records",
                return_value=({}, {}),
            ) as validate_reviews,
            mock.patch.object(
                EXPORT,
                "_validate_rescue_binding",
                side_effect=StopAfterWorkspaceValidation,
            ),
            self.assertRaises(StopAfterWorkspaceValidation),
        ):
            EXPORT.load_context(
                master_manifest=Path("master.jsonl"),
                catalog_registry=Path("catalog.json"),
                rescue_inputs=Path("rescue-inputs"),
                delta_workspace=workspace,
                prior_training_export_dir=Path("prior-export"),
                render_bank_manifest=Path("render-bank.json"),
                resolver="single-load-test",
                allow_unfinalized_strict_consensus=True,
            )

        load_workspace.assert_called_once_with(workspace)
        validate_state.assert_called_once_with(state, require_complete=False)
        validate_reviews.assert_called_once_with(state)
        validate_path.assert_not_called()


if __name__ == "__main__":
    unittest.main()
