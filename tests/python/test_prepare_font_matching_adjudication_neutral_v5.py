from __future__ import annotations

import copy
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "prepare_font_matching_adjudication_neutral_v5.py"
SPEC = importlib.util.spec_from_file_location(
    "prepare_font_matching_adjudication_neutral_v5_for_test", SCRIPT
)
assert SPEC and SPEC.loader
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)


def _sha(value: str) -> str:
    return PREP.derive.sha256_bytes(value.encode("utf-8"))


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PREP.derive.jsonl_bytes(rows))


def _neutral(
    assignment_id: str,
    sample_id: str,
    source_sha: str,
    visual_index: int,
) -> dict:
    return {
        "schema_version": PREP.source_seal.NEUTRAL_SCHEMA_VERSION,
        "record_type": PREP.source_seal.NEUTRAL_RECORD_TYPE,
        "assignment_id": assignment_id,
        "sample_id": sample_id,
        "stage": "adjudication",
        "source_only_card_sha256": source_sha,
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
        "rationale": "Visible source structure was independently reviewed.",
        "review_confidence": 0.96,
        "visual_review_index": visual_index,
    }


def _judgment(preferred: str) -> dict:
    return {
        "preferred": [preferred],
        "acceptable": [],
        "marginal": [],
        "unacceptable": [],
        "unrenderable": [],
        "none_acceptable": False,
    }


def _review(
    *,
    reviewer: str,
    eligibility: str = "font_signal_present",
    preferred: str = "ko-candidate-0000000000000001",
    confidence: float = 0.95,
) -> dict:
    return {
        "reviewer": reviewer,
        "eligibility": eligibility,
        "font_judgment": (
            _judgment(preferred) if eligibility == "font_signal_present" else None
        ),
        "confidence": confidence,
        "role": {"primary": "dialogue", "confidence": 0.95},
    }


def _binding(sample_id: str, suffix: str, order: int, stage: str) -> dict:
    return {
        "assignment": {
            "assignment_id": f"fmra-{suffix}-{stage}",
            "sample_id": sample_id,
            "stage": stage,
            "review_order": order,
        },
        "card": {
            "v5_public_ids": {
                "assignment_id": f"fmv5a-{suffix}-{stage}",
                "sample_id": f"fmv5s-{suffix}",
            },
            "v5_source_card": {"sha256": _sha(f"source:{suffix}:{stage}")},
        },
        # Canary fields from the private runtime binding must never be emitted.
        "alias_to_candidate_id": {"ko-candidate-canary": "gugi"},
        "prior_final_record_sha256": _sha(f"prior:{suffix}"),
    }


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.workspace = root / "workspace"
        self.workspace.mkdir(parents=True)
        (self.workspace / "private-bindings.jsonl").write_bytes(b"private-bindings\n")
        (self.workspace / "reviews.jsonl").write_bytes(b"sealed-reviews\n")
        self.output = root / "prepared" / "adjudication-neutral.jsonl"
        self.report = root / "prepared" / "adjudication-report.json"

        self.identities = {
            "primary-only": {
                "sample": "fm-primary-only",
                "suffix": "primary-only",
                "order": 1,
            },
            "double-trigger": {
                "sample": "fm-double-trigger",
                "suffix": "double-trigger",
                "order": 2,
            },
            "exception": {
                "sample": "fm-exception",
                "suffix": "exception",
                "order": 3,
            },
            "untriggered": {
                "sample": "fm-untriggered",
                "suffix": "untriggered",
                "order": 4,
            },
        }
        bindings: dict[str, dict[str, dict]] = {}
        reviews: dict[str, dict[str, dict]] = {}
        for name, value in self.identities.items():
            sample = value["sample"]
            suffix = value["suffix"]
            order = value["order"]
            bindings[sample] = {
                "primary": _binding(sample, suffix, order, "primary")
            }
            if name in {"double-trigger", "exception"}:
                bindings[sample]["secondary"] = _binding(
                    sample, suffix, order, "secondary"
                )
            if name == "primary-only":
                reviews[sample] = {
                    "primary": _review(
                        reviewer="reviewer-primary", confidence=0.70
                    )
                }
            elif name == "double-trigger":
                reviews[sample] = {
                    "primary": _review(
                        reviewer="reviewer-primary",
                        preferred="ko-candidate-0000000000000001",
                    ),
                    "secondary": _review(
                        reviewer="reviewer-secondary",
                        preferred="ko-candidate-0000000000000002",
                    ),
                }
            elif name == "exception":
                # No secondary review on purpose.  This exactly exercises the
                # ledger rule that a known eligibility exception is excluded
                # before secondary completeness is considered.
                reviews[sample] = {
                    "primary": _review(
                        reviewer="reviewer-primary",
                        eligibility="crop_needs_review",
                    )
                }
            else:
                reviews[sample] = {
                    "primary": _review(reviewer="reviewer-primary")
                }
        self.state = {
            "contract": {
                "mode": "production",
                "v5_derivation_required": True,
                "record_sha256": _sha("workspace-contract"),
            },
            "bindings_by_sample": bindings,
        }
        self.reviews = reviews

    def row(self, name: str, visual_index: int) -> dict:
        value = self.identities[name]
        suffix = value["suffix"]
        return _neutral(
            f"fmra-{suffix}-primary",
            value["sample"],
            _sha(f"source:{suffix}:primary"),
            visual_index,
        )

    def patches(self):
        return (
            mock.patch.object(PREP.catalog_ledger, "_load_workspace", return_value=self.state),
            mock.patch.object(
                PREP.catalog_ledger,
                "_validate_review_records",
                return_value=(self.reviews, {}),
            ),
        )

    def run(self, paths: list[Path]) -> dict:
        load_patch, review_patch = self.patches()
        with load_patch, review_patch:
            return PREP.prepare_files(
                workspace=self.workspace,
                neutral_annotations=paths,
                output=self.output,
                report=self.report,
            )


