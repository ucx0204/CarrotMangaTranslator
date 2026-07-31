from __future__ import annotations

import copy
import importlib.util
import math
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

try:
    import jsonschema
except ImportError:  # pragma: no cover - semantic validation remains mandatory
    jsonschema = None


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "font_matching_labels.py"
SPEC = importlib.util.spec_from_file_location("font_matching_labels", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load script: {SCRIPT_PATH}")
LABELS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = LABELS
SPEC.loader.exec_module(LABELS)


CATALOG_SHA = "a" * 64
RENDERER_SHA = "b" * 64
PAGE_SHA = "c" * 64
CARD_SHA = "d" * 64
CANDIDATES = ("nanum-gothic", "nanum-myeongjo", "gaegu", "dohyeon")
BUILT_IN_CANDIDATES = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
)


def make_samples(count: int, *, work_count: int = 3) -> list:
    return [
        LABELS.ReviewSample(
            sample_id=f"sample-{index:03d}",
            work_id=f"work-{index % work_count:02d}",
            source_page_sha256=(f"{index + 1:064x}"[-64:]),
            candidate_ids=CANDIDATES,
        )
        for index in range(count)
    ]


def core_label(sample, *, preferred: str | None = None) -> dict:
    preferred = preferred or sample.candidate_ids[0]
    return {
        "schema_version": LABELS.SCHEMA_VERSION,
        "sample_id": sample.sample_id,
        "work_id": sample.work_id,
        "source_page_sha256": sample.source_page_sha256,
        "role": {"primary": "dialogue", "confidence": 0.95},
        "source_style": {
            "serifness": 0.2,
            "weight": 0.5,
            "width": 0.5,
            "roundness": 0.4,
            "stroke_contrast": 0.2,
            "handwritten": 0.1,
            "angularity": 0.3,
            "irregularity": 0.1,
            "slant": 0.0,
            "energy": 0.3,
            "unknown_fields": [],
        },
        "treatment": {
            "orientation": "vertical",
            "outline": "none",
            "shadow": "none",
            "fill": "solid",
            "distortion": "none",
        },
        "font_judgment": {
            "preferred": [preferred],
            "acceptable": [],
            "marginal": [],
            "unacceptable": [
                candidate
                for candidate in sample.candidate_ids
                if candidate != preferred
            ],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": False,
        },
        "consistency": {
            "policy": "inherit_work_anchor",
            "reason_code": "ordinary_dialogue",
        },
    }


def review_record(
    sample,
    assignment,
    *,
    reviewer: str,
    confidence: float = 0.95,
    preferred: str | None = None,
    none_acceptable: bool = False,
    not_reviewed: tuple[str, ...] = (),
    flags: tuple[str, ...] = (),
) -> dict:
    record = core_label(sample, preferred=preferred)
    if none_acceptable:
        record["font_judgment"] = {
            "preferred": [],
            "acceptable": [],
            "marginal": [sample.candidate_ids[0]],
            "unacceptable": list(sample.candidate_ids[1:]),
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": True,
        }
        flags = tuple(dict.fromkeys((*flags, "none_acceptable")))
    if not_reviewed:
        judgment = record["font_judgment"]
        for candidate in not_reviewed:
            for tier in LABELS.FONT_TIERS:
                if candidate in judgment[tier]:
                    judgment[tier].remove(candidate)
            judgment["not_reviewed"].append(candidate)
    record.update(
        {
            "record_type": LABELS.REVIEW_RECORD_TYPE,
            "label_id": f"label-{assignment.stage}-{sample.sample_id}",
            "review": {
                "stage": assignment.stage,
                "assignment_id": assignment.assignment_id,
                "reviewer": reviewer,
                "reviewed_at": "2026-08-01T00:00:00Z",
                "catalog_version": assignment.catalog_version,
                "catalog_sha256": CATALOG_SHA,
                "renderer_hash": RENDERER_SHA,
                "review_card_sha256": CARD_SHA,
                "candidate_order_seed": assignment.candidate_order_seed,
                "candidate_order": list(assignment.candidate_order),
                "blind_first_pass": True,
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "confidence": confidence,
                "flags": list(flags),
            },
        }
    )
    return LABELS.seal_record(record)


