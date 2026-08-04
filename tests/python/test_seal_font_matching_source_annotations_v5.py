from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DERIVE_SCRIPT = ROOT / "scripts" / "derive_font_matching_delta_decisions.py"
SEAL_SCRIPT = ROOT / "scripts" / "seal_font_matching_source_annotations_v5.py"

DERIVE_SPEC = importlib.util.spec_from_file_location(
    "derive_font_matching_delta_decisions_for_source_seal_test", DERIVE_SCRIPT
)
assert DERIVE_SPEC and DERIVE_SPEC.loader
DERIVE = importlib.util.module_from_spec(DERIVE_SPEC)
DERIVE_SPEC.loader.exec_module(DERIVE)

SEAL_SPEC = importlib.util.spec_from_file_location(
    "seal_font_matching_source_annotations_v5_for_test", SEAL_SCRIPT
)
assert SEAL_SPEC and SEAL_SPEC.loader
SEAL = importlib.util.module_from_spec(SEAL_SPEC)
SEAL_SPEC.loader.exec_module(SEAL)


def _sha(value: str) -> str:
    return DERIVE.sha256_bytes(value.encode("utf-8"))


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_bytes(DERIVE.jsonl_bytes(rows))


def _source_task(
    *,
    public_assignment_id: str,
    public_sample_id: str,
    stage: str,
    review_order: int,
    source_sha: str,
) -> dict:
    return DERIVE.seal_record(
        {
            "schema_version": DERIVE.SOURCE_TASK_SCHEMA_VERSION,
            "record_type": DERIVE.SOURCE_TASK_RECORD_TYPE,
            "assignment_id": public_assignment_id,
            "sample_id": public_sample_id,
            "stage": stage,
            "review_order": review_order,
            "source_only_card_sha256": source_sha,
            "review_surface": dict(DERIVE.SOURCE_REVIEW_SURFACE),
        }
    )


def _private_binding(
    *,
    private_assignment_id: str,
    private_sample_id: str,
    public_assignment_id: str,
    public_sample_id: str,
    stage: str,
    review_order: int,
    source_sha: str,
    source_file: Path,
    work_id: str,
) -> dict:
    source_page_sha = _sha(f"page:{private_sample_id}")
    return DERIVE.seal_record(
        {
            "schema_version": SEAL.PRIVATE_BINDING_SCHEMA_VERSION,
            "record_type": SEAL.PRIVATE_BINDING_RECORD_TYPE,
            "assignment": {
                "assignment_id": private_assignment_id,
                "review_order": review_order,
                "sample_id": private_sample_id,
                "source_page_sha256": source_page_sha,
                "stage": stage,
                "work_id": work_id,
            },
            "card": {
                "assignment_id": private_assignment_id,
                "review_card_file": str(source_file),
                "review_card_sha256": source_sha,
                "sample_id": private_sample_id,
                "stage": stage,
                "v5_public_ids": {
                    "assignment_id": public_assignment_id,
                    "sample_id": public_sample_id,
                },
                "v5_source_card": {
                    "file": str(source_file),
                    "pixel_sha256": _sha(f"pixels:{private_assignment_id}"),
                    "sha256": source_sha,
                    "size_px": [2400, 1200],
                },
            },
            "prior_final_record_sha256": _sha(
                f"prior:{private_assignment_id}"
            ),
            "sample_id": private_sample_id,
            "selection_record_sha256": _sha(
                f"selection:{private_assignment_id}"
            ),
            "source_page_sha256": source_page_sha,
            "visibility": SEAL.PRIVATE_BINDING_VISIBILITY,
            # This canary resembles a private font identity.  It is valid
            # private metadata but must never be projected into A annotations.
            "work_id": work_id,
        }
    )


