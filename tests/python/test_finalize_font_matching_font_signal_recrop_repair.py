from __future__ import annotations

import csv
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from tests.python.test_build_font_matching_font_signal_recrop_repair import (
    Fixture as ProposalFixture,
)
from tests.python.test_build_font_matching_font_signal_recrop_repair import (
    REPAIR as PROPOSAL_BUILDER,
)


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "finalize_font_matching_font_signal_recrop_repair.py"
SPEC = importlib.util.spec_from_file_location("font_signal_recrop_finalizer", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
FINALIZE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FINALIZE
SPEC.loader.exec_module(FINALIZE)
V2 = FINALIZE.v2


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_bytes(FINALIZE.jsonl_bytes(rows))


class Fixture:
    def __init__(self, root: Path) -> None:
        self.prior = ProposalFixture(root)
        self._add_consensus_accept_fixture()
        self.proposal_root = self.prior.output
        self.v1_primary = self.proposal_root / PROPOSAL_BUILDER.LEDGER_FILE
        self.v1_secondary = self.proposal_root / V2.SECONDARY_SIDECAR_FILE
        with redirect_stdout(io.StringIO()):
            argv = self.prior.argv("build")
            argv[-1] = "3"
            result = PROPOSAL_BUILDER.main(argv)
        if result != 0:
            raise AssertionError("could not build v1 proposal fixture")
        self._complete_v1_primary()
        self._write_v1_secondary()

        self.v2_root = root / "adjudication-v2"
        self.v2_ledger = self.v2_root / V2.REVISION_LEDGER_FILE
        self.revision_secondary = self.v2_root / FINALIZE.SECONDARY_SIDECAR_FILE
        with redirect_stdout(io.StringIO()):
            result = V2.main(self.v2_argv("build"))
        if result != 0:
            raise AssertionError("could not build v2 adjudication fixture")
        self._complete_v2_ledger()
        self._write_revision_secondary()
        self.output = root / "final-v3"

    def _add_consensus_accept_fixture(self) -> None:
        sample_id = "fm_prior_accept"
        self.prior.sample_ids = (
            "fm_repairable",
            "fm_terminal",
            sample_id,
        )
        page = self.prior._page(sample_id, 2)
        master = self.prior._master(sample_id, page)
        audit = self.prior._audit(sample_id, master)
        human = self.prior._human(sample_id, audit)
        plan = self.prior._plan(sample_id, action="recrop")
        for path, row in (
            (self.prior.master, master),
            (self.prior.audit, audit),
            (self.prior.human, human),
            (self.prior.plan, plan),
        ):
            rows = read_jsonl(path)
            rows.append(row)
            path.write_bytes(PROPOSAL_BUILDER.jsonl_bytes(rows))

    def _complete_v1_primary(self) -> None:
        with self.v1_primary.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = list(reader.fieldnames or [])
            rows = [dict(row) for row in reader]
        for row in rows:
            if row["sample_id"] == "fm_repairable":
                row["decision"] = "revise_bbox"
                row["revision_bbox_px"] = "[14,10,62,82]"
                row["notes"] = "Use the complete fixture text with safe margins."
            elif row["sample_id"] == "fm_prior_accept":
                row["decision"] = "accept_proposal"
                row["revision_bbox_px"] = ""
                row["notes"] = "The existing crop is clean and complete."
            else:
                row["decision"] = "confirm_terminal"
                row["revision_bbox_px"] = ""
                row["notes"] = "The fixture promotional overlay is terminal."
            row["reviewer"] = "fixture-primary-reviewer"
            row["reviewed_at"] = "2026-08-01T02:00:00Z"
        with self.v1_primary.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    def _write_v1_secondary(self) -> None:
        proposals = {
            row["sample_id"]: row
            for row in read_jsonl(self.proposal_root / PROPOSAL_BUILDER.PROPOSALS_FILE)
        }
        rows: list[dict[str, Any]] = []
        for sample_id in sorted(proposals):
            proposal = proposals[sample_id]
            if sample_id == "fm_repairable":
                decision = "revise"
            elif proposal["action"] == "terminal_replacement":
                decision = "approve_terminal"
            else:
                decision = "approve_recrop"
            rows.append(
                {
                    "sample_id": sample_id,
                    "proposal_record_sha256": proposal["record_sha256"],
                    "card_sha256": proposal["direct_preview"]["file_sha256"],
                    "decision": decision,
                    "confidence": 0.99,
                    "rationale": "Independent fixture review of all source views.",
                    "reviewer": "fixture-secondary-reviewer",
                    "viewed_direct_preview_original": True,
                    "viewed_source_context_original": True,
                    "viewed_source_page_original": True,
                }
            )
        write_jsonl(self.v1_secondary, rows)

    def v2_argv(self, command: str) -> list[str]:
        return [
            command,
            "--proposal-root",
            str(self.proposal_root),
            "--primary-ledger",
            str(self.v1_primary),
            "--secondary-review",
            str(self.v1_secondary),
            "--library-root",
            str(self.prior.library),
            "--output-root",
            str(self.v2_root),
            "--expected-targets",
            "3",
            "--expected-accepts",
            "1",
            "--expected-terminal",
            "1",
            "--expected-revisions",
            "1",
            "--expected-disagreements",
            "0",
        ]

    def _complete_v2_ledger(self) -> None:
        with self.v2_ledger.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = list(reader.fieldnames or [])
            rows = [dict(row) for row in reader]
        for row in rows:
            row["decision"] = "accept_revision"
            row["next_revision_bbox_px"] = ""
            row["reviewer"] = "fixture-root-revision-reviewer"
            row["reviewed_at"] = "2026-08-01T03:00:00Z"
            row["notes"] = "The revised fixture crop is complete and clean."
        with self.v2_ledger.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    def _write_revision_secondary(self) -> None:
        revisions = read_jsonl(self.v2_root / V2.REVISIONS_FILE)
        rows: list[dict[str, Any]] = []
        for revision in revisions:
            rows.append(
                {
                    "schema_version": FINALIZE.SECONDARY_SCHEMA_VERSION,
                    "reviewer": "fixture-independent-revision-reviewer",
                    "sample_id": revision["sample_id"],
                    "revision_bbox_px": revision["revision_bbox_px"],
                    "decision": "approve_revision",
                    "reason": "Independent review confirms complete clean text.",
                    "directly_viewed": [
                        {
                            "kind": "revision_preview",
                            "path": revision["direct_preview"]["path"],
                            "sha256": revision["direct_preview"]["file_sha256"],
                        },
                        {
                            "kind": "revision_context",
                            "path": revision["revision_context"]["path"],
                            "sha256": revision["revision_context"]["file_sha256"],
                        },
                        {
                            "kind": "full_page",
                            "path": revision["full_page_binding"]["path"],
                            "sha256": revision["full_page_binding"]["file_sha256"],
                        },
                    ],
                    "direct_view_count": 3,
                    "promotion_performed": False,
                }
            )
        write_jsonl(self.revision_secondary, rows)

    def argv(self, command: str) -> list[str]:
        return [
            command,
            "--adjudication-root",
            str(self.v2_root),
            "--completed-revision-ledger",
            str(self.v2_ledger),
            "--secondary-revision-review",
            str(self.revision_secondary),
            "--library-root",
            str(self.prior.library),
            "--output-root",
            str(self.output),
            "--expected-targets",
            "3",
            "--expected-prior-accepts",
            "1",
            "--expected-revisions",
            "1",
            "--expected-exclusions",
            "1",
        ]


class FontSignalRecropFinalizationTests(unittest.TestCase):
    def test_builds_prior_and_revision_accepts_plus_terminal_exclusion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, FINALIZE.main(fixture.argv("build")))
                self.assertEqual(0, FINALIZE.main(fixture.argv("validate")))

            report = json.loads(
                (fixture.output / FINALIZE.REPORT_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(2, report["counts"]["accepted_repairs"])
            self.assertEqual(1, report["counts"]["terminal_exclusions"])
            self.assertEqual(
                {
                    "double_review_consensus_prior_recrop": 1,
                    "double_review_consensus_revision": 1,
                },
                report["counts"]["acceptance_basis"],
            )
            self.assertEqual(0, report["counts"]["unresolved_or_disagreed"])
            accepted = {
                row["sample_id"]: row
                for row in read_jsonl(fixture.output / FINALIZE.ACCEPTED_FILE)
            }
            self.assertEqual({"fm_prior_accept", "fm_repairable"}, set(accepted))
            self.assertTrue(
                all(row["training_eligible"] is True for row in accepted.values())
            )
            self.assertTrue(
                all(
                    row["merged_into_existing_dataset"] is False
                    for row in accepted.values()
                )
            )
            exclusions = read_jsonl(fixture.output / FINALIZE.EXCLUSIONS_FILE)
            self.assertEqual(1, len(exclusions))
            self.assertTrue(exclusions[0]["excluded_from_downstream_training"])

            proposals = {
                row["sample_id"]: row
                for row in read_jsonl(
                    fixture.v2_root / V2.PRIOR_PROPOSALS_EVIDENCE_FILE
                )
            }
            revisions = {
                row["sample_id"]: row
                for row in read_jsonl(fixture.v2_root / V2.REVISIONS_FILE)
            }
            for sample_id, record in accepted.items():
                proposal = proposals[sample_id]
                bbox = (
                    revisions[sample_id]["revision_bbox_px"]
                    if sample_id in revisions
                    else proposal["recrop_bbox_px"]
                )
                source = fixture.prior.library / Path(proposal["source_page"]["path"])
                with Image.open(source) as opened:
                    decoded = ImageOps.exif_transpose(opened).convert("RGB")
                    decoded.load()
                try:
                    expected = PROPOSAL_BUILDER._png_crop(decoded, tuple(bbox))
                finally:
                    decoded.close()
                asset = fixture.output / Path(record["accepted_image"]["path"])
                self.assertEqual(expected, asset.read_bytes())

    def test_incomplete_root_revision_review_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with fixture.v2_ledger.open(
                "r", encoding="utf-8-sig", newline=""
            ) as handle:
                reader = csv.DictReader(handle)
                fieldnames = list(reader.fieldnames or [])
                rows = [dict(row) for row in reader]
            rows[0]["decision"] = ""
            with fixture.v2_ledger.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(
                    handle, fieldnames=fieldnames, lineterminator="\n"
                )
                writer.writeheader()
                writer.writerows(rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_secondary_disagreement_and_stale_view_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            rows = read_jsonl(fixture.revision_secondary)
            rows[0]["decision"] = "revise_bbox"
            write_jsonl(fixture.revision_secondary, rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(fixture.argv("build")))

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            rows = read_jsonl(fixture.revision_secondary)
            rows[0]["directly_viewed"][0]["sha256"] = "0" * 64
            write_jsonl(fixture.revision_secondary, rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(fixture.argv("build")))

    def test_tampered_v2_nonledger_asset_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            preview = fixture.v2_root / V2.PREVIEW_DIR / "fm_repairable.png"
            preview.write_bytes(preview.read_bytes() + b"tamper")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(fixture.argv("build")))

    def test_final_output_is_immutable_and_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, FINALIZE.main(fixture.argv("build")))
            report_before = (fixture.output / FINALIZE.REPORT_FILE).read_bytes()
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(fixture.argv("build")))
            self.assertEqual(
                report_before,
                (fixture.output / FINALIZE.REPORT_FILE).read_bytes(),
            )

    def test_validation_rejects_tampered_accepted_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, FINALIZE.main(fixture.argv("build")))
            image = fixture.output / FINALIZE.ACCEPTED_IMAGE_DIR / "fm_repairable.png"
            image.write_bytes(image.read_bytes() + b"tamper")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(fixture.argv("validate")))

    def test_rejects_output_nested_inside_v2(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            argv = fixture.argv("build")
            output_index = argv.index("--output-root") + 1
            nested = fixture.v2_root / "forbidden-final-v3"
            argv[output_index] = str(nested)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, FINALIZE.main(argv))
            self.assertFalse(nested.exists())


if __name__ == "__main__":
    unittest.main()
