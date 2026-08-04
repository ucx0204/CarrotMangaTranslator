from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "font_matching_calibration_preflight_v5.py"
SPEC = importlib.util.spec_from_file_location(
    "font_matching_calibration_preflight_v5", SCRIPT
)
assert SPEC and SPEC.loader
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class FakeExternal:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.inputs = root / "inputs"
        self.inputs.mkdir()
        self.rescue = self.inputs / "rescue"
        self.audit = self.inputs / "audit"
        self.primary_root = self.inputs / "primary-split"
        self.secondary_root = self.inputs / "secondary-split"
        for path in (
            self.rescue,
            self.audit,
            self.primary_root,
            self.secondary_root,
        ):
            path.mkdir()
        self.rubric = self.inputs / "font-matching-v2-review-rubric-v5.md"
        self.rubric.write_text("sealed v5 rubric\n", encoding="utf-8")
        self.master_split_map = self.inputs / "master-split-map.json"
        self.master_split_map.write_text("{}\n", encoding="utf-8")
        self.priors = []
        for index in range(3):
            path = self.inputs / f"prior-{index + 1}.json"
            path.write_text(f"prior {index + 1}\n", encoding="utf-8")
            self.priors.append(path)
        anchor = self.inputs / "source-anchor.json"
        anchor.write_text("{}\n", encoding="utf-8")
        self.anchor_binding = PREFLIGHT._file_binding(anchor)
        self.pool: list[dict[str, object]] = []
        self.primary: dict[str, dict[str, object]] = {}
        self.secondary: dict[str, dict[str, object]] = {}
        self.master: dict[str, dict[str, object]] = {}
        self.split_by_sample: dict[str, str] = {}
        ordinal = 0
        # Extra capacity in every stratum permits deterministic replenishment.
        for stratum, target in PREFLIGHT.INITIAL_TARGETS.items():
            for local_index in range(target + 6):
                sample_id = f"sample-{ordinal:04d}"
                work_id = f"work-{ordinal % 15:02d}"
                chapter_id = f"chapter-{ordinal:04d}"
                role = {
                    "ordinary_body": "dialogue",
                    "aside_whisper_handwritten": "aside_balloon_edge",
                    "emphasis_shout": "shout",
                }.get(stratum, stratum)
                conflict = f"lineage\0{sample_id}"
                self.pool.append(
                    {
                        "sample_id": sample_id,
                        "stratum": stratum,
                        "role": role,
                        "work_id": work_id,
                        "chapter_id": chapter_id,
                        "page_key": f"page\0{sample_id}",
                        "conflict_keys": frozenset({conflict}),
                        "priority_rank": ordinal % 2,
                        "orientation": "vertical" if ordinal % 2 else "horizontal",
                        "style_cluster": f"{stratum}|{ordinal % 7}",
                    }
                )
                self.master[sample_id] = {
                    "sample_crop_sha256": f"crop-{sample_id}",
                    "groups": {
                        "root": f"root-{sample_id}",
                        "variant": f"variant-{sample_id}",
                        "normalized_glyph": f"glyph-{sample_id}",
                    },
                    "page": {
                        "id": f"page-{sample_id}",
                        "source_page_sha256": f"page-sha-{sample_id}",
                    },
                    "provenance": {
                        "source_id": f"source-{sample_id}",
                        "source_lineage": [{"id": f"lineage-{sample_id}"}],
                    },
                }
                self.split_by_sample[sample_id] = "train"
                self.primary[sample_id] = self._card(sample_id, "primary")
                self.secondary[sample_id] = self._card(sample_id, "secondary")
                ordinal += 1

    def _card(self, sample_id: str, stage: str) -> dict[str, object]:
        root = self.primary_root if stage == "primary" else self.secondary_root
        source_path = root / f"source-{sample_id}.png"
        candidate_path = root / f"candidate-{sample_id}.png"
        source_path.write_bytes(f"A:{stage}:{sample_id}".encode())
        candidate_path.write_bytes(f"B:{stage}:{sample_id}".encode())
        return {
            "assignment_id": f"assignment-{stage}-{sample_id}",
            "source_only": {
                "path": str(source_path),
                "sha256": PREFLIGHT.sha256_file(source_path),
                "pixel_sha256": "a" * 64,
                "size_px": [24, 14],
            },
            "candidate_only": {
                "path": str(candidate_path),
                "sha256": PREFLIGHT.sha256_file(candidate_path),
                "pixel_sha256": "b" * 64,
                "size_px": [24, 44],
            },
        }

    def snapshot(self, **_: object) -> dict[str, object]:
        prior_bindings = [PREFLIGHT._file_binding(path) for path in self.priors]
        split_bindings = {
            "primary": {
                "root": str(self.primary_root),
                "manifest": self.anchor_binding,
                "marker": self.anchor_binding,
                "stage": "primary",
                "card_count": len(self.primary),
            },
            "secondary": {
                "root": str(self.secondary_root),
                "manifest": self.anchor_binding,
                "marker": self.anchor_binding,
                "stage": "secondary",
                "card_count": len(self.secondary),
            },
        }
        snapshot: dict[str, object] = {
            "source": {
                "master": self.master,
                "selection": {sample_id: {} for sample_id in self.master},
                "inventory": set(self.master),
                "split_by_sample": self.split_by_sample,
            },
            "prior": {
                "bindings": prior_bindings,
                "excluded_sample_ids": ["prior-calibration-sample"],
                "training_quarantine_sample_ids": ["prior-quarantine-sample"],
                "declared_training_quarantine_sample_ids": ["prior-quarantine-sample"],
                "canonical_non_train_declared_quarantine_sample_ids": [],
                "canonical_non_train_selected_sample_ids": [],
                "canonical_non_train_excluded_sample_ids": [],
                "round_output_disposition": (
                    "permanently_discarded_not_calibration_or_training_evidence"
                ),
            },
            "pool": self.pool,
            "primary": self.primary,
            "secondary": self.secondary,
            "source_file_bindings": {"anchor": self.anchor_binding},
            "source_record_bindings": {
                "rescue_report": "c" * 64,
                "font_signal_audit_report": "d" * 64,
            },
            "split_bindings": split_bindings,
            "canonical_split": {
                "file_binding": PREFLIGHT._file_binding(self.master_split_map),
                "work_assignments": {
                    f"work-{index:02d}": "train" for index in range(15)
                },
                "source_work_ids": [f"work-{index:02d}" for index in range(15)],
                "source_work_assignment_counts": {"train": 15},
                "legacy_path_mismatch_count": 0,
                "legacy_path_mismatch_sample_ids_sha256": PREFLIGHT.sha256_bytes(
                    PREFLIGHT.canonical_json_bytes([])
                ),
            },
            "forbidden_tokens": {
                "ko-candidate-deadbeefdeadbeef",
                "black-han-sans",
            },
        }
        snapshot["pool_fingerprint"] = PREFLIGHT._pool_fingerprint(self.pool)
        return snapshot