def records_for(samples, assignments) -> list[dict]:
    sample_by_id = {sample.sample_id: sample for sample in samples}
    return [
        review_record(
            sample_by_id[assignment.sample_id],
            assignment,
            reviewer=(
                f"primary-{sample_by_id[assignment.sample_id].work_id}"
                if assignment.stage == "primary"
                else f"secondary-{sample_by_id[assignment.sample_id].work_id}"
            ),
        )
        for assignment in assignments
    ]


def final_record(sample, reviews: list[dict], *, kind: str) -> dict:
    record = copy.deepcopy(reviews[0])
    record.pop("label_id")
    record.pop("review")
    record.pop("record_sha256")
    record.update(
        {
            "record_type": LABELS.FINAL_RECORD_TYPE,
            "final_id": f"final-{sample.sample_id}",
            "resolution": {
                "kind": kind,
                "resolver": "final-adjudicator",
                "resolved_at": "2026-08-02T00:00:00Z",
                "source_label_ids": [review["label_id"] for review in reviews],
                "catalog_version": reviews[0]["review"]["catalog_version"],
                "catalog_sha256": CATALOG_SHA,
                "renderer_hash": RENDERER_SHA,
                "confidence": 0.98,
                "flags": [],
                "notes": "",
                "adjudication_evidence": None,
            },
        }
    )
    return LABELS.seal_record(record)


class FontMatchingLabelSchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.samples = make_samples(10, work_count=2)
        self.assignments = LABELS.build_blind_review_assignments(
            self.samples,
            catalog_version="font-face-manifest-v1",
            allocation_seed="unit-test-allocation",
            double_review_fraction=0.2,
        )

    @unittest.skipIf(jsonschema is None, "jsonschema is not installed")
    def test_public_json_schema_is_valid_and_accepts_both_record_types(self) -> None:
        schema = LABELS.label_json_schema()
        jsonschema.Draft202012Validator.check_schema(schema)
        assignment = self.assignments[0]
        sample = next(
            sample
            for sample in self.samples
            if sample.sample_id == assignment.sample_id
        )
        review = review_record(sample, assignment, reviewer="reviewer-a")
        final = final_record(sample, [review], kind="primary")
        validator = jsonschema.Draft202012Validator(schema)
        self.assertEqual([], list(validator.iter_errors(review)))
        self.assertEqual([], list(validator.iter_errors(final)))

    def test_semantic_schema_requires_complete_disjoint_candidate_partition(
        self,
    ) -> None:
        assignment = self.assignments[0]
        sample = next(
            sample
            for sample in self.samples
            if sample.sample_id == assignment.sample_id
        )
        record = review_record(sample, assignment, reviewer="reviewer-a")
        LABELS.validate_review_record(
            record, assignment=assignment, candidate_ids=sample.candidate_ids
        )

        overlap = copy.deepcopy(record)
        overlap["font_judgment"]["acceptable"].append(CANDIDATES[0])
        overlap = LABELS.seal_record(overlap)
        with self.assertRaisesRegex(LABELS.LabelValidationError, "occurs in both"):
            LABELS.validate_review_record(
                overlap, assignment=assignment, candidate_ids=sample.candidate_ids
            )

        missing = copy.deepcopy(record)
        missing["font_judgment"]["unacceptable"].pop()
        missing = LABELS.seal_record(missing)
        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "partition the complete candidate catalog"
        ):
            LABELS.validate_review_record(
                missing, assignment=assignment, candidate_ids=sample.candidate_ids
            )

    def test_all_fifteen_builtin_candidates_are_partitioned_exactly_once(self) -> None:
        sample = LABELS.ReviewSample(
            sample_id="sample-all-builtins",
            work_id="work-all-builtins",
            source_page_sha256=PAGE_SHA,
            candidate_ids=BUILT_IN_CANDIDATES,
        )
        assignment = LABELS.build_blind_review_assignments(
            [sample],
            catalog_version="font-face-manifest-v1",
            allocation_seed="all-builtins",
            double_review_fraction=0,
        )[0]
        record = review_record(sample, assignment, reviewer="reviewer-a")
        LABELS.validate_review_record(
            record,
            assignment=assignment,
            candidate_ids=BUILT_IN_CANDIDATES,
        )
        judgment = record["font_judgment"]
        partitioned = [
            candidate for tier in LABELS.FONT_TIERS for candidate in judgment[tier]
        ]
        self.assertEqual(15, len(partitioned))
        self.assertEqual(set(BUILT_IN_CANDIDATES), set(partitioned))

        incomplete = copy.deepcopy(record)
        incomplete["font_judgment"]["unacceptable"].pop()
        incomplete.update(LABELS.seal_record(incomplete))
        with self.assertRaisesRegex(
            LABELS.LabelValidationError,
            "partition the complete candidate catalog",
        ):
            LABELS.validate_review_record(
                incomplete,
                assignment=assignment,
                candidate_ids=BUILT_IN_CANDIDATES,
            )

    def test_none_acceptable_and_unknown_style_semantics_are_enforced(self) -> None:
        assignment = self.assignments[0]
        sample = next(
            sample
            for sample in self.samples
            if sample.sample_id == assignment.sample_id
        )
        record = review_record(
            sample,
            assignment,
            reviewer="reviewer-a",
            none_acceptable=True,
        )
        record["source_style"]["slant"] = None
        record["source_style"]["unknown_fields"] = ["slant"]
        record = LABELS.seal_record(record)
        LABELS.validate_review_record(
            record, assignment=assignment, candidate_ids=sample.candidate_ids
        )

        invalid = copy.deepcopy(record)
        invalid["font_judgment"]["preferred"] = [CANDIDATES[0]]
        invalid["font_judgment"]["marginal"] = []
        invalid = LABELS.seal_record(invalid)
        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "none_acceptable must be true exactly"
        ):
            LABELS.validate_review_record(
                invalid, assignment=assignment, candidate_ids=sample.candidate_ids
            )

        invalid_style = copy.deepcopy(record)
        invalid_style["source_style"]["slant"] = 0.2
        invalid_style = LABELS.seal_record(invalid_style)
        with self.assertRaisesRegex(LABELS.LabelValidationError, "must be null"):
            LABELS.validate_review_record(
                invalid_style,
                assignment=assignment,
                candidate_ids=sample.candidate_ids,
            )

    def test_blindness_assignment_and_content_hash_are_enforced(self) -> None:
        assignment = self.assignments[0]
        sample = next(
            sample
            for sample in self.samples
            if sample.sample_id == assignment.sample_id
        )
        record = review_record(sample, assignment, reviewer="reviewer-a")

        exposed = copy.deepcopy(record)
        exposed["review"]["font_names_visible"] = True
        exposed = LABELS.seal_record(exposed)
        with self.assertRaisesRegex(LABELS.LabelValidationError, "must be blind"):
            LABELS.validate_review_record(
                exposed, assignment=assignment, candidate_ids=sample.candidate_ids
            )

        tampered = copy.deepcopy(record)
        tampered["role"]["primary"] = "narration"
        with self.assertRaisesRegex(LABELS.LabelValidationError, "content binding"):
            LABELS.validate_review_record(
                tampered, assignment=assignment, candidate_ids=sample.candidate_ids
            )