def _neutral_annotation(
    *,
    private_assignment_id: str,
    private_sample_id: str,
    stage: str,
    visual_review_index: int,
    stale_source_sha: str,
) -> dict:
    return {
        "schema_version": SEAL.NEUTRAL_SCHEMA_VERSION,
        "record_type": SEAL.NEUTRAL_RECORD_TYPE,
        "assignment_id": private_assignment_id,
        "sample_id": private_sample_id,
        "stage": stage,
        "source_only_card_sha256": stale_source_sha,
        "eligibility_evidence": {
            "complete_text_object": True,
            "single_source_skeleton": True,
            "clean_glyph_isolation": True,
            "role_context_sufficient": True,
            "font_signal_skeleton_present": True,
            "crop_issue": "none",
        },
        "role_evidence": {
            "label": False,
            "sfx_event": "none",
            "comic_timing": False,
            "external_utterance": True,
            "independent_aside": False,
            "same_utterance_contrast": False,
            "shout_cues": [],
            "whisper": False,
            "inner_thought": False,
            "narrator": False,
            "other": False,
        },
        "source_family": "sans_printed",
        "source_family_confidence": 0.95,
        "serif_evidence": {
            "raw": {
                "thick_thin_glyph_ids": [],
                "terminal_serif_glyph_ids": [],
            },
            "glyph_view": {
                "thick_thin_glyph_ids": [],
                "terminal_serif_glyph_ids": [],
            },
            "cross_view_glyph_ids": [],
        },
        "axes": {
            "weight": 2.5,
            "width": 2.0,
            "roundness": 2.0,
            "handwritten": 0.0,
            "angularity": 1.5,
            "energy": 1.5,
        },
        "hard_axes": ["weight", "handwritten"],
        "treatment": {
            "outline": False,
            "shadow": False,
            "inverse_fill": False,
            "texture": False,
            "distortion": False,
            "rotation": False,
        },
        "rationale": "Candidate-free source evidence was reviewed carefully.",
        "review_confidence": 0.97,
        "visual_review_index": visual_review_index,
    }


def _review_record(
    binding: dict,
    *,
    reviewer: str,
    eligibility: str = "font_signal_present",
    preferred_index: int = 0,
    confidence: float = 0.95,
) -> dict:
    aliases = list(DERIVE.FROZEN_ALIAS_ORDER)
    preferred = [aliases[preferred_index]] if eligibility == "font_signal_present" else []
    judgment = (
        {
            "preferred": preferred,
            "acceptable": [],
            "marginal": [],
            "unacceptable": [alias for alias in aliases if alias not in preferred],
            "unrenderable": [],
            "none_acceptable": False,
        }
        if eligibility == "font_signal_present"
        else None
    )
    assignment = binding["assignment"]
    public_ids = binding["card"]["v5_public_ids"]
    return SEAL.catalog_ledger.seal(
        {
            "schema_version": SEAL.catalog_ledger.SCHEMA_VERSION,
            "record_type": "font_catalog_delta_blind_review",
            "review_id": (
                f"review-{assignment['sample_id']}-{assignment['stage']}-{reviewer}"
            ),
            "sample_id": assignment["sample_id"],
            "work_id": assignment["work_id"],
            "source_page_sha256": assignment["source_page_sha256"],
            "assignment_id": public_ids["assignment_id"],
            "stage": assignment["stage"],
            "reviewer": reviewer,
            "reviewed_at": "2026-08-02T00:00:00Z",
            "role": {"primary": "dialogue", "confidence": 0.95},
            "eligibility": eligibility,
            "font_judgment": judgment,
            "confidence": confidence,
            "rationale": "Submitted blind source and candidate review evidence.",
            "evidence": {"public_sample_id": public_ids["sample_id"]},
            "source_bindings": {
                "selection_record_sha256": binding["selection_record_sha256"],
                "prior_final_record_sha256": binding[
                    "prior_final_record_sha256"
                ],
            },
            "source_review_record_sha256s": [],
            "derivation_evidence": {},
        }
    )


class AdjudicationFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.neutral_path = root / "adjudication-neutral.jsonl"
        self.private_path = root / "private-bindings.jsonl"
        self.tasks_path = root / "blind-tasks-primary.jsonl"
        self.reviews_path = root / "reviews.jsonl"
        self.reviewer = "independent-adjudicator-v5"
        self.batch_id = "production-adjudication-a-v5"
        self.bindings: list[dict] = []
        self.tasks: list[dict] = []
        self.reviews: list[dict] = []
        self.neutral_rows: list[dict] = []

        for index, suffix in enumerate(("triggered", "eligibility-exception"), 1):
            private_sample = f"fm-private-{suffix}"
            work_id = f"work-{suffix}"
            primary_source_sha = _sha(f"source:{suffix}:primary")
            primary = _private_binding(
                private_assignment_id=f"fmra-private-{suffix}-primary",
                private_sample_id=private_sample,
                public_assignment_id=f"fmv5a-public-{suffix}-primary",
                public_sample_id=f"fmv5s-public-{suffix}",
                stage="primary",
                review_order=index,
                source_sha=primary_source_sha,
                source_file=root / f"source-{suffix}-primary.png",
                work_id=work_id,
            )
            secondary = _private_binding(
                private_assignment_id=f"fmra-private-{suffix}-secondary",
                private_sample_id=private_sample,
                public_assignment_id=f"fmv5a-public-{suffix}-secondary",
                public_sample_id=f"fmv5s-public-{suffix}",
                stage="secondary",
                review_order=index,
                source_sha=_sha(f"source:{suffix}:secondary"),
                source_file=root / f"source-{suffix}-secondary.png",
                work_id=work_id,
            )
            self.bindings.extend((primary, secondary))
            self.tasks.append(
                _source_task(
                    public_assignment_id=primary["card"]["v5_public_ids"][
                        "assignment_id"
                    ],
                    public_sample_id=primary["card"]["v5_public_ids"]["sample_id"],
                    stage="primary",
                    review_order=index,
                    source_sha=primary_source_sha,
                )
            )
            eligibility = (
                "font_signal_present"
                if suffix == "triggered"
                else "font_signal_absent"
            )
            primary_review = _review_record(
                primary,
                reviewer="primary-reviewer-v5",
                eligibility=eligibility,
                preferred_index=0,
            )
            secondary_review = _review_record(
                secondary,
                reviewer="secondary-reviewer-v5",
                eligibility=eligibility,
                preferred_index=1,
            )
            # Deliberately store secondary first.  The sealed adjudication row
            # must canonicalize provenance to primary, then secondary.
            self.reviews.extend((secondary_review, primary_review))
            if suffix == "triggered":
                self.neutral_rows.append(
                    _neutral_annotation(
                        private_assignment_id=primary["assignment"]["assignment_id"],
                        private_sample_id=private_sample,
                        stage="adjudication",
                        visual_review_index=1,
                        stale_source_sha=_sha("stale-adjudication-source"),
                    )
                )

        _write_jsonl(self.neutral_path, self.neutral_rows)
        _write_jsonl(self.private_path, self.bindings)
        _write_jsonl(self.tasks_path, self.tasks)
        _write_jsonl(self.reviews_path, self.reviews)

    def build(self) -> tuple[list[dict], str]:
        return SEAL.build_sealed_annotations(
            neutral_annotations=self.neutral_path,
            private_bindings=self.private_path,
            source_tasks=self.tasks_path,
            stage="adjudication",
            reviewer=self.reviewer,
            batch_id=self.batch_id,
            review_ledger=self.reviews_path,
        )


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.neutral_path = root / "neutral.jsonl"
        self.private_path = root / "private-bindings.jsonl"
        self.tasks_path = root / "blind-tasks-secondary.jsonl"
        self.output_path = root / "sealed.jsonl"
        self.stage = "secondary"
        self.reviewer = "codex-secondary-review-team-v5"
        self.batch_id = "round4-secondary-source-a-v5"
        self.rows: list[dict] = []
        self.bindings: list[dict] = []
        self.tasks: list[dict] = []
        for index, suffix in enumerate(("b", "a"), 1):
            private_assignment = f"fmra-private-{suffix}"
            private_sample = f"fm-private-{suffix}"
            public_assignment = f"fmv5a-public-{suffix}"
            public_sample = f"fmv5s-public-{suffix}"
            source_sha = _sha(f"source:{suffix}")
            self.rows.append(
                _neutral_annotation(
                    private_assignment_id=private_assignment,
                    private_sample_id=private_sample,
                    stage=self.stage,
                    visual_review_index=index,
                    stale_source_sha=_sha(f"stale-source:{suffix}"),
                )
            )
            self.bindings.append(
                _private_binding(
                    private_assignment_id=private_assignment,
                    private_sample_id=private_sample,
                    public_assignment_id=public_assignment,
                    public_sample_id=public_sample,
                    stage=self.stage,
                    review_order=index,
                    source_sha=source_sha,
                    source_file=root / f"source-{suffix}.png",
                    work_id="gugi" if suffix == "a" else f"private-work-{suffix}",
                )
            )
            self.tasks.append(
                _source_task(
                    public_assignment_id=public_assignment,
                    public_sample_id=public_sample,
                    stage=self.stage,
                    review_order=index,
                    source_sha=source_sha,
                )
            )
        _write_jsonl(self.neutral_path, self.rows)
        _write_jsonl(self.private_path, self.bindings)
        _write_jsonl(self.tasks_path, self.tasks)

    def build(self) -> tuple[list[dict], str]:
        return SEAL.build_sealed_annotations(
            neutral_annotations=self.neutral_path,
            private_bindings=self.private_path,
            source_tasks=self.tasks_path,
            stage=self.stage,
            reviewer=self.reviewer,
            batch_id=self.batch_id,
        )

    def write(self) -> dict:
        return SEAL.seal_annotation_file(
            neutral_annotations=self.neutral_path,
            private_bindings=self.private_path,
            source_tasks=self.tasks_path,
            stage=self.stage,
            reviewer=self.reviewer,
            batch_id=self.batch_id,
            output=self.output_path,
        )


