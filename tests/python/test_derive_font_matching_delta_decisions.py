from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "derive_font_matching_delta_decisions.py"
SPEC = importlib.util.spec_from_file_location(
    "derive_font_matching_delta_decisions", SCRIPT
)
assert SPEC and SPEC.loader
DERIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DERIVE)


_BUNDLES: dict[str, dict] = {}


def raw_source_task(
    sample_id: str = "fm_sample_a",
    *,
    assignment_id: str = "fmra-sample-a-primary",
    stage: str = "primary",
    review_order: int = 1,
) -> dict:
    return DERIVE.seal_record(
        {
            "schema_version": DERIVE.SOURCE_TASK_SCHEMA_VERSION,
            "record_type": DERIVE.SOURCE_TASK_RECORD_TYPE,
            "assignment_id": assignment_id,
            "sample_id": sample_id,
            "stage": stage,
            "review_order": review_order,
            "source_only_card_sha256": DERIVE.sha256_bytes(
                f"source:{assignment_id}".encode()
            ),
            "review_surface": dict(DERIVE.SOURCE_REVIEW_SURFACE),
        }
    )


def empty_serif() -> dict:
    return {
        "raw": {
            "thick_thin_glyph_ids": [],
            "terminal_serif_glyph_ids": [],
        },
        "glyph_view": {
            "thick_thin_glyph_ids": [],
            "terminal_serif_glyph_ids": [],
        },
        "cross_view_glyph_ids": [],
    }


def _raw_annotation(
    task_value: dict,
    batch_tasks: list[dict],
    *,
    reviewer: str = "reviewer-a",
    batch_id: str = "batch-a",
) -> dict:
    validate = (
        DERIVE.validate_source_task
        if task_value.get("schema_version") == DERIVE.SOURCE_TASK_SCHEMA_VERSION
        else DERIVE.validate_task
    )
    normalized_task = validate(task_value, "task")
    normalized_batch = []
    for index, value in enumerate(batch_tasks):
        batch_validate = (
            DERIVE.validate_source_task
            if value.get("schema_version") == DERIVE.SOURCE_TASK_SCHEMA_VERSION
            else DERIVE.validate_task
        )
        normalized_batch.append(batch_validate(value, f"batch[{index}]"))
    return DERIVE.seal_record(
        {
            "schema_version": DERIVE.SOURCE_SCHEMA_VERSION,
            "record_type": DERIVE.SOURCE_RECORD_TYPE,
            "assignment_id": normalized_task["assignment_id"],
            "sample_id": normalized_task["sample_id"],
            "stage": normalized_task["stage"],
            "reviewer_id": reviewer,
            "batch_id": batch_id,
            "batch_size": len(normalized_batch),
            "batch_task_set_sha256": DERIVE.task_batch_sha256(normalized_batch),
            "source_only_card_sha256": normalized_task["source_only_card_sha256"],
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
            "serif_evidence": empty_serif(),
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
            "rationale": "Complete candidate-free source evidence was inspected carefully.",
        }
    )