class BlindReviewAssignmentTest(unittest.TestCase):
    def test_candidate_randomization_is_deterministic_and_input_order_independent(
        self,
    ) -> None:
        primary_seed = LABELS.candidate_order_seed(
            "sample-001",
            "primary",
            catalog_version="font-face-manifest-v1",
            allocation_seed="frozen-seed",
        )
        secondary_seed = LABELS.candidate_order_seed(
            "sample-001",
            "secondary",
            catalog_version="font-face-manifest-v1",
            allocation_seed="frozen-seed",
        )
        first = LABELS.deterministic_candidate_order(CANDIDATES, primary_seed)
        second = LABELS.deterministic_candidate_order(
            reversed(CANDIDATES), primary_seed
        )
        self.assertEqual(first, second)
        self.assertEqual(set(first), set(CANDIDATES))
        self.assertNotEqual(primary_seed, secondary_seed)
        self.assertNotEqual(
            first,
            LABELS.deterministic_candidate_order(CANDIDATES, secondary_seed),
        )

    def test_assignment_plan_has_exactly_one_primary_and_stratified_twenty_percent(
        self,
    ) -> None:
        samples = make_samples(25, work_count=5)
        first = LABELS.build_blind_review_assignments(
            samples,
            catalog_version="font-face-manifest-v1",
            allocation_seed="frozen-seed",
        )
        second = LABELS.build_blind_review_assignments(
            reversed(samples),
            catalog_version="font-face-manifest-v1",
            allocation_seed="frozen-seed",
        )
        self.assertEqual(first, second)
        counts = Counter((item.sample_id, item.stage) for item in first)
        self.assertTrue(all(count == 1 for count in counts.values()))
        self.assertEqual(25, sum(item.stage == "primary" for item in first))
        self.assertEqual(
            math.ceil(25 * 0.2), sum(item.stage == "secondary" for item in first)
        )
        secondary_works = {item.work_id for item in first if item.stage == "secondary"}
        self.assertEqual({f"work-{index:02d}" for index in range(5)}, secondary_works)
        self.assertTrue(all(item.blind_first_pass for item in first))
        self.assertTrue(all(not item.font_names_visible for item in first))
        self.assertTrue(all(not item.model_suggestions_visible for item in first))

    def test_assignment_serialization_detects_candidate_order_tampering(self) -> None:
        sample = make_samples(1, work_count=1)[0]
        assignment = LABELS.build_blind_review_assignments(
            [sample],
            catalog_version="font-face-manifest-v1",
            allocation_seed="frozen-seed",
            double_review_fraction=0,
        )[0]
        restored = LABELS.ReviewAssignment.from_mapping(assignment.as_dict())
        self.assertEqual(assignment, restored)
        tampered = assignment.as_dict()
        tampered["candidate_order"] = list(reversed(tampered["candidate_order"]))
        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "does not match candidate_order_seed"
        ):
            LABELS.ReviewAssignment.from_mapping(tampered)


class ExactlyOnceLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.samples = make_samples(10, work_count=2)
        self.assignments = LABELS.build_blind_review_assignments(
            self.samples,
            catalog_version="font-face-manifest-v1",
            allocation_seed="ledger-seed",
            double_review_fraction=0.2,
        )
        self.records = records_for(self.samples, self.assignments)

    def test_complete_review_ledger_reports_twenty_percent_and_no_queue(self) -> None:
        report = LABELS.validate_exactly_once_ledger(
            self.samples,
            self.assignments,
            self.records,
            minimum_double_review_fraction=0.2,
        )
        self.assertEqual(10, report.primary_review_count)
        self.assertEqual(2, report.secondary_review_count)
        self.assertEqual(0.2, report.double_review_fraction)
        self.assertEqual((), report.recalculation_queue)
        self.assertFalse(report.completion_ready)

    def test_explicit_low_confidence_flag_enters_queue_even_above_threshold(
        self,
    ) -> None:
        records = copy.deepcopy(self.records)
        flagged = next(
            record for record in records if record["review"]["stage"] == "primary"
        )
        flagged["review"]["flags"].append("low_confidence")
        flagged.update(LABELS.seal_record(flagged))
        report = LABELS.validate_exactly_once_ledger(
            self.samples,
            self.assignments,
            records,
        )
        queue = {item.sample_id: item.reasons for item in report.recalculation_queue}
        self.assertIn("low_confidence", queue[flagged["sample_id"]])

    def test_missing_duplicate_and_non_independent_reviews_are_rejected(self) -> None:
        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "cover every assignment exactly once"
        ):
            LABELS.validate_exactly_once_ledger(
                self.samples,
                self.assignments,
                self.records[:-1],
            )

        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "reviewed more than once"
        ):
            LABELS.validate_exactly_once_ledger(
                self.samples,
                self.assignments,
                [*self.records, self.records[0]],
            )

        same_reviewer = copy.deepcopy(self.records)
        secondary = next(
            record
            for record in same_reviewer
            if record["review"]["stage"] == "secondary"
        )
        primary = next(
            record
            for record in same_reviewer
            if record["sample_id"] == secondary["sample_id"]
            and record["review"]["stage"] == "primary"
        )
        secondary["review"]["reviewer"] = primary["review"]["reviewer"]
        secondary.update(LABELS.seal_record(secondary))
        with self.assertRaisesRegex(LABELS.LabelValidationError, "not independent"):
            LABELS.validate_exactly_once_ledger(
                self.samples,
                self.assignments,
                same_reviewer,
            )

    def test_recalculation_queue_includes_disagreement_none_low_confidence_and_recrop(
        self,
    ) -> None:
        records = copy.deepcopy(self.records)
        secondary = next(
            record for record in records if record["review"]["stage"] == "secondary"
        )
        secondary["font_judgment"]["preferred"] = [CANDIDATES[1]]
        secondary["font_judgment"]["unacceptable"].remove(CANDIDATES[1])
        secondary["font_judgment"]["unacceptable"].append(CANDIDATES[0])
        secondary.update(LABELS.seal_record(secondary))

        none_record = next(
            record
            for record in records
            if record["sample_id"] != secondary["sample_id"]
            and record["review"]["stage"] == "primary"
        )
        none_record["font_judgment"] = {
            "preferred": [],
            "acceptable": [],
            "marginal": [CANDIDATES[0]],
            "unacceptable": list(CANDIDATES[1:]),
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": True,
        }
        none_record["review"]["flags"].append("none_acceptable")
        none_record.update(LABELS.seal_record(none_record))

        low_record = next(
            record
            for record in records
            if record["sample_id"]
            not in {
                secondary["sample_id"],
                none_record["sample_id"],
            }
            and record["review"]["stage"] == "primary"
        )
        low_record["review"]["confidence"] = 0.5
        low_record.update(LABELS.seal_record(low_record))

        recrop_id = next(
            sample.sample_id
            for sample in self.samples
            if sample.sample_id
            not in {
                secondary["sample_id"],
                none_record["sample_id"],
                low_record["sample_id"],
            }
        )
        report = LABELS.validate_exactly_once_ledger(
            self.samples,
            self.assignments,
            records,
            manual_recrop_ids=[recrop_id],
        )
        queue = {item.sample_id: item.reasons for item in report.recalculation_queue}
        self.assertIn("font_tier_disagreement", queue[secondary["sample_id"]])
        self.assertIn("none_acceptable", queue[none_record["sample_id"]])
        self.assertIn("low_confidence", queue[low_record["sample_id"]])
        self.assertEqual(("manual_recrop",), queue[recrop_id])

    def test_final_ledger_is_exactly_once_and_queued_items_require_adjudication(
        self,
    ) -> None:
        by_sample: dict[str, list[dict]] = {}
        for record in self.records:
            by_sample.setdefault(record["sample_id"], []).append(record)
        finals = []
        for sample in self.samples:
            reviews = by_sample[sample.sample_id]
            kind = "blind_agreement" if len(reviews) == 2 else "primary"
            finals.append(final_record(sample, reviews, kind=kind))
        report = LABELS.validate_exactly_once_ledger(
            self.samples,
            self.assignments,
            self.records,
            final_records=finals,
        )
        self.assertTrue(report.completion_ready)
        self.assertEqual(len(self.samples), report.final_record_count)

        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "every sample exactly once"
        ):
            LABELS.validate_exactly_once_ledger(
                self.samples,
                self.assignments,
                self.records,
                final_records=finals[:-1],
            )

        queued_id = self.samples[0].sample_id
        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "requires adjudicated resolution"
        ):
            LABELS.validate_exactly_once_ledger(
                self.samples,
                self.assignments,
                self.records,
                final_records=finals,
                manual_recrop_ids=[queued_id],
            )

        corrected = copy.deepcopy(finals)
        queued_final = next(
            record for record in corrected if record["sample_id"] == queued_id
        )
        queued_final["resolution"]["kind"] = "adjudicated"
        queued_final["resolution"]["flags"] = ["manual_recrop_resolved"]
        adjudication_seed = "e" * 64
        queued_final["resolution"]["adjudication_evidence"] = {
            "review_card_sha256": "f" * 64,
            "candidate_order_seed": adjudication_seed,
            "candidate_order": list(
                LABELS.deterministic_candidate_order(CANDIDATES, adjudication_seed)
            ),
            "font_names_visible": True,
            "model_suggestions_visible": True,
        }
        queued_final.update(LABELS.seal_record(queued_final))
        report = LABELS.validate_exactly_once_ledger(
            self.samples,
            self.assignments,
            self.records,
            final_records=corrected,
            manual_recrop_ids=[queued_id],
        )
        self.assertTrue(report.completion_ready)

    def test_all_39_manual_recrops_require_and_record_adjudication(self) -> None:
        samples = make_samples(200, work_count=24)
        assignments = LABELS.build_blind_review_assignments(
            samples,
            catalog_version="font-face-manifest-v1",
            allocation_seed="recrop-39-seed",
            double_review_fraction=0.2,
        )
        reviews = records_for(samples, assignments)
        by_sample: dict[str, list[dict]] = {}
        for record in reviews:
            by_sample.setdefault(record["sample_id"], []).append(record)
        recrop_ids = [sample.sample_id for sample in samples[:39]]
        queue_report = LABELS.validate_exactly_once_ledger(
            samples,
            assignments,
            reviews,
            manual_recrop_ids=recrop_ids,
        )
        self.assertEqual(39, len(queue_report.recalculation_queue))
        self.assertTrue(
            all(
                item.reasons == ("manual_recrop",)
                for item in queue_report.recalculation_queue
            )
        )

        finals = []
        for sample in samples:
            sample_reviews = by_sample[sample.sample_id]
            kind = "blind_agreement" if len(sample_reviews) == 2 else "primary"
            finals.append(final_record(sample, sample_reviews, kind=kind))
        with self.assertRaisesRegex(
            LABELS.LabelValidationError, "requires adjudicated resolution"
        ):
            LABELS.validate_exactly_once_ledger(
                samples,
                assignments,
                reviews,
                final_records=finals,
                manual_recrop_ids=recrop_ids,
            )

        for record in finals:
            if record["sample_id"] not in recrop_ids:
                continue
            seed = LABELS.sha256_json(
                ["manual-recrop-adjudication", record["sample_id"]]
            )
            record["resolution"]["kind"] = "adjudicated"
            record["resolution"]["flags"] = ["manual_recrop_resolved"]
            record["resolution"]["adjudication_evidence"] = {
                "review_card_sha256": CARD_SHA,
                "candidate_order_seed": seed,
                "candidate_order": list(
                    LABELS.deterministic_candidate_order(CANDIDATES, seed)
                ),
                "font_names_visible": True,
                "model_suggestions_visible": True,
            }
            record.update(LABELS.seal_record(record))
        final_report = LABELS.validate_exactly_once_ledger(
            samples,
            assignments,
            reviews,
            final_records=finals,
            manual_recrop_ids=recrop_ids,
        )
        self.assertTrue(final_report.completion_ready)
        self.assertEqual(39, len(final_report.recalculation_queue))

    def test_cli_writes_deterministic_assignment_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            samples_path = root / "samples.jsonl"
            first_path = root / "first.jsonl"
            second_path = root / "second.jsonl"
            LABELS.write_jsonl(
                samples_path, (sample.as_dict() for sample in self.samples)
            )
            common = [
                "plan",
                "--samples",
                str(samples_path),
                "--catalog-version",
                "font-face-manifest-v1",
                "--allocation-seed",
                "cli-seed",
            ]
            self.assertEqual(0, LABELS.main([*common, "--output", str(first_path)]))
            self.assertEqual(0, LABELS.main([*common, "--output", str(second_path)]))
            self.assertEqual(first_path.read_bytes(), second_path.read_bytes())
            rows = LABELS.read_jsonl(first_path)
            self.assertEqual(12, len(rows))


if __name__ == "__main__":
    unittest.main()