class SourceAnnotationSealV5Tests(unittest.TestCase):
    def test_null_prior_requires_workspace_validated_supplement_source_hash(self) -> None:
        binding = _private_binding(
            private_assignment_id="fmra-private-calibration-primary",
            private_sample_id="fm-private-calibration",
            public_assignment_id="fmv5a-public-calibration-primary",
            public_sample_id="fmv5s-public-calibration",
            stage="primary",
            review_order=1,
            source_sha=_sha("source:calibration"),
            source_file=Path("source-calibration.png"),
            work_id="work-calibration",
        )
        binding["prior_final_record_sha256"] = None
        binding = DERIVE.seal_record(binding)
        with self.assertRaisesRegex(
            SEAL.SourceAnnotationSealError,
            "workspace-validated calibration supplement source record",
        ):
            SEAL._private_binding_projection([binding], stage="primary")
        with self.assertRaisesRegex(
            SEAL.SourceAnnotationSealError,
            "workspace-validated calibration supplement source record",
        ):
            SEAL._private_binding_projection(
                [binding],
                stage="primary",
                calibration_null_prior_by_sample={
                    binding["sample_id"]: _sha("wrong-selection")
                },
            )
        projected = SEAL._private_binding_projection(
            [binding],
            stage="primary",
            calibration_null_prior_by_sample={
                binding["sample_id"]: binding["selection_record_sha256"]
            },
        )
        self.assertIsNone(
            projected[binding["assignment"]["assignment_id"]][
                "prior_final_record_sha256"
            ]
        )

    def test_rejoins_public_ids_replaces_sha_and_seals_exact_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows, batch_sha = fixture.build()

            self.assertEqual(
                [row["assignment_id"] for row in rows],
                ["fmv5a-public-a", "fmv5a-public-b"],
            )
            normalized_tasks = [
                DERIVE.validate_source_task(row, f"task[{index}]")
                for index, row in enumerate(fixture.tasks)
            ]
            self.assertEqual(batch_sha, DERIVE.task_batch_sha256(normalized_tasks))
            self.assertEqual(
                "0822d616d9f14c3a6cd62070551c812da291235fb1814102a097077753680706",
                batch_sha,
            )
            self.assertEqual(
                "462a8f96d948a45547ce8f1d959b1bc63c9ab8641d517ca914a38550e1d37e2b",
                DERIVE.sha256_bytes(DERIVE.jsonl_bytes(rows)),
            )
            task_by_assignment = {
                row["assignment_id"]: row for row in normalized_tasks
            }
            normalized_annotations = {}
            for index, row in enumerate(rows):
                normalized = DERIVE.validate_annotation(row, f"annotation[{index}]")
                task = task_by_assignment[row["assignment_id"]]
                self.assertEqual(
                    row["source_only_card_sha256"],
                    task["source_only_card_sha256"],
                )
                self.assertEqual(row["batch_task_set_sha256"], batch_sha)
                self.assertNotIn("review_confidence", row)
                self.assertNotIn("visual_review_index", row)
                normalized_annotations[normalized["sample_id"]] = normalized
            DERIVE._validate_batch_binding(
                normalized_tasks,
                normalized_annotations,
                reviewer_id=fixture.reviewer,
            )

            payload = DERIVE.jsonl_bytes(rows).decode("utf-8")
            self.assertNotIn("fmra-private-", payload)
            self.assertNotIn("fm-private-", payload)
            self.assertNotIn("prior_final_record_sha256", payload)
            self.assertNotIn("gugi", payload)

    def test_requires_whole_neutral_batch_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            _write_jsonl(fixture.neutral_path, fixture.rows[:1])
            with self.assertRaisesRegex(
                SEAL.SourceAnnotationSealError, "coverage mismatch"
            ):
                fixture.build()

    def test_rejects_private_binding_task_source_sha_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            changed = json.loads(json.dumps(fixture.bindings))
            changed[0]["card"]["v5_source_card"]["sha256"] = _sha("changed")
            changed[0]["card"]["review_card_sha256"] = _sha("changed")
            changed[0] = DERIVE.seal_record(changed[0])
            _write_jsonl(fixture.private_path, changed)
            with self.assertRaisesRegex(
                SEAL.SourceAnnotationSealError, "differs from its source task"
            ):
                fixture.build()

    def test_rejects_candidate_or_prior_disclosure_in_neutral_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            changed = json.loads(json.dumps(fixture.rows))
            changed[0]["rationale"] = (
                "The prior answer selected gugi and must not enter source A."
            )
            _write_jsonl(fixture.neutral_path, changed)
            with self.assertRaises(SEAL.derive.DerivationError):
                fixture.build()

    def test_output_is_canonical_and_strictly_write_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            summary = fixture.write()
            original = fixture.output_path.read_bytes()
            output_rows = [
                json.loads(line) for line in original.decode("utf-8").splitlines()
            ]
            self.assertEqual(original, DERIVE.jsonl_bytes(output_rows))
            self.assertEqual(summary["records"], 2)
            self.assertEqual(summary["output_sha256"], DERIVE.sha256_bytes(original))

            with self.assertRaisesRegex(
                SEAL.derive.DerivationError, "refusing to overwrite"
            ):
                fixture.write()
            self.assertEqual(fixture.output_path.read_bytes(), original)

    def test_adjudication_exactly_covers_triggered_set_and_seals_prior_reviews(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = AdjudicationFixture(Path(temporary))
            rows, batch_sha = fixture.build()

            self.assertEqual(1, len(rows))
            row = rows[0]
            self.assertEqual("adjudication", row["stage"])
            self.assertEqual(
                "fmv5a-public-triggered-primary", row["assignment_id"]
            )
            expected_review_shas = [
                review["record_sha256"]
                for stage in ("primary", "secondary")
                for review in fixture.reviews
                if review["sample_id"] == "fm-private-triggered"
                and review["stage"] == stage
            ]
            self.assertEqual(
                expected_review_shas, row["source_review_record_sha256s"]
            )
            primary_task = next(
                task
                for task in fixture.tasks
                if task["assignment_id"] == row["assignment_id"]
            )
            adjudication_task = SEAL.catalog_ledger._v5_task_for_stage(
                primary_task, "adjudication"
            )
            normalized_task = DERIVE.validate_source_task(
                adjudication_task, "adjudication-task"
            )
            normalized = DERIVE.validate_annotation(row, "adjudication-annotation")
            self.assertEqual(
                batch_sha, DERIVE.task_batch_sha256([normalized_task])
            )
            DERIVE._validate_batch_binding(
                [normalized_task],
                {normalized["sample_id"]: normalized},
                reviewer_id=fixture.reviewer,
            )
            serialized = DERIVE.jsonl_bytes(rows).decode("utf-8")
            self.assertNotIn("fm-private-triggered", serialized)
            self.assertNotIn("ko-candidate-", serialized)
            self.assertNotIn("prior_final_record_sha256", serialized)

    def test_adjudication_excludes_eligibility_exception_from_neutral_batch(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = AdjudicationFixture(Path(temporary))
            exception_primary = next(
                binding
                for binding in fixture.bindings
                if binding["sample_id"] == "fm-private-eligibility-exception"
                and binding["assignment"]["stage"] == "primary"
            )
            changed = [
                *fixture.neutral_rows,
                _neutral_annotation(
                    private_assignment_id=exception_primary["assignment"][
                        "assignment_id"
                    ],
                    private_sample_id=exception_primary["sample_id"],
                    stage="adjudication",
                    visual_review_index=2,
                    stale_source_sha=_sha("exception-source"),
                ),
            ]
            _write_jsonl(fixture.neutral_path, changed)
            with self.assertRaisesRegex(
                SEAL.SourceAnnotationSealError, "triggered adjudication.*coverage"
            ):
                fixture.build()

    def test_adjudicator_must_be_independent_of_both_prior_reviewers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = AdjudicationFixture(Path(temporary))
            fixture.reviewer = "secondary-reviewer-v5"
            with self.assertRaisesRegex(
                SEAL.SourceAnnotationSealError, "adjudicator must be independent"
            ):
                fixture.build()

    def test_workspace_adjudication_seals_then_commits_and_submits_end_to_end(
        self,
    ) -> None:
        from tests.python import test_font_matching_catalog_delta_ledger as ledger_test

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_fixture = ledger_test.Fixture(root / "fixture")
            workspace = root / "workspace"
            source_fixture.init(workspace, mode="production", v5=True)
            harness = ledger_test.DeltaLedgerTest()
            harness.fixture = source_fixture
            harness.root = root
            harness._submit_v5_stage(
                workspace, stage="primary", reviewer="primary-reviewer-v5"
            )
            secondary_annotations = harness._v5_source_annotations(
                workspace, stage="secondary", reviewer="secondary-reviewer-v5"
            )
            for index, annotation in enumerate(secondary_annotations):
                annotation["role_evidence"]["whisper"] = True
                secondary_annotations[index] = DERIVE.seal_record(annotation)
            secondary_commit = ledger_test.LEDGER.commit_source_annotations(
                workspace,
                stage="secondary",
                reviewer="secondary-reviewer-v5",
                source_annotations=secondary_annotations,
            )
            _, secondary_decisions, secondary_audits = (
                harness._v5_release_and_derive(
                    workspace, commit=secondary_commit
                )
            )
            ledger_test.LEDGER.submit_decisions(
                workspace,
                stage="secondary",
                reviewer="secondary-reviewer-v5",
                decisions=secondary_decisions,
                derivation_audits=secondary_audits,
            )

            private_bindings = ledger_test.LEDGER.read_jsonl(
                workspace / "private-bindings.jsonl"
            )
            primary_bindings = [
                binding
                for binding in private_bindings
                if binding["assignment"]["stage"] == "primary"
            ]
            neutral_rows = [
                _neutral_annotation(
                    private_assignment_id=binding["assignment"]["assignment_id"],
                    private_sample_id=binding["sample_id"],
                    stage="adjudication",
                    visual_review_index=index,
                    stale_source_sha=_sha(f"stale-workspace-source:{index}"),
                )
                for index, binding in enumerate(primary_bindings, 1)
            ]
            neutral_path = root / "adjudication-neutral.jsonl"
            _write_jsonl(neutral_path, neutral_rows)
            rows, _ = SEAL.build_sealed_annotations(
                neutral_annotations=neutral_path,
                private_bindings=workspace / "private-bindings.jsonl",
                source_tasks=workspace / "blind-tasks-primary.jsonl",
                stage="adjudication",
                reviewer="independent-adjudicator-v5",
                batch_id="workspace-adjudication-a-v5",
                review_ledger=workspace / "reviews.jsonl",
                workspace=workspace,
            )
            commit = ledger_test.LEDGER.commit_source_annotations(
                workspace,
                stage="adjudication",
                reviewer="independent-adjudicator-v5",
                source_annotations=rows,
            )
            _, decisions, audits = harness._v5_release_and_derive(
                workspace, commit=commit
            )
            created = ledger_test.LEDGER.submit_decisions(
                workspace,
                stage="adjudication",
                reviewer="independent-adjudicator-v5",
                decisions=decisions,
                derivation_audits=audits,
            )
            self.assertEqual(len(primary_bindings), len(created))
            by_sample = {
                row["sample_id"]: row
                for row in ledger_test.LEDGER.read_jsonl(
                    workspace / "reviews.jsonl"
                )
                if row["stage"] in {"primary", "secondary"}
            }
            self.assertTrue(
                all(len(row["source_review_record_sha256s"]) == 2 for row in rows)
            )
            self.assertEqual(
                set(by_sample), {row["sample_id"] for row in created}
            )


if __name__ == "__main__":
    unittest.main()