def raw_task(
    sample_id: str = "fm_sample_a",
    *,
    assignment_id: str = "fmra-sample-a-primary",
    stage: str = "primary",
    review_order: int = 1,
    aliases: list[str] | None = None,
    mandatory_unrenderable: list[str] | None = None,
    anchor_salt: str = "a",
) -> dict:
    source_task = raw_source_task(
        sample_id,
        assignment_id=assignment_id,
        stage=stage,
        review_order=review_order,
    )
    annotation = _raw_annotation(source_task, [source_task])
    normalized_source = DERIVE.validate_source_task(source_task, "source")
    normalized_annotation = DERIVE.validate_annotation(annotation, "annotation")
    commit = DERIVE.seal_record(
        {
            "schema_version": DERIVE.SOURCE_COMMIT_SCHEMA_VERSION,
            "record_type": DERIVE.SOURCE_COMMIT_RECORD_TYPE,
            "commit_id": "fmac-" + DERIVE.sha256_bytes(assignment_id.encode())[:32],
            "stage": stage,
            "reviewer_id": normalized_annotation["reviewer_id"],
            "batch_id": normalized_annotation["batch_id"],
            "batch_size": 1,
            "batch_task_set_sha256": DERIVE.task_batch_sha256([normalized_source]),
            "annotation_jsonl_sha256": DERIVE.sha256_bytes(
                DERIVE.jsonl_bytes([annotation])
            ),
            "previous_commit_record_sha256": None,
            "annotations": [annotation],
            "committed_at": "2026-08-02T00:00:00Z",
        }
    )
    nonce = DERIVE.sha256_bytes(
        f"nonce:{assignment_id}:{stage}:{anchor_salt}:{aliases}".encode()
    )
    nonce_sha = DERIVE.sha256_bytes(nonce.encode("ascii"))
    alias_map = DERIVE.release_alias_map(nonce_sha)
    public_order = DERIVE.release_alias_order(nonce_sha, assignment_id)
    mandatory = [
        alias_map.get(value, value) for value in (mandatory_unrenderable or [])
    ]
    entry = {
        "assignment_id": assignment_id,
        "sample_id": sample_id,
        "source_task_record_sha256": normalized_source[
            "source_task_record_sha256"
        ],
        "source_annotation_record_sha256": normalized_annotation["record_sha256"],
        "candidate_batch_order": 0,
        "blind_alias_order": public_order,
        "candidate_order_seed": DERIVE.release_candidate_order_seed(
            nonce_sha, assignment_id
        ),
        "mandatory_unrenderable": [
            value for value in public_order if value in mandatory
        ],
        "full_card_sha256": DERIVE.sha256_bytes(
            f"full:{assignment_id}:{nonce_sha}".encode()
        ),
        "source_only_card_sha256": normalized_source[
            "source_only_card_sha256"
        ],
        "candidate_only_card_sha256": DERIVE.sha256_bytes(
            f"candidate:{assignment_id}:{nonce_sha}".encode()
        ),
        "neutral_tie_anchors": {
            "chapter_sha256": DERIVE.sha256_bytes(
                f"chapter:{anchor_salt}".encode()
            ),
            "work_sha256": DERIVE.sha256_bytes(f"work:{anchor_salt}".encode()),
        },
    }
    release_id = "fmbr-" + DERIVE.sha256_bytes(
        DERIVE.canonical_json_bytes(
            [
                "font-matching-v5-candidate-release",
                commit["commit_id"],
                commit["record_sha256"],
                nonce_sha,
            ]
        )
    )[:32]
    release = DERIVE.seal_record(
        {
            "schema_version": DERIVE.RELEASE_SCHEMA_VERSION,
            "record_type": DERIVE.RELEASE_RECORD_TYPE,
            "release_id": release_id,
            "source_commit_id": commit["commit_id"],
            "source_commit_record_sha256": commit["record_sha256"],
            "stage": stage,
            "reviewer_id": normalized_annotation["reviewer_id"],
            "batch_id": normalized_annotation["batch_id"],
            "batch_size": 1,
            "batch_task_set_sha256": DERIVE.task_batch_sha256([normalized_source]),
            "release_nonce": nonce,
            "release_nonce_sha256": nonce_sha,
            "entries": [entry],
            "released_at": "2026-08-02T00:00:01Z",
        }
    )
    normalized_release = DERIVE.validate_candidate_release(
        release,
        [normalized_source],
        {sample_id: normalized_annotation},
    )
    candidate_task = DERIVE.materialize_candidate_task(
        normalized_release,
        normalized_release["entries"][0],
        normalized_source,
    )
    _BUNDLES[candidate_task["record_sha256"]] = {
        "source_task": source_task,
        "annotation": annotation,
        "commit": commit,
        "release": release,
    }
    return candidate_task


def raw_annotation(
    task_value: dict,
    batch_tasks: list[dict],
    *,
    reviewer: str = "reviewer-a",
    batch_id: str = "batch-a",
) -> dict:
    return _raw_annotation(
        task_value, batch_tasks, reviewer=reviewer, batch_id=batch_id
    )


def reseal(value: dict) -> dict:
    return DERIVE.seal_record(value)