class PrepareAdjudicationNeutralV5Tests(unittest.TestCase):
    def test_filters_superset_and_reports_both_extra_categories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            first = fixture.root / "review-a.jsonl"
            second = fixture.root / "review-b.jsonl"
            _write_jsonl(
                first,
                [fixture.row("double-trigger", 1), fixture.row("exception", 2)],
            )
            # Independent files may each start their human review index at one.
            _write_jsonl(
                second,
                [fixture.row("untriggered", 1), fixture.row("primary-only", 2)],
            )

            summary = fixture.run([first, second])

            output_rows = PREP.catalog_ledger.read_jsonl(fixture.output)
            self.assertEqual(
                [
                    "fmra-primary-only-primary",
                    "fmra-double-trigger-primary",
                ],
                [row["assignment_id"] for row in output_rows],
            )
            self.assertEqual([1, 2], [row["visual_review_index"] for row in output_rows])
            report = PREP.catalog_ledger.read_json(fixture.report)
            PREP.catalog_ledger.validate_seal(report, "report")
            self.assertTrue(report["complete"])
            self.assertEqual([], report["triggered_missing_from_inputs"])
            self.assertEqual(
                ["fmra-exception-primary"],
                [
                    row["private_assignment_id"]
                    for row in report["supplied_extras"]["eligibility_exception"]
                ],
            )
            self.assertEqual(
                ["fmra-untriggered-primary"],
                [
                    row["private_assignment_id"]
                    for row in report["supplied_extras"]["untriggered"]
                ],
            )
            serialized = fixture.report.read_text(encoding="utf-8")
            self.assertNotIn("gugi", serialized)
            self.assertNotIn("font_judgment", serialized)
            self.assertNotIn("prior_final", serialized)
            self.assertEqual(2, summary["records"])

    def test_missing_primary_only_trigger_fails_without_any_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            supplied = fixture.root / "review-superset.jsonl"
            _write_jsonl(
                supplied,
                [
                    fixture.row("double-trigger", 1),
                    fixture.row("exception", 2),
                    fixture.row("untriggered", 3),
                ],
            )

            with self.assertRaises(PREP.AdjudicationNeutralPreparationError) as raised:
                fixture.run([supplied])

            diagnostic = json.loads(str(raised.exception))
            self.assertEqual("triggered_coverage_incomplete", diagnostic["error"])
            self.assertEqual(1, diagnostic["triggered_missing_count"])
            missing = diagnostic["triggered_missing_from_inputs"][0]
            self.assertEqual("fmra-primary-only-primary", missing["private_assignment_id"])
            self.assertFalse(missing["secondary_required"])
            self.assertFalse(fixture.output.exists())
            self.assertFalse(fixture.report.exists())
            self.assertFalse(fixture.output.parent.exists())

    def test_cli_returns_nonzero_and_publishes_nothing_on_missing_trigger(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            supplied = fixture.root / "review-superset.jsonl"
            _write_jsonl(supplied, [fixture.row("double-trigger", 1)])
            load_patch, review_patch = fixture.patches()
            stderr = io.StringIO()
            with load_patch, review_patch, contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as raised:
                    PREP.main(
                        [
                            "--workspace",
                            str(fixture.workspace),
                            "--neutral-annotations",
                            str(supplied),
                            "--output",
                            str(fixture.output),
                            "--report",
                            str(fixture.report),
                        ]
                    )
            self.assertNotEqual(0, raised.exception.code)
            self.assertIn("fmra-primary-only-primary", stderr.getvalue())
            self.assertFalse(fixture.output.exists())
            self.assertFalse(fixture.report.exists())

    def test_duplicate_across_human_files_fails_without_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            first = fixture.root / "review-a.jsonl"
            second = fixture.root / "review-b.jsonl"
            duplicate = fixture.row("double-trigger", 1)
            _write_jsonl(
                first,
                [duplicate, fixture.row("primary-only", 2)],
            )
            _write_jsonl(second, [copy.deepcopy(duplicate)])

            with self.assertRaisesRegex(
                PREP.AdjudicationNeutralPreparationError,
                "repeat private assignment",
            ):
                fixture.run([first, second])
            self.assertFalse(fixture.output.exists())
            self.assertFalse(fixture.report.exists())

    def test_identity_mismatch_or_unknown_extra_is_never_categorized(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            supplied = fixture.root / "review.jsonl"
            changed = fixture.row("double-trigger", 1)
            changed["source_only_card_sha256"] = _sha("another-source-card")
            _write_jsonl(
                supplied,
                [changed, fixture.row("primary-only", 2)],
            )
            with self.assertRaisesRegex(
                PREP.AdjudicationNeutralPreparationError,
                "source-only card identity",
            ):
                fixture.run([supplied])
            self.assertFalse(fixture.output.exists())
            self.assertFalse(fixture.report.exists())

            unknown = fixture.row("untriggered", 1)
            unknown["assignment_id"] = "fmra-outside-workspace-primary"
            _write_jsonl(supplied, [unknown, fixture.row("primary-only", 2)])
            with self.assertRaisesRegex(
                PREP.AdjudicationNeutralPreparationError,
                "cannot be safely categorized",
            ):
                fixture.run([supplied])
            self.assertFalse(fixture.output.exists())
            self.assertFalse(fixture.report.exists())


if __name__ == "__main__":
    unittest.main()