class CalibrationPreflightV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fixture = FakeExternal(self.root)
        self.workspace = self.root / "workspace"
        self.external_patch = mock.patch.object(
            PREFLIGHT, "_load_external", side_effect=self.fixture.snapshot
        )
        self.external_patch.start()

    def tearDown(self) -> None:
        self.external_patch.stop()
        self.temporary.cleanup()

    def _initialize(self) -> dict[str, object]:
        return PREFLIGHT.initialize_workspace(
            workspace=self.workspace,
            rescue_inputs=self.fixture.rescue,
            font_signal_audit=self.fixture.audit,
            master_split_map=self.fixture.master_split_map,
            prior_calibration_subsets=self.fixture.priors,
            primary_split_root=self.fixture.primary_root,
            secondary_split_root=self.fixture.secondary_root,
            rubric=self.fixture.rubric,
            round_id="round-v5-004",
            selection_seed="sealed-test-seed",
        )

    def _decisions(
        self,
        draw_id: str,
        stage: str,
        *,
        rejected_sample_ids: set[str] | None = None,
    ) -> Path:
        rejected = rejected_sample_ids or set()
        private = PREFLIGHT.read_jsonl(
            self.workspace / "draws" / draw_id / "private-bindings.jsonl"
        )
        sample_by_task = {row["task_ids"][stage]: row["sample_id"] for row in private}
        tasks = PREFLIGHT.read_jsonl(
            self.workspace / "draws" / draw_id / f"tasks-{stage}.jsonl"
        )
        rows = []
        for task in tasks:
            passed = sample_by_task[task["task_id"]] not in rejected
            rows.append(
                {
                    "task_id": task["task_id"],
                    "complete_text_object": passed,
                    "single_skeleton": True,
                    "clean_glyph_isolation": True,
                    "role_context_sufficient": True,
                    "confidence": 0.95,
                    "evidence_note": (
                        "object boundary incomplete"
                        if not passed
                        else "all checks supported"
                    ),
                }
            )
        path = self.root / f"input-{draw_id}-{stage}.jsonl"
        path.write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )
        return path

    def _submit_both(
        self, draw_id: str, *, rejected_sample_ids: set[str] | None = None
    ) -> None:
        for stage, reviewer in (
            ("reviewer-a", "human-alpha"),
            ("reviewer-b", "human-beta"),
        ):
            PREFLIGHT.submit_reviews(
                workspace=self.workspace,
                draw_id=draw_id,
                reviewer_stage=stage,
                reviewer_id=reviewer,
                decisions=self._decisions(
                    draw_id, stage, rejected_sample_ids=rejected_sample_ids
                ),
            )

    def test_initial_draw_has_exact_72_quotas_and_no_public_leaks(self) -> None:
        self.assertEqual(
            "1167efc3a95573167771382bc4b6db27408b83d1fa0fa36e2a36021ee858a91c",
            PREFLIGHT.FROZEN_SPLIT_CONTRACTS["primary"]["record_sha256"],
        )
        self.assertEqual(
            "e80a51e6253b53ac757d29a0cc879374560cac5f281c5bcfb85aec8fe5b3457e",
            PREFLIGHT.FROZEN_SPLIT_CONTRACTS["secondary"]["record_sha256"],
        )
        report = self._initialize()
        self.assertEqual(PREFLIGHT.INITIAL_COUNT, report["initial_samples"])
        bindings = PREFLIGHT.read_jsonl(
            self.workspace / "draws" / "000-initial" / "private-bindings.jsonl"
        )
        self.assertEqual(
            Counter(PREFLIGHT.INITIAL_TARGETS),
            Counter(row["stratum"] for row in bindings),
        )
        work_counts = Counter(row["work_id"] for row in bindings)
        self.assertEqual(15, len(work_counts))
        self.assertGreaterEqual(min(work_counts.values()), 3)
        self.assertLessEqual(max(work_counts.values()), 5)
        self.assertEqual(PREFLIGHT.INITIAL_COUNT, sum(work_counts.values()))
        manifest = PREFLIGHT.read_json(
            self.workspace / "draws" / "000-initial" / "manifest.json"
        )
        self.assertEqual(5, manifest["selection_audit"]["maximum_samples_per_work"])
        self.assertTrue(manifest["selection_audit"]["milp_proof_required"])
        self.assertFalse(manifest["selection_audit"]["exact_solver"]["fail_closed"])
        for stage in PREFLIGHT.REVIEWER_STAGES:
            tasks_path = (
                self.workspace / "draws" / "000-initial" / f"tasks-{stage}.jsonl"
            )
            text = tasks_path.read_text(encoding="utf-8").casefold()
            for forbidden in (
                "candidate_only",
                "full_card",
                "ko-candidate-",
                "stratum",
                "role_private",
                "sample_id",
                "work_id",
                "assignment_id",
                "font_name",
                "prior_tier",
                "translation",
            ):
                self.assertNotIn(forbidden, text)
            tasks = PREFLIGHT.read_jsonl(tasks_path)
            self.assertEqual(PREFLIGHT.INITIAL_COUNT, len(tasks))
            self.assertTrue(
                all(task["check_ids"] == list(PREFLIGHT.CHECK_IDS) for task in tasks)
            )

    def test_reviewer_independence_and_alias_leak_rejection(self) -> None:
        self._initialize()
        first = self._decisions("000-initial", "reviewer-a")
        PREFLIGHT.submit_reviews(
            workspace=self.workspace,
            draw_id="000-initial",
            reviewer_stage="reviewer-a",
            reviewer_id="same-human",
            decisions=first,
        )
        second = self._decisions("000-initial", "reviewer-b")
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "must differ"):
            PREFLIGHT.submit_reviews(
                workspace=self.workspace,
                draw_id="000-initial",
                reviewer_stage="reviewer-b",
                reviewer_id="same-human",
                decisions=second,
            )
        rows = [json.loads(line) for line in second.read_text().splitlines()]
        rows[0]["evidence_note"] = "ko-candidate-deadbeefdeadbeef looks usable"
        second.write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "alias"):
            PREFLIGHT.submit_reviews(
                workspace=self.workspace,
                draw_id="000-initial",
                reviewer_stage="reviewer-b",
                reviewer_id="different-human",
                decisions=second,
            )
        rows[0]["evidence_note"] = "dialogue"
        second.write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "role, tier"):
            PREFLIGHT.submit_reviews(
                workspace=self.workspace,
                draw_id="000-initial",
                reviewer_stage="reviewer-b",
                reviewer_id="different-human",
                decisions=second,
            )

    def test_rejects_request_same_stratum_extension_then_exact_60(self) -> None:
        self._initialize()
        private = PREFLIGHT.read_jsonl(
            self.workspace / "draws" / "000-initial" / "private-bindings.jsonl"
        )
        rejected = {
            row["sample_id"] for row in private if row["stratum"] == "ordinary_body"
        }
        rejected = set(sorted(rejected)[:3])
        self._submit_both("000-initial", rejected_sample_ids=rejected)
        first = PREFLIGHT.finalize_workspace(workspace=self.workspace)
        self.assertEqual("replacement_required", first["status"])
        self.assertEqual(
            1, first["requested_fresh_same_stratum_counts"]["ordinary_body"]
        )
        request = PREFLIGHT.read_json(
            self.workspace / "replacement-requests" / "000.json"
        )
        self.assertFalse(request["individual_reviewer_answers_present"])
        self.assertNotIn("sample_ids", request)
        extension = PREFLIGHT.extend_workspace(workspace=self.workspace)
        self.assertEqual("001-extension", extension["draw_id"])
        self.assertEqual({"ordinary_body": 1}, extension["requested_quotas"])
        self._submit_both("001-extension")
        final = PREFLIGHT.finalize_workspace(workspace=self.workspace)
        self.assertEqual("complete", final["status"])
        rows = PREFLIGHT.read_jsonl(
            self.workspace / "final" / "scored-sample-ids.jsonl"
        )
        self.assertEqual(PREFLIGHT.SCORED_COUNT, len(rows))
        self.assertEqual(
            Counter(PREFLIGHT.SCORED_TARGETS),
            Counter(row["private_stratum"] for row in rows),
        )
        closure = PREFLIGHT.read_json(
            self.workspace / "final" / "training-quarantine-closure.json"
        )
        self.assertFalse(closure["test_samples_present"])
        self.assertIn(
            "prior-quarantine-sample",
            closure["cumulative_training_quarantine_sample_ids"],
        )
        self.assertTrue(
            PREFLIGHT.validate_workspace(workspace=self.workspace)["finalized"]
        )

    def test_tamper_and_unsafe_workspace_fail_closed(self) -> None:
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "inside input root"):
            PREFLIGHT.initialize_workspace(
                workspace=self.fixture.primary_root / "unsafe-workspace",
                rescue_inputs=self.fixture.rescue,
                font_signal_audit=self.fixture.audit,
                master_split_map=self.fixture.master_split_map,
                prior_calibration_subsets=self.fixture.priors,
                primary_split_root=self.fixture.primary_root,
                secondary_split_root=self.fixture.secondary_root,
                rubric=self.fixture.rubric,
                round_id="round-v5-unsafe",
                selection_seed="seed",
            )
        self._initialize()
        task = PREFLIGHT.read_jsonl(
            self.workspace / "draws" / "000-initial" / "tasks-reviewer-a.jsonl"
        )[0]
        card = self.workspace / Path(*Path(task["source_only"]["path"]).parts)
        card.write_bytes(card.read_bytes() + b"tamper")
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "managed files changed"):
            PREFLIGHT.validate_workspace(workspace=self.workspace)

    def test_selector_excludes_prior_ids_and_lineage_conflicts(self) -> None:
        rows = [
            {
                **self.fixture.pool[0],
                "sample_id": "prior-sample",
                "stratum": "ordinary_body",
                "conflict_keys": frozenset({"prior-lineage"}),
            },
            {
                **self.fixture.pool[1],
                "sample_id": "test-lineage-sibling",
                "stratum": "ordinary_body",
                "conflict_keys": frozenset({"test-lineage"}),
            },
            {
                **self.fixture.pool[2],
                "sample_id": "fresh-sample",
                "stratum": "ordinary_body",
                "conflict_keys": frozenset({"fresh-lineage"}),
            },
        ]
        selected, _ = PREFLIGHT._select_exact(
            rows,
            targets={"ordinary_body": 1},
            seed="exclusion-test",
            forbidden_sample_ids={"prior-sample"},
            fixed_conflict_keys={"test-lineage"},
            enforce_third_branch=False,
        )
        assert selected is not None
        self.assertEqual(["fresh-sample"], [row["sample_id"] for row in selected])

    def test_training_quarantine_allows_only_sealed_manual_recrop_master_gap(self) -> None:
        sealed_key = "page.id\0sealed-recrop-page"
        train_row = {
            "page": {
                "id": "sealed-recrop-page",
                "source_page_sha256": "train-page-sha",
            }
        }
        source = {
            "master": {"train-lineage-sibling": train_row},
            "split_by_sample": {"train-lineage-sibling": "train"},
        }
        state = {
            "external": {
                "source": source,
                "prior": {"training_quarantine_sample_ids": ["prior-quarantine"]},
                "_sealed_manual_recrop_conflict_keys": {
                    "sealed-manual-recrop": frozenset({sealed_key})
                },
            }
        }
        current, cumulative = PREFLIGHT._training_quarantine(
            state, {"sealed-manual-recrop"}
        )
        self.assertEqual(["train-lineage-sibling"], current)
        self.assertEqual(
            ["prior-quarantine", "train-lineage-sibling"], cumulative
        )

        state["external"]["_sealed_existing_master_projection_gaps"] = {
            "sealed-existing-master": {
                "conflict_keys": frozenset({sealed_key}),
                "master_record_sha256": "a" * 64,
            }
        }
        current, cumulative = PREFLIGHT._training_quarantine(
            state, {"sealed-existing-master"}
        )
        self.assertEqual(
            ["sealed-existing-master", "train-lineage-sibling"], current
        )
        self.assertEqual(
            [
                "prior-quarantine",
                "sealed-existing-master",
                "train-lineage-sibling",
            ],
            cumulative,
        )

        with self.assertRaisesRegex(
            PREFLIGHT.PreflightError, "outside the sealed manual-recrop path"
        ):
            PREFLIGHT._training_quarantine(state, {"unbound-master-gap"})

        source["master"]["test-lineage-sibling"] = copy.deepcopy(train_row)
        source["split_by_sample"]["test-lineage-sibling"] = "test"
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "test samples"):
            PREFLIGHT._training_quarantine(state, {"sealed-manual-recrop"})

    def test_projection_gap_resolves_only_from_bound_sealed_master_v3(self) -> None:
        master_row = PREFLIGHT.seal(
            {"id": "sealed-existing-master", "split": "train"}
        )
        manifest = self.root / "master-v3.jsonl"
        manifest.write_text(
            json.dumps(master_row, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        external = {
            "authority_successor_bridge": {
                "successor_master_manifest": PREFLIGHT._file_binding(manifest)
            }
        }
        resolved = PREFLIGHT._authoritative_projection_gap_master_rows(
            external, {"sealed-existing-master"}
        )
        self.assertEqual(master_row, resolved["sealed-existing-master"]["row"])
        self.assertEqual(
            PREFLIGHT.sha256_bytes(PREFLIGHT.canonical_json_bytes(master_row)),
            resolved["sealed-existing-master"]["record_sha256"],
        )
        with self.assertRaisesRegex(
            PREFLIGHT.PreflightError, "absent from the bound successor master"
        ):
            PREFLIGHT._authoritative_projection_gap_master_rows(
                external, {"not-in-master-v3"}
            )

    def test_feasibility_report_is_sealed_and_never_relaxes_shortfall(self) -> None:
        external = self.fixture.snapshot()
        external["pool"] = [
            row for row in external["pool"] if row["stratum"] != "sfx_ambient"
        ]
        external["pool_fingerprint"] = PREFLIGHT._pool_fingerprint(external["pool"])
        report = PREFLIGHT._feasibility_report(external, selection_seed="capacity-test")
        PREFLIGHT.validate_seal(report, "feasibility")
        self.assertFalse(report["feasible"])
        self.assertEqual(
            PREFLIGHT.INITIAL_TARGETS["sfx_ambient"],
            report["hard_capacity_shortfall_by_stratum"]["sfx_ambient"],
        )
        self.assertFalse(
            report["minimum_source_extension_contract"][
                "quota_relaxation_or_quarantine_reuse_allowed"
            ]
        )
        self.assertIsNone(report["smallest_feasible_balanced_cap"])
        self.assertEqual(
            0,
            report["minimum_source_extension_contract"][
                "balanced_existing_work_strategy"
            ]["new_work_ids_required_by_policy"],
        )
        self.assertTrue(
            report["minimum_source_extension_contract"][
                "alternative_legacy_max3_scenario_only"
            ]["not_the_default_policy"]
        )

    def test_balanced_selector_proves_cap_five_then_sealed_cap_six_fallback(
        self,
    ) -> None:
        external = self.fixture.snapshot()
        ordinary = [
            row for row in external["pool"] if row["stratum"] == "ordinary_body"
        ]
        kept_ids = {row["sample_id"] for row in ordinary[:10]}
        for index, row in enumerate(ordinary[:10]):
            # The exact ordinary quota forces six rows from work-00.  Cap five
            # is therefore impossible, while cap six remains balanced because
            # every canonical train work must still contribute at least three.
            row["work_id"] = "work-00" if index < 6 else "work-01"
        external["pool"] = [
            row
            for row in external["pool"]
            if row["stratum"] != "ordinary_body" or row["sample_id"] in kept_ids
        ]
        external["pool_fingerprint"] = PREFLIGHT._pool_fingerprint(external["pool"])

        selected, audit, trials = PREFLIGHT._balanced_initial_selection(
            external, selection_seed="cap-fallback-test"
        )
        assert selected is not None
        self.assertEqual(
            [5, 6], [trial["maximum_samples_per_work"] for trial in trials]
        )
        self.assertEqual([False, True], [trial["feasible"] for trial in trials])
        self.assertTrue(trials[0]["selection_audit"]["exact_solver"]["fail_closed"])
        self.assertFalse(audit["exact_solver"]["fail_closed"])
        counts = Counter(str(row["work_id"]) for row in selected)
        self.assertEqual(15, len(counts))
        self.assertGreaterEqual(min(counts.values()), 3)
        self.assertEqual(6, max(counts.values()))

    def test_canonical_split_map_blocks_legacy_train_path_for_test_only_work(
        self,
    ) -> None:
        split_map = self.root / "canonical-split-map.json"
        document = {
            "schema_version": 1,
            "work_assignments": {
                "work-train": "train",
                "work-test-only": "test",
            },
        }
        split_map.write_text(json.dumps(document), encoding="utf-8")
        source = {
            "source_report": {
                "inputs": {"master_split_map_sha256": PREFLIGHT.sha256_file(split_map)}
            },
            "selection": {
                "sample-train": {"work_id": "work-train"},
                "sample-test-only": {"work_id": "work-test-only"},
            },
            # Regression: legacy asset paths falsely called both samples train.
            "split_by_sample": {
                "sample-train": "train",
                "sample-test-only": "train",
            },
        }
        contract = PREFLIGHT._canonical_master_split_contract(split_map, source)
        self.assertEqual("test", contract["canonical_by_sample"]["sample-test-only"])
        self.assertEqual(1, contract["legacy_path_mismatch_count"])
        canonical_train_works = {
            work_id
            for work_id, split_name in contract["work_assignments"].items()
            if split_name == "train"
        }
        self.assertNotIn("work-test-only", canonical_train_works)

        # The public pool must consume the canonical projection, not the stale
        # path-derived value.  Both cards deliberately exist so card presence
        # cannot accidentally make the test-only work eligible.
        source["inventory"] = {"sample-train", "sample-test-only"}
        source["split_by_sample"] = dict(contract["canonical_by_sample"])
        cards = {"sample-train": {}, "sample-test-only": {}}
        with (
            mock.patch.object(
                PREFLIGHT.delta,
                "_calibration_leakage_closure",
                side_effect=lambda _source, sample_ids: set(sample_ids),
            ),
            mock.patch.object(
                PREFLIGHT,
                "_preflight_candidate",
                side_effect=lambda _source, sample_id: {"sample_id": sample_id},
            ) as candidate_builder,
        ):
            pool = PREFLIGHT._fresh_candidate_pool(
                source,
                excluded_sample_ids=frozenset(),
                primary=cards,
                secondary=cards,
            )
        self.assertEqual([{"sample_id": "sample-train"}], pool)
        candidate_builder.assert_called_once_with(source, "sample-train")

    def test_only_revalidated_sealed_intake_merges_exact_eight_as_competitors(
        self,
    ) -> None:
        external = self.fixture.snapshot()
        assignments = external["canonical_split"]["work_assignments"]
        identity = {
            "frozen_source_sha256": "e" * 64,
            "work_assignments_sha256": PREFLIGHT.sha256_bytes(
                PREFLIGHT.canonical_json_bytes(assignments)
            ),
        }
        external["canonical_split"]["authoritative_identity"] = identity
        master_sha = "f" * 64
        external["source"].update(
            {
                "source_report": {"inputs": {"master_manifest_sha256": master_sha}},
                "source_report_record_sha256": "c" * 64,
                "audit_report_record_sha256": "d" * 64,
            }
        )
        rows = []
        for index in range(8):
            sample_id = f"sealed-intake-{index}"
            page_id = "shared-page" if index < 2 else f"intake-page-{index}"
            page_sha = "1" * 64 if index < 2 else f"{index + 1:x}" * 64
            stratum = "sfx_ambient" if index < 5 else "sfx_comic"
            rows.append(
                {
                    "sample_id": sample_id,
                    "kind": "manual_recrop",
                    "work_id": f"work-{index:02d}",
                    "chapter_id": f"intake-chapter-{index}",
                    "page_id": page_id,
                    "source_page_sha256": page_sha,
                    "orientation": "horizontal",
                    "role": stratum,
                    "stratum": stratum,
                    "source_status": "dual_independent_pass",
                    "all_four_checks_passed_twice": True,
                    "reviewers_independent": True,
                    "candidate_b_present": False,
                    "font_identity_present": False,
                    "synthetic": False,
                    "qa_overlay": False,
                    "authoritative_split_identity": identity,
                    "closure": {
                        "exact": [f"crop_sha256\0{sample_id}"],
                        "page": [
                            f"page.id\0{page_id}",
                            f"page.source_page_sha256\0{page_sha}",
                        ],
                        "root": [f"groups.root\0{sample_id}"],
                        "variant": [f"groups.variant\0{sample_id}"],
                        "glyph": [f"groups.normalized_glyph\0{sample_id}"],
                        "source": [f"provenance.source_id\0{sample_id}"],
                        "lineage": [f"provenance.lineage_id\0{sample_id}"],
                    },
                }
            )
        binding = {
            "authoritative_split_identity": identity,
            "rescue_report_record_sha256": "c" * 64,
            "font_signal_audit_report_record_sha256": "d" * 64,
            "master_manifest_sha256": master_sha,
            "prior_subset_bindings_sha256": PREFLIGHT.sha256_bytes(
                PREFLIGHT.canonical_json_bytes(external["prior"]["bindings"])
            ),
            "authority_successor_bridge_record_sha256": None,
            "authority_successor_ids_auto_inherited": False,
        }
        report = {
            "record_sha256": "a" * 64,
            "test_or_val_count": 0,
            "prior_leakage_count": 0,
            "candidate_b_count": 0,
            "font_identity_count": 0,
            "synthetic_generative_qa_count": 0,
        }
        initial_count = len(external["pool"])
        source_stage_bindings = {
            row["sample_id"]: {
                stage: {
                    "assignment_id": f"intake-{stage}-{row['sample_id']}",
                    "source_only": {
                        "path": f"unused-{stage}-{row['sample_id']}.png",
                        "sha256": "1" * 64,
                        "pixel_sha256": "2" * 64,
                        "size_px": [680, 224],
                    },
                    "candidate_only": {
                        "candidate_b_present": False,
                        "status": "not_materialized_before_source_preflight",
                    },
                }
                for stage in ("primary", "secondary")
            }
            for row in rows
        }
        with mock.patch.object(
            PREFLIGHT.intake_v5,
            "validate_sealed_intake",
            return_value={
                "binding": binding,
                "report": report,
                "rows": rows,
                "source_stage_bindings": source_stage_bindings,
            },
        ) as validator:
            PREFLIGHT._merge_sealed_intake(
                external, sealed_intake_root=self.root / "owned-intake"
            )
        validator.assert_called_once_with(self.root / "owned-intake")
        self.assertEqual(initial_count + 8, len(external["pool"]))
        self.assertEqual(8, external["sealed_intake"]["count"])
        merged = {
            row["sample_id"]: row
            for row in external["pool"]
            if str(row["sample_id"]).startswith("sealed-intake-")
        }
        first = merged["sealed-intake-0"]
        second = merged["sealed-intake-1"]
        self.assertFalse(
            PREFLIGHT._can_select(
                second,
                selected_by_work={str(first["work_id"]): [first]},
                used_conflict_keys=set(first["conflict_keys"]),
                maximum_per_work=5,
                enforce_third_branch=False,
            )
        )

        second_rows = []
        for index, row in enumerate(rows):
            value = copy.deepcopy(row)
            value["sample_id"] = f"sealed-intake-second-{index}"
            value["page_id"] = f"second-page-{index}"
            value["source_page_sha256"] = f"{(index + 9) % 16:x}" * 64
            value["closure"] = {
                name: [f"second-{item}" for item in members]
                for name, members in value["closure"].items()
            }
            second_rows.append(value)
        second_stage_bindings = {
            row["sample_id"]: {
                stage: {
                    "assignment_id": f"second-{stage}-{row['sample_id']}",
                    "source_only": {
                        "path": f"unused-second-{stage}-{row['sample_id']}.png",
                        "sha256": "3" * 64,
                        "pixel_sha256": "4" * 64,
                        "size_px": [680, 224],
                    },
                    "candidate_only": {
                        "candidate_b_present": False,
                        "status": "not_materialized_before_source_preflight",
                    },
                }
                for stage in ("primary", "secondary")
            }
            for row in second_rows
        }
        second_report = {**report, "record_sha256": "b" * 64}
        with mock.patch.object(
            PREFLIGHT.intake_v5,
            "validate_sealed_intake",
            return_value={
                "binding": binding,
                "report": second_report,
                "rows": second_rows,
                "source_stage_bindings": second_stage_bindings,
            },
        ):
            PREFLIGHT._merge_sealed_intake(
                external, sealed_intake_root=self.root / "owned-intake-second"
            )
        self.assertEqual(initial_count + 16, len(external["pool"]))
        self.assertEqual(16, external["sealed_intake"]["count"])
        self.assertEqual(2, len(external["sealed_intake"]["intakes"]))
        self.assertEqual(
            {"sfx_ambient": 10, "sfx_comic": 6},
            external["sealed_intake"]["stratum_counts"],
        )

    def test_sealed_intake_root_list_rejects_duplicates(self) -> None:
        root = self.root / "owned-intake"
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "must be unique"):
            PREFLIGHT._sealed_intake_roots([root, root])

    def test_arbitrary_supplemental_json_is_not_an_intake_authority(self) -> None:
        external = self.fixture.snapshot()
        arbitrary = self.root / "supplemental.json"
        arbitrary.write_text('{"rows":[]}\n', encoding="utf-8")
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "invalid sealed intake"):
            PREFLIGHT._merge_sealed_intake(external, sealed_intake_root=arbitrary)

    def test_authority_excluded_parent_cannot_reenter_v4_pool(self) -> None:
        bridge = {"excluded_parent_ids": ["parent-a"], "successor_ids": []}
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "parent re-entered"):
            PREFLIGHT._validate_authority_pool_exclusions(
                [{"sample_id": "parent-a"}], bridge
            )

    def test_promotion_successor_cannot_be_auto_inherited_into_v4_pool(self) -> None:
        bridge = {"excluded_parent_ids": [], "successor_ids": ["successor-a"]}
        with self.assertRaisesRegex(PREFLIGHT.PreflightError, "auto-inherited"):
            PREFLIGHT._validate_authority_pool_exclusions(
                [{"sample_id": "successor-a"}], bridge
            )


if __name__ == "__main__":
    unittest.main()