def raw_release(tasks: list[dict], annotations: list[dict]) -> dict:
    if len(tasks) != 1:
        raise AssertionError("test helper only supports a single cached release")
    return copy.deepcopy(_BUNDLES[tasks[0]["record_sha256"]]["release"])


def raw_source_commit(task_value: dict) -> dict:
    return copy.deepcopy(_BUNDLES[task_value["record_sha256"]]["commit"])


def normalized_pair(
    task_value: dict | None = None, annotation_value: dict | None = None
) -> tuple[dict, dict]:
    raw = task_value or raw_task()
    annotation_raw = annotation_value or raw_annotation(raw, [raw])
    annotation = DERIVE.validate_annotation(annotation_raw, "annotation")
    task = DERIVE.validate_task(raw, "task")
    if task["source_annotation_record_sha256"] != annotation["record_sha256"]:
        bundle = _BUNDLES[raw["record_sha256"]]
        source = DERIVE.validate_source_task(bundle["source_task"], "source")
        release_raw = copy.deepcopy(bundle["release"])
        release_raw.pop("record_sha256", None)
        release_raw["entries"][0]["source_annotation_record_sha256"] = annotation[
            "record_sha256"
        ]
        release_raw = DERIVE.seal_record(release_raw)
        release = DERIVE.validate_candidate_release(
            release_raw,
            [source],
            {annotation["sample_id"]: annotation},
        )
        task = DERIVE.validate_task(
            DERIVE.materialize_candidate_task(
                release, release["entries"][0], source
            ),
            "task",
        )
    return task, annotation


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_bytes(DERIVE.jsonl_bytes(rows))


