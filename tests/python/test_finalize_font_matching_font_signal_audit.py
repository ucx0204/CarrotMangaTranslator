from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "finalize_font_matching_font_signal_audit.py"
SPEC = importlib.util.spec_from_file_location("font_signal_audit_finalizer", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {SCRIPT}")
FINALIZER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FINALIZER
SPEC.loader.exec_module(FINALIZER)


def source_seal(core: dict) -> dict:
    output = dict(core)
    output["record_sha256"] = FINALIZER.sha256_bytes(
        FINALIZER.canonical_json_bytes(output) + b"\n"
    )
    return output


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_bytes(FINALIZER.jsonl_bytes(rows))


def rewrite_source_report(
    source: Path,
    audits: list[dict],
    assignments: list[dict],
    selections: list[dict],
) -> None:
    audit_payload = FINALIZER.jsonl_bytes(audits)
    assignment_payload = FINALIZER.jsonl_bytes(assignments)
    selection_payload = FINALIZER.jsonl_bytes(selections)
    (source / "font-signal-audit.jsonl").write_bytes(audit_payload)
    (source / "assignments.jsonl").write_bytes(assignment_payload)
    (source / "selection.jsonl").write_bytes(selection_payload)
    report = source_seal(
        {
            "schema_version": FINALIZER.SOURCE_SCHEMA,
            "record_type": "font_matching_catalog_delta_review_inputs_report",
            "contracts": {
                "font_signal_audit": {
                    "automatic_absent_classification_allowed": False,
                }
            },
            "outputs": {
                "font_signal_audit_sha256": FINALIZER.sha256_bytes(audit_payload),
                "assignments_sha256": FINALIZER.sha256_bytes(assignment_payload),
                "selection_sha256": FINALIZER.sha256_bytes(selection_payload),
            },
            "summary": {
                "font_signal_audit_count": FINALIZER.EXPECTED_AUDIT_COUNT,
                "font_signal_audit_sample_ids_sha256": FINALIZER.sorted_ids_sha256(
                    row["sample_id"] for row in audits
                ),
            },
        }
    )
    (source / "report.json").write_bytes(FINALIZER.pretty_json_bytes(report))


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.source = root / "rescue-v3"
        self.source.mkdir(parents=True)
        self.audits: list[dict] = []
        self.assignments: list[dict] = []
        self.selections: list[dict] = []
        for index in range(1, FINALIZER.EXPECTED_AUDIT_COUNT + 1):
            sample_id = f"fm_{index:024x}"
            page_sha = FINALIZER.sha256_bytes(f"page:{index}".encode())
            self.audits.append(
                source_seal(
                    {
                        "schema_version": FINALIZER.SOURCE_SCHEMA,
                        "record_type": FINALIZER.SOURCE_RECORD_TYPE,
                        "audit_order": index,
                        "sample_id": sample_id,
                        "work_id": f"work-{index % 4}",
                        "chapter_id": f"chapter-{index}",
                        "page_id": f"page-{index}",
                        "source_page_sha256": page_sha,
                        "status": "pending_human_audit",
                        "decision_contract": {
                            "allowed_human_outcomes": sorted(
                                FINALIZER.ALLOWED_OUTCOMES
                            ),
                            "automatic_absent_classification_allowed": False,
                            "new_candidate_review_blocked_until_resolved": True,
                        },
                        "provenance": {
                            "training_sample_record_sha256": FINALIZER.sha256_bytes(
                                f"training:{index}".encode()
                            ),
                            "prior_final_record_sha256": FINALIZER.sha256_bytes(
                                f"prior:{index}".encode()
                            ),
                            "qa_overlay": False,
                            "synthetic": False,
                        },
                        "evidence": {
                            "source_page_locator": {
                                "file_sha256": page_sha,
                                "provenance": "real_preserved",
                            },
                            "views": {
                                "raw_224": {
                                    "status": "derivable",
                                    "source_native": {
                                        "file_sha256": FINALIZER.sha256_bytes(
                                            f"raw:{index}".encode()
                                        ),
                                        "provenance": "real_preserved",
                                    },
                                },
                                "context_224": {
                                    "status": "available",
                                    "file_sha256": FINALIZER.sha256_bytes(
                                        f"context:{index}".encode()
                                    ),
                                },
                                "glyph_224": {
                                    "status": "available",
                                    "file_sha256": FINALIZER.sha256_bytes(
                                        f"glyph:{index}".encode()
                                    ),
                                },
                            },
                        },
                        "review_surface": {
                            "font_names_visible": False,
                            "model_suggestions_visible": False,
                            "prior_tiers_visible": False,
                            "split_visible": False,
                        },
                    }
                )
            )
            self.assignments.append(
                {
                    "schema_version": 1,
                    "record_type": "manga_font_label_assignment",
                    "assignment_id": f"fmra-{index:032x}",
                    "sample_id": sample_id,
                    "stage": "primary",
                    "split_visible": False,
                    "release_state": "blocked_pending_font_signal_audit",
                }
            )
            self.selections.append(
                source_seal(
                    {
                        "schema_version": FINALIZER.SOURCE_SCHEMA,
                        "record_type": "font_catalog_delta_review_selection",
                        "sample_id": sample_id,
                        "provenance": {
                            "qa_overlay": False,
                            "synthetic": False,
                        },
                        "review_surface": {"split_visible": False},
                    }
                )
            )
        self.assignments.append(
            {
                "schema_version": 1,
                "record_type": "manga_font_label_assignment",
                "assignment_id": "fmra-ffffffffffffffffffffffffffffffff",
                "sample_id": "fm_not_audited",
                "stage": "primary",
                "split_visible": False,
                "release_state": "ready",
            }
        )
        self.selections.append(
            source_seal(
                {
                    "schema_version": FINALIZER.SOURCE_SCHEMA,
                    "record_type": "font_catalog_delta_review_selection",
                    "sample_id": "fm_not_audited",
                    "provenance": {"qa_overlay": False, "synthetic": False},
                    "review_surface": {"split_visible": False},
                }
            )
        )
        rewrite_source_report(
            self.source, self.audits, self.assignments, self.selections
        )
        self.decisions = self.make_decisions()
        self.decisions_path = root / "decisions.jsonl"
        write_jsonl(self.decisions_path, self.decisions)

    def make_decisions(self) -> list[dict]:
        outcomes = sorted(FINALIZER.ALLOWED_OUTCOMES)
        return [
            {
                "sample_id": audit["sample_id"],
                "source_audit_record_sha256": audit["record_sha256"],
                "outcome": outcomes[(index - 1) % len(outcomes)],
                "rationale": f"원문 페이지와 세 가지 크롭을 직접 확인한 근거 {index}",
                "reviewer": "codex-human-visual-v1",
                "reviewed_at": "2026-08-01T12:34:56+09:00",
                "decision_source": "human_visual_review",
                "evidence_checked": list(reversed(FINALIZER.REQUIRED_EVIDENCE)),
            }
            for index, audit in enumerate(self.audits, 1)
        ]

    def refresh(self) -> None:
        rewrite_source_report(
            self.source, self.audits, self.assignments, self.selections
        )
        write_jsonl(self.decisions_path, self.decisions)


class FontSignalAuditFinalizerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fixture = Fixture(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_finalizes_deterministically_without_touching_source(self) -> None:
        source_sha = FINALIZER.sha256_file(
            self.fixture.source / "font-signal-audit.jsonl"
        )
        output_a = self.root / "sealed-a"
        output_b = self.root / "sealed-b"
        for output in (output_a, output_b):
            args = FINALIZER.build_argument_parser().parse_args(
                [
                    "finalize",
                    "--rescue-inputs",
                    str(self.fixture.source),
                    "--decisions",
                    str(self.fixture.decisions_path),
                    "--output",
                    str(output),
                ]
            )
            self.assertEqual(FINALIZER.finalize(args), 0)
            report = FINALIZER.validate_output(self.fixture.source, output)
            self.assertEqual(report["summary"]["audit_count"], 62)
        self.assertEqual(
            source_sha,
            FINALIZER.sha256_file(self.fixture.source / "font-signal-audit.jsonl"),
        )
        for name in (
            FINALIZER.LEDGER_FILE,
            FINALIZER.GATED_ASSIGNMENTS_FILE,
            FINALIZER.REVIEW_READY_ASSIGNMENTS_FILE,
            FINALIZER.REVIEW_READY_INVENTORY_FILE,
            FINALIZER.REPORT_FILE,
            FINALIZER.MARKER_FILE,
        ):
            self.assertEqual(
                (output_a / name).read_bytes(), (output_b / name).read_bytes()
            )

        ledger = FINALIZER.read_jsonl(output_a / FINALIZER.LEDGER_FILE, "ledger")
        self.assertTrue(all("split" not in row for row in ledger))
        self.assertTrue(
            all(row["decision_source"] == "human_visual_review" for row in ledger)
        )
        self.assertTrue(all(row["reviewed_at"].endswith("Z") for row in ledger))
        gated = FINALIZER.read_jsonl(
            output_a / FINALIZER.GATED_ASSIGNMENTS_FILE, "gated"
        )
        outcomes = {row["sample_id"]: row["outcome"] for row in ledger}
        for row in gated:
            if row["sample_id"] in outcomes:
                self.assertEqual(
                    row["release_state"] == "ready",
                    outcomes[row["sample_id"]] == "font_signal_present",
                )
        self.assertEqual(gated[-1], self.fixture.assignments[-1])
        review_ready = FINALIZER.read_jsonl(
            output_a / FINALIZER.REVIEW_READY_ASSIGNMENTS_FILE, "review ready"
        )
        self.assertEqual(
            review_ready,
            [row for row in gated if row["release_state"] == "ready"],
        )
        self.assertFalse(any(row["release_state"] != "ready" for row in review_ready))
        inventory = FINALIZER.read_jsonl(
            output_a / FINALIZER.REVIEW_READY_INVENTORY_FILE, "ready inventory"
        )
        ready_primary_ids = {
            row["sample_id"] for row in review_ready if row["stage"] == "primary"
        }
        self.assertEqual(
            [row["sample_id"] for row in inventory],
            [
                row["sample_id"]
                for row in self.fixture.selections
                if row["sample_id"] in ready_primary_ids
            ],
        )

    def test_rejects_missing_duplicate_and_extra_decisions(self) -> None:
        audits, *_rest = FINALIZER.load_source(self.fixture.source)
        cases = {
            "missing": self.fixture.decisions[:-1],
            "duplicate": self.fixture.decisions + [dict(self.fixture.decisions[0])],
            "extra": self.fixture.decisions[:-1]
            + [
                {
                    **self.fixture.decisions[-1],
                    "sample_id": "fm_extra",
                }
            ],
        }
        for name, decisions in cases.items():
            with self.subTest(name=name):
                path = self.root / f"{name}.jsonl"
                write_jsonl(path, decisions)
                with self.assertRaises(FINALIZER.FontSignalAuditError):
                    FINALIZER.load_decisions(path, audits)

    def test_rejects_auto_wrong_binding_bad_rationale_and_incomplete_evidence(
        self,
    ) -> None:
        audits, *_rest = FINALIZER.load_source(self.fixture.source)
        mutations = {
            "auto": {"decision_source": "automatic_heuristic"},
            "wrong_binding": {"source_audit_record_sha256": "a" * 64},
            "punctuation_rationale": {"rationale": "...!?"},
            "incomplete_evidence": {
                "evidence_checked": ["source_page", "raw_224", "context_224"]
            },
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name):
                decisions = [dict(row) for row in self.fixture.decisions]
                decisions[0].update(mutation)
                path = self.root / f"bad-{name}.jsonl"
                write_jsonl(path, decisions)
                with self.assertRaises(FINALIZER.FontSignalAuditError):
                    FINALIZER.load_decisions(path, audits)

    def test_rejects_qa_synthetic_and_altered_page_provenance(self) -> None:
        for name in ("qa_overlay", "synthetic", "page_binding"):
            with self.subTest(name=name):
                fixture = Fixture(self.root / name)
                row = dict(fixture.audits[0])
                row.pop("record_sha256")
                if name in {"qa_overlay", "synthetic"}:
                    row["provenance"] = dict(row["provenance"])
                    row["provenance"][name] = True
                else:
                    row["source_page_sha256"] = "b" * 64
                fixture.audits[0] = source_seal(row)
                rewrite_source_report(
                    fixture.source,
                    fixture.audits,
                    fixture.assignments,
                    fixture.selections,
                )
                with self.assertRaises(FINALIZER.FontSignalAuditError):
                    FINALIZER.load_source(fixture.source)

    def test_gate_validator_never_releases_non_present_outcomes(self) -> None:
        audits, assignments, selections, _report, hashes = FINALIZER.load_source(
            self.fixture.source
        )
        decisions = FINALIZER.load_decisions(self.fixture.decisions_path, audits)
        ledger = FINALIZER.build_ledger(audits, decisions, hashes)
        gated = FINALIZER.gate_assignments(assignments, ledger)
        blocked_index = next(
            index
            for index, row in enumerate(gated)
            if decisions[row["sample_id"]]["outcome"] != "font_signal_present"
        )
        gated[blocked_index] = dict(gated[blocked_index])
        gated[blocked_index]["release_state"] = "ready"
        with self.assertRaises(FINALIZER.FontSignalAuditError):
            FINALIZER.validate_gated_assignments(assignments, gated, ledger)

        safe_gated = FINALIZER.gate_assignments(assignments, ledger)
        review_ready = FINALIZER.project_review_ready_assignments(safe_gated)
        blocked = next(row for row in safe_gated if row["release_state"] != "ready")
        with self.assertRaisesRegex(
            FINALIZER.FontSignalAuditError, "ready-only projection"
        ):
            FINALIZER.validate_review_ready_assignments(
                safe_gated, review_ready + [blocked]
            )

        inventory = FINALIZER.project_review_ready_inventory(selections, review_ready)
        with self.assertRaisesRegex(
            FINALIZER.FontSignalAuditError, "source-selection projection"
        ):
            FINALIZER.validate_review_ready_inventory(
                selections, review_ready, inventory[:-1]
            )

    def test_overwrite_refuses_unmanaged_or_changed_output(self) -> None:
        output = self.root / "sealed"
        argv = [
            "finalize",
            "--rescue-inputs",
            str(self.fixture.source),
            "--decisions",
            str(self.fixture.decisions_path),
            "--output",
            str(output),
        ]
        args = FINALIZER.build_argument_parser().parse_args(argv)
        self.assertEqual(FINALIZER.finalize(args), 0)
        unrelated = output / "do-not-delete.txt"
        unrelated.write_text("user data", encoding="utf-8")
        overwrite_args = FINALIZER.build_argument_parser().parse_args(
            argv + ["--overwrite"]
        )
        with self.assertRaisesRegex(FINALIZER.FontSignalAuditError, "unmanaged files"):
            FINALIZER.finalize(overwrite_args)
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "user data")

    def test_rejects_source_split_disclosure(self) -> None:
        self.fixture.assignments[0]["split"] = "test"
        rewrite_source_report(
            self.fixture.source,
            self.fixture.audits,
            self.fixture.assignments,
            self.fixture.selections,
        )
        with self.assertRaisesRegex(FINALIZER.FontSignalAuditError, "split secrecy"):
            FINALIZER.load_source(self.fixture.source)


if __name__ == "__main__":
    unittest.main()