class SourceAnnotationContractTests(unittest.TestCase):
    def test_release_nonce_record_and_challenge_are_cryptographically_bound(
        self,
    ) -> None:
        task_value = raw_task()
        annotation_value = raw_annotation(task_value, [task_value])
        task = DERIVE.validate_task(task_value, "task")
        annotation = DERIVE.validate_annotation(annotation_value, "annotation")
        release_value = raw_release([task_value], [annotation_value])

        changed_task = copy.deepcopy(task_value)
        changed_task["candidate_release_record_sha256"] = "f" * 64
        changed_task = DERIVE.seal_record(changed_task)
        with self.assertRaisesRegex(DERIVE.DerivationError, "release_challenge"):
            DERIVE.validate_task(changed_task, "changed-task")

        changed_nonce = copy.deepcopy(release_value)
        changed_nonce["release_nonce"] = "e" * 64
        changed_nonce["release_nonce_sha256"] = DERIVE.sha256_bytes(
            changed_nonce["release_nonce"].encode("ascii")
        )
        changed_nonce = DERIVE.seal_record(changed_nonce)
        source_task = DERIVE.validate_source_task(
            _BUNDLES[task_value["record_sha256"]]["source_task"], "source-task"
        )
        with self.assertRaisesRegex(
            DERIVE.DerivationError, "release_id|blind_alias_order"
        ):
            DERIVE.validate_candidate_release(
                changed_nonce,
                [source_task],
                {annotation["sample_id"]: annotation},
            )

        other_task_value = raw_task(anchor_salt="other-release")
        other_release = raw_release([other_task_value], [raw_annotation(other_task_value, [other_task_value])])
        with self.assertRaisesRegex(DERIVE.DerivationError, "differs from release"):
            DERIVE.derive_all(
                [task],
                {annotation["sample_id"]: annotation},
                release=DERIVE.validate_candidate_release(
                    other_release,
                    [DERIVE.validate_source_task(
                        _BUNDLES[other_task_value["record_sha256"]]["source_task"],
                        "other-source",
                    )],
                    {
                        annotation["sample_id"]: DERIVE.validate_annotation(
                            raw_annotation(other_task_value, [other_task_value]),
                            "other-annotation",
                        )
                    },
                ),
            )

    def test_task_requires_v5_type_surface_and_all_three_card_hashes(self) -> None:
        value = raw_task()
        for mutate, message in (
            (lambda row: row.__setitem__("schema_version", "bogus"), "schema_version"),
            (lambda row: row.__setitem__("record_type", "bogus"), "record_type"),
            (
                lambda row: row["review_surface"].__setitem__(
                    "source_pixels_visible_during_candidate_stage", True
                ),
                "review_surface",
            ),
            (
                lambda row: row.__setitem__(
                    "candidate_only_card_sha256", row["source_only_card_sha256"]
                ),
                "distinct",
            ),
        ):
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.assertRaisesRegex(DERIVE.DerivationError, message):
                DERIVE.validate_task(reseal(changed), "task")

    def test_annotation_seal_and_task_reviewer_card_bindings_are_mandatory(
        self,
    ) -> None:
        task_value = raw_task()
        value = raw_annotation(task_value, [task_value])
        unsealed = copy.deepcopy(value)
        unsealed.pop("record_sha256")
        with self.assertRaisesRegex(DERIVE.DerivationError, "record_sha256"):
            DERIVE.validate_annotation(unsealed, "annotation")
        for key, replacement in (
            ("assignment_id", "fmra-other"),
            ("stage", "secondary"),
            ("source_only_card_sha256", "f" * 64),
        ):
            changed = copy.deepcopy(value)
            changed[key] = replacement
            task_normalized = DERIVE.validate_task(task_value, "task")
            annotation_normalized = DERIVE.validate_annotation(
                reseal(changed), "annotation"
            )
            with self.assertRaisesRegex(DERIVE.DerivationError, "sealed task"):
                DERIVE.derive_one(task_normalized, annotation_normalized)

    def test_adjudication_annotation_requires_exact_source_review_seal_array(
        self,
    ) -> None:
        task_value = raw_source_task(stage="adjudication")
        missing = _raw_annotation(task_value, [task_value])
        with self.assertRaisesRegex(
            DERIVE.DerivationError, "source_review_record_sha256s"
        ):
            DERIVE.validate_annotation(missing, "adjudication-missing-sources")

        valid = copy.deepcopy(missing)
        valid["source_review_record_sha256s"] = ["1" * 64, "2" * 64]
        normalized = DERIVE.validate_annotation(reseal(valid), "adjudication")
        self.assertEqual(
            ["1" * 64, "2" * 64], normalized["source_review_record_sha256s"]
        )

        for sources in ([], ["1" * 64] * 2, ["1" * 64, "2" * 64, "3" * 64]):
            changed = copy.deepcopy(missing)
            changed["source_review_record_sha256s"] = sources
            with self.assertRaises(DERIVE.DerivationError):
                DERIVE.validate_annotation(reseal(changed), "adjudication-invalid")

        primary_task = raw_source_task()
        primary = _raw_annotation(primary_task, [primary_task])
        primary["source_review_record_sha256s"] = ["1" * 64]
        with self.assertRaisesRegex(
            DERIVE.DerivationError, "source_review_record_sha256s"
        ):
            DERIVE.validate_annotation(reseal(primary), "primary-with-sources")

    def test_whole_a_batch_must_be_sealed_before_candidate_derivation(self) -> None:
        first = raw_source_task()
        second = raw_source_task(
            "fm_sample_b",
            assignment_id="fmra-sample-b-primary",
            review_order=2,
        )
        tasks = [
            DERIVE.validate_source_task(first, "first"),
            DERIVE.validate_source_task(second, "second"),
        ]
        one_annotation = DERIVE.validate_annotation(
            _raw_annotation(first, [first, second]), "annotation"
        )
        with self.assertRaisesRegex(DERIVE.DerivationError, "whole assigned A batch"):
            DERIVE._validate_batch_binding(tasks, {"fm_sample_a": one_annotation})

        wrong_batch = _raw_annotation(first, [first])
        annotations = {
            "fm_sample_a": DERIVE.validate_annotation(wrong_batch, "first-a"),
            "fm_sample_b": DERIVE.validate_annotation(
                _raw_annotation(second, [first, second]), "second-a"
            ),
        }
        with self.assertRaisesRegex(DERIVE.DerivationError, "task-set seal"):
            DERIVE._validate_batch_binding(tasks, annotations)
        with self.assertRaises(DERIVE.DerivationError):
            DERIVE.validate_task(first, "pre-release-source-task")

    def test_primary_annotation_cannot_be_reused_for_secondary(self) -> None:
        primary = raw_task()
        secondary = raw_task(assignment_id="fmra-sample-a-secondary", stage="secondary")
        annotation = raw_annotation(primary, [primary])
        changed = copy.deepcopy(annotation)
        changed["assignment_id"] = "fmra-sample-a-secondary"
        changed["stage"] = "secondary"
        changed["source_only_card_sha256"] = DERIVE.validate_task(
            secondary, "secondary"
        )["source_only_card_sha256"]
        # Reusing the original seal cannot survive any stage/assignment edit.
        with self.assertRaisesRegex(DERIVE.DerivationError, "does not seal"):
            DERIVE.validate_annotation(changed, "reused")

    def test_all_four_eligibility_booleans_are_explicit_and_fail_closed(self) -> None:
        task_value = raw_task()
        for key in (
            "complete_text_object",
            "single_source_skeleton",
            "clean_glyph_isolation",
            "role_context_sufficient",
        ):
            value = raw_annotation(task_value, [task_value])
            value["eligibility_evidence"][key] = False
            task_normalized, annotation_normalized = normalized_pair(
                task_value, reseal(value)
            )
            decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
            self.assertEqual("crop_needs_review", decision["eligibility"])
            self.assertIsNone(decision["font_judgment"])
            self.assertEqual(0, audit["safe_count"])

        absent = raw_annotation(task_value, [task_value])
        absent["eligibility_evidence"]["font_signal_skeleton_present"] = False
        task_normalized, annotation_normalized = normalized_pair(
            task_value, reseal(absent)
        )
        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        self.assertEqual("font_signal_absent", decision["eligibility"])
        self.assertIsNone(decision["font_judgment"])
        self.assertEqual(0, audit["safe_count"])

    def test_candidate_alias_prior_answer_and_real_identity_are_rejected(self) -> None:
        task_value = raw_task()
        for rationale, message in (
            ("Source resembles ko-candidate-4cc309d56243eb25.", "candidate alias"),
            ("This repeats a previous decision from another reviewer.", "prior answer"),
            (
                "This looks like Black Han Sans in the source crop.",
                "candidate identity",
            ),
        ):
            value = raw_annotation(task_value, [task_value])
            value["rationale"] = rationale
            with self.assertRaisesRegex(DERIVE.DerivationError, message):
                DERIVE.validate_annotation(reseal(value), "annotation")


class RoleEvidenceTests(unittest.TestCase):
    def test_contradictory_role_evidence_is_never_resolved_by_precedence(self) -> None:
        task_value = raw_task()
        contradictions = (
            {"label": True, "sfx_event": "impact", "external_utterance": False},
            {"sfx_event": "impact", "comic_timing": True, "external_utterance": False},
            {"sfx_event": "motion", "external_utterance": True},
            {"external_utterance": True, "inner_thought": True},
            {"external_utterance": False, "inner_thought": True, "narrator": True},
            {"independent_aside": True, "same_utterance_contrast": True},
            {"shout_cues": list(DERIVE.SHOUT_CUES[:2]), "whisper": True},
            {"other": True, "external_utterance": True},
        )
        for changes in contradictions:
            with self.subTest(changes=changes):
                value = raw_annotation(task_value, [task_value])
                value["role_evidence"].update(changes)
                with self.assertRaises(DERIVE.DerivationError):
                    DERIVE.validate_annotation(reseal(value), "annotation")

    def test_valid_roles_are_derived_from_observable_evidence(self) -> None:
        task_value = raw_task()
        cases = (
            ({"label": True, "external_utterance": False}, "sign_ui_title"),
            ({"sfx_event": "motion", "external_utterance": False}, "sfx_motion"),
            ({"comic_timing": True, "external_utterance": False}, "sfx_comic"),
            ({"independent_aside": True}, "aside_balloon_edge"),
            ({"same_utterance_contrast": True}, "emphasis_dialogue"),
            ({"shout_cues": list(DERIVE.SHOUT_CUES[:2])}, "shout"),
            ({"whisper": True}, "whisper"),
            ({"external_utterance": False, "inner_thought": True}, "thought"),
            ({"external_utterance": False, "narrator": True}, "narration"),
        )
        for changes, expected in cases:
            with self.subTest(expected=expected):
                value = raw_annotation(task_value, [task_value])
                value["role_evidence"].update(changes)
                normalized = DERIVE.validate_annotation(reseal(value), "annotation")
                self.assertEqual(expected, DERIVE.derive_role(normalized)[0])


class GateTierAndAuditTests(unittest.TestCase):
    def test_serif_requires_two_identified_glyphs_in_both_views(self) -> None:
        task_value = raw_task()
        weak = raw_annotation(task_value, [task_value])
        weak["source_family"] = "serif_printed"
        weak["serif_evidence"] = {
            "raw": {
                "thick_thin_glyph_ids": ["glyph-a", "glyph-b"],
                "terminal_serif_glyph_ids": ["glyph-a", "glyph-b"],
            },
            "glyph_view": {
                "thick_thin_glyph_ids": ["glyph-a", "glyph-b"],
                "terminal_serif_glyph_ids": ["glyph-a"],
            },
            "cross_view_glyph_ids": ["glyph-a"],
        }
        with self.assertRaisesRegex(DERIVE.DerivationError, "two cross-view glyphs"):
            DERIVE.validate_annotation(reseal(weak), "weak")

        partial = copy.deepcopy(weak)
        partial["source_family"] = "mixed_or_unknown"
        with self.assertRaisesRegex(DERIVE.DerivationError, "low family confidence"):
            DERIVE.validate_annotation(reseal(partial), "partial-high")
        partial["source_family_confidence"] = 0.70
        partial_task, partial_normalized = normalized_pair(
            task_value, reseal(partial)
        )
        partial_decision, _ = DERIVE.derive_one(partial_task, partial_normalized)
        self.assertLess(partial_decision["confidence"], 0.75)

        strong = copy.deepcopy(weak)
        strong["serif_evidence"]["glyph_view"]["terminal_serif_glyph_ids"] = [
            "glyph-a",
            "glyph-b",
        ]
        strong["serif_evidence"]["cross_view_glyph_ids"] = ["glyph-a", "glyph-b"]
        task_normalized, annotation_normalized = normalized_pair(
            task_value, reseal(strong)
        )
        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        self.assertTrue(decision["font_judgment"]["none_acceptable"])
        self.assertEqual("serif_printed", audit["effective_family_gate"])
        self.assertEqual("missing_serif_printed", audit["none_audit"]["reason_code"])

    def test_safe_requires_two_matched_hard_axes(self) -> None:
        task_value = raw_task()
        for hard_axes in ([], ["weight"]):
            value = raw_annotation(task_value, [task_value])
            value["hard_axes"] = hard_axes
            task_normalized, annotation_normalized = normalized_pair(
                task_value, reseal(value)
            )
            decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
            self.assertTrue(decision["font_judgment"]["none_acceptable"])
            self.assertTrue(
                all(
                    "hard_axis_evidence_below_two" in row["hard_failures"]
                    for row in audit["candidates"]
                )
            )
        task_normalized, annotation_normalized = normalized_pair(task_value)
        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        self.assertFalse(decision["font_judgment"]["none_acceptable"])
        self.assertTrue(
            all(
                len(row["matched_hard_axes"]) >= 2
                for row in audit["candidates"]
                if row["safe"]
            )
        )

    def test_display_source_blocks_handwritten_candidate_inversion(self) -> None:
        task_value = raw_task()
        value = raw_annotation(task_value, [task_value])
        alias = "ko-candidate-9ee53bb2477d92a2"
        value["source_family"] = "display"
        value["axes"] = copy.deepcopy(DERIVE.PROTOTYPES[alias]["axes"])
        value["hard_axes"] = ["roundness", "handwritten"]
        normalized_task, normalized = normalized_pair(task_value, reseal(value))
        _, audit = DERIVE.derive_one(normalized_task, normalized)
        public_alias = DERIVE.release_alias_map(
            normalized_task["release_nonce_sha256"]
        )[alias]
        candidate = next(
            row for row in audit["candidates"] if row["alias"] == public_alias
        )
        self.assertEqual(0.0, candidate["distance"])
        self.assertEqual("fail", candidate["family_gate"])
        self.assertIn(
            "family_printed_handwritten_inversion", candidate["hard_failures"]
        )
        self.assertFalse(candidate["safe"])

    def test_safe_cap_and_audit_numeric_self_consistency_are_enforced(self) -> None:
        task_normalized, annotation_normalized = normalized_pair()
        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        self.assertLessEqual(audit["safe_count"], 2)
        DERIVE._validate_audit(audit, task_normalized, annotation_normalized, decision)
        tampered = copy.deepcopy(audit)
        tampered["candidates"][0]["distance"] = 0.0
        tampered = DERIVE.seal_record(tampered)
        with self.assertRaisesRegex(DERIVE.DerivationError, "inconsistent"):
            DERIVE._validate_audit(
                tampered, task_normalized, annotation_normalized, decision
            )
        bool_numeric = copy.deepcopy(audit)
        zero_axis = next(
            row
            for row in bool_numeric["candidates"]
            if row["prototype_axes"]["handwritten"] == 0.0
        )
        zero_axis["prototype_axes"]["handwritten"] = False
        bool_numeric = DERIVE.seal_record(bool_numeric)
        with self.assertRaisesRegex(DERIVE.DerivationError, "0.5-step number"):
            DERIVE._validate_audit(
                bool_numeric, task_normalized, annotation_normalized, decision
            )

    def test_partial_deployment_failure_has_reason_precedence(self) -> None:
        mandatory = "ko-candidate-2a5d12c7e8f32c30"
        task_value = raw_task(mandatory_unrenderable=[mandatory])
        value = raw_annotation(task_value, [task_value])
        value["source_family"] = "mixed_or_unknown"
        value["source_family_confidence"] = 1.0
        value["axes"] = {
            "weight": 0.5,
            "width": 2.0,
            "roundness": 1.5,
            "handwritten": 2.0,
            "angularity": 3.0,
            "energy": 3.0,
        }
        value["hard_axes"] = ["weight", "handwritten", "energy"]
        task_normalized, annotation_normalized = normalized_pair(
            task_value, reseal(value)
        )
        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        self.assertTrue(decision["font_judgment"]["none_acceptable"])
        self.assertEqual("deployment_failure", audit["none_audit"]["reason_code"])
        unavailable = next(
            row
            for row in audit["candidates"]
            if row["alias"]
            == DERIVE.release_alias_map(task_normalized["release_nonce_sha256"])[
                mandatory
            ]
        )
        self.assertTrue(unavailable["would_be_safe_without_deployment"])

    def test_unrenderable_nearest_candidate_cannot_create_false_none(self) -> None:
        mandatory = "ko-candidate-cd8774e1d647c522"
        available = "ko-candidate-4cc309d56243eb25"
        task_value = raw_task(mandatory_unrenderable=[mandatory])
        value = raw_annotation(task_value, [task_value])
        value["source_family"] = "sans_printed"
        value["source_family_confidence"] = 1.0
        value["axes"] = copy.deepcopy(DERIVE.PROTOTYPES[mandatory]["axes"])
        value["hard_axes"] = ["weight", "handwritten"]
        task_normalized, annotation_normalized = normalized_pair(
            task_value, reseal(value)
        )

        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        available_row = next(
            row
            for row in audit["candidates"]
            if row["alias"]
            == DERIVE.release_alias_map(task_normalized["release_nonce_sha256"])[
                available
            ]
        )

        self.assertEqual(0.1, available_row["distance"])
        self.assertEqual("preferred", available_row["tier"])
        self.assertTrue(available_row["safe"])
        self.assertFalse(decision["font_judgment"]["none_acceptable"])
        self.assertIsNone(audit["none_audit"])

    def test_neutral_anchor_not_alias_order_breaks_true_ties_deterministically(
        self,
    ) -> None:
        first = raw_task(aliases=list(DERIVE.FROZEN_ALIAS_ORDER), anchor_salt="first")
        second = raw_task(
            aliases=list(reversed(DERIVE.FROZEN_ALIAS_ORDER)), anchor_salt="first"
        )
        first_normalized = DERIVE.validate_task(first, "first")
        second_normalized = DERIVE.validate_task(second, "second")
        self.assertEqual(
            [
                DERIVE._neutral_tie_break(first_normalized, alias)
                for alias in DERIVE.FROZEN_ALIAS_ORDER
            ],
            [
                DERIVE._neutral_tie_break(second_normalized, alias)
                for alias in DERIVE.FROZEN_ALIAS_ORDER
            ],
        )

    def test_audit_binds_annotation_and_every_card_hash(self) -> None:
        task_normalized, annotation_normalized = normalized_pair()
        decision, audit = DERIVE.derive_one(task_normalized, annotation_normalized)
        self.assertEqual(
            annotation_normalized["record_sha256"],
            audit["source_annotation_record_sha256"],
        )
        self.assertEqual(
            annotation_normalized["canonical_annotation_sha256"],
            audit["source_annotation_canonical_sha256"],
        )
        for key in (
            "full_card_sha256",
            "source_only_card_sha256",
            "candidate_only_card_sha256",
        ):
            self.assertEqual(task_normalized[key], audit[key])
        changed = copy.deepcopy(audit)
        changed["candidate_only_card_sha256"] = "f" * 64
        changed = DERIVE.seal_record(changed)
        with self.assertRaisesRegex(DERIVE.DerivationError, "binding"):
            DERIVE._validate_audit(
                changed, task_normalized, annotation_normalized, decision
            )


class CliTests(unittest.TestCase):
    def test_cli_is_write_once_disjoint_and_revalidates_exact_artifacts(self) -> None:
        task_value = raw_task()
        annotation_value = raw_annotation(task_value, [task_value])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = root / "tasks.jsonl"
            annotations = root / "annotations.jsonl"
            decisions = root / "decisions.jsonl"
            audit = root / "audit.jsonl"
            candidate_release = root / "candidate-releases.jsonl"
            source_commits = root / "source-commits.jsonl"
            write_jsonl(tasks, [task_value])
            write_jsonl(annotations, [annotation_value])
            write_jsonl(
                candidate_release,
                [raw_release([task_value], [annotation_value])],
            )
            write_jsonl(source_commits, [raw_source_commit(task_value)])
            common = [
                "--tasks",
                str(tasks),
                "--annotations",
                str(annotations),
                "--decisions",
                str(decisions),
                "--audit",
                str(audit),
                "--candidate-release",
                str(candidate_release),
                "--source-commits",
                str(source_commits),
                "--stage",
                "primary",
                "--reviewer",
                "reviewer-a",
            ]
            self.assertEqual(0, DERIVE.main(["derive", *common]))
            self.assertEqual(0, DERIVE.main(["validate", *common]))
            with self.assertRaises(SystemExit):
                DERIVE.main(["derive", *common])
            with self.assertRaises(SystemExit):
                DERIVE.main(
                    [
                        "derive",
                        "--tasks",
                        str(tasks),
                        "--annotations",
                        str(annotations),
                        "--decisions",
                        str(tasks),
                        "--audit",
                        str(root / "other.jsonl"),
                        "--candidate-release",
                        str(candidate_release),
                        "--stage",
                        "primary",
                        "--reviewer",
                        "reviewer-a",
                    ]
                )

            rows = [
                json.loads(line)
                for line in decisions.read_text(encoding="utf-8").splitlines()
            ]
            rows[0]["font_judgment"]["preferred"] = list(DERIVE.FROZEN_ALIAS_ORDER)
            rows[0]["font_judgment"]["acceptable"] = []
            rows[0]["font_judgment"]["marginal"] = []
            rows[0]["font_judgment"]["unacceptable"] = []
            rows[0]["font_judgment"]["unrenderable"] = []
            write_jsonl(decisions, rows)
            with self.assertRaises(SystemExit):
                DERIVE.main(["validate", *common])


if __name__ == "__main__":
    unittest.main()
