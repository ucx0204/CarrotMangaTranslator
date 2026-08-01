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
SCRIPT = SCRIPTS / "adjudicate_font_matching_font_signal_recrop_repair.py"
SPEC = importlib.util.spec_from_file_location("font_signal_recrop_adjudication", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ADJUDICATE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ADJUDICATE
SPEC.loader.exec_module(ADJUDICATE)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_bytes(ADJUDICATE.jsonl_bytes(rows))


class Fixture:
    def __init__(self, root: Path) -> None:
        self.prior = ProposalFixture(root)
        with redirect_stdout(io.StringIO()):
            result = PROPOSAL_BUILDER.main(self.prior.argv("build"))
        if result != 0:
            raise AssertionError("could not build prior proposal fixture")
        self.proposal_root = self.prior.output
        self.primary = self.proposal_root / PROPOSAL_BUILDER.LEDGER_FILE
        self.secondary = self.proposal_root / ADJUDICATE.SECONDARY_SIDECAR_FILE
        self.output = root / "adjudication-v2"
        self._complete_primary()
        self._write_secondary()

    def _complete_primary(self) -> None:
        with self.primary.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = list(reader.fieldnames or [])
            rows = [dict(row) for row in reader]
        for row in rows:
            sample_id = row["sample_id"]
            if sample_id == "fm_repairable":
                row["decision"] = "revise_bbox"
                row["revision_bbox_px"] = "[14,10,62,82]"
                row["notes"] = "Tighten the complete fixture text with safe margins."
            else:
                row["decision"] = "confirm_terminal"
                row["revision_bbox_px"] = ""
                row["notes"] = "Fixture promotional overlay is terminal."
            row["reviewer"] = "fixture-primary-reviewer"
            row["reviewed_at"] = "2026-08-01T02:00:00Z"
        with self.primary.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    def _write_secondary(self) -> None:
        proposals = {
            row["sample_id"]: row
            for row in read_jsonl(self.proposal_root / PROPOSAL_BUILDER.PROPOSALS_FILE)
        }
        rows: list[dict[str, Any]] = []
        for sample_id in sorted(proposals):
            proposal = proposals[sample_id]
            decision = (
                "revise" if proposal["action"] == "recrop" else "approve_terminal"
            )
            rows.append(
                {
                    "sample_id": sample_id,
                    "proposal_record_sha256": proposal["record_sha256"],
                    "card_sha256": proposal["direct_preview"]["file_sha256"],
                    "decision": decision,
                    "confidence": 0.99,
                    "rationale": "Independent fixture review of preview, context, and page.",
                    "reviewer": "fixture-secondary-reviewer",
                    "viewed_direct_preview_original": True,
                    "viewed_source_context_original": True,
                    "viewed_source_page_original": True,
                }
            )
        write_jsonl(self.secondary, rows)

    def argv(self, command: str) -> list[str]:
        return [
            command,
            "--proposal-root",
            str(self.proposal_root),
            "--primary-ledger",
            str(self.primary),
            "--secondary-review",
            str(self.secondary),
            "--library-root",
            str(self.prior.library),
            "--output-root",
            str(self.output),
            "--expected-targets",
            "2",
            "--expected-accepts",
            "0",
            "--expected-terminal",
            "1",
            "--expected-revisions",
            "1",
            "--expected-disagreements",
            "0",
        ]


class FontSignalRecropAdjudicationTests(unittest.TestCase):
    def test_builds_sealed_pending_revision_and_validates_determinism(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("build")))
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("validate")))

            report = json.loads(
                (fixture.output / ADJUDICATE.REPORT_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(1, report["counts"]["revision_previews_pending"])
            self.assertEqual(0, report["counts"]["promoted"])
            self.assertFalse(
                report["next_step"]["promotion_permitted_after_this_artifact"]
            )
            revisions = read_jsonl(fixture.output / ADJUDICATE.REVISIONS_FILE)
            self.assertEqual(1, len(revisions))
            revision = revisions[0]
            self.assertEqual("pending_direct_visual_review", revision["status"])
            self.assertFalse(revision["training_eligible"])
            self.assertFalse(revision["promotion_allowed"])
            self.assertFalse(revision["direct_preview"]["qa_overlay"])
            self.assertFalse(revision["direct_preview"]["synthetic"])
            self.assertFalse(revision["direct_preview"]["generated"])

            proposal = read_jsonl(
                fixture.proposal_root / PROPOSAL_BUILDER.PROPOSALS_FILE
            )[0]
            source = fixture.prior.library / Path(proposal["source_page"]["path"])
            with Image.open(source) as opened:
                decoded = ImageOps.exif_transpose(opened).convert("RGB")
                decoded.load()
            try:
                expected = PROPOSAL_BUILDER._png_crop(
                    decoded, tuple(revision["revision_bbox_px"])
                )
            finally:
                decoded.close()
            preview_path = fixture.output / Path(revision["direct_preview"]["path"])
            self.assertEqual(expected, preview_path.read_bytes())

            adjudications = {
                row["sample_id"]: row
                for row in read_jsonl(fixture.output / ADJUDICATE.ADJUDICATIONS_FILE)
            }
            self.assertEqual(
                "pending_direct_visual_review",
                adjudications["fm_repairable"]["status"],
            )
            self.assertEqual(
                "review_complete_withheld_not_promoted",
                adjudications["fm_terminal"]["status"],
            )
            ledger = (fixture.output / ADJUDICATE.REVISION_LEDGER_FILE).read_text(
                encoding="utf-8"
            )
            self.assertIn("accept_revision|revise_bbox|reject_revision", ledger)
            self.assertNotIn(",accept_revision,", ledger)

    def test_validation_rejects_changed_review_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("build")))
            text = fixture.primary.read_text(encoding="utf-8")
            fixture.primary.write_text(
                text.replace("safe margins.", "safe margins, tampered."),
                encoding="utf-8",
            )
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, ADJUDICATE.main(fixture.argv("validate")))

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            rows = read_jsonl(fixture.secondary)
            rows[0]["confidence"] = 0.5
            write_jsonl(fixture.secondary, rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("build")))
            rows[0]["rationale"] = "Changed after sealing."
            write_jsonl(fixture.secondary, rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, ADJUDICATE.main(fixture.argv("validate")))

    def test_rejects_tampered_revision_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("build")))
            preview = fixture.output / ADJUDICATE.PREVIEW_DIR / "fm_repairable.png"
            preview.write_bytes(preview.read_bytes() + b"tamper")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, ADJUDICATE.main(fixture.argv("validate")))

    def test_owned_overwrite_succeeds_but_unmanaged_output_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("build")))
                self.assertEqual(0, ADJUDICATE.main(fixture.argv("build")))
            unmanaged = fixture.output / "keep-me.txt"
            unmanaged.write_text("user data", encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, ADJUDICATE.main(fixture.argv("build")))
            self.assertEqual("user data", unmanaged.read_text(encoding="utf-8"))

    def test_rejects_stale_secondary_proposal_binding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            rows = read_jsonl(fixture.secondary)
            rows[0]["proposal_record_sha256"] = "0" * 64
            write_jsonl(fixture.secondary, rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, ADJUDICATE.main(fixture.argv("build")))

    def test_rejects_output_nested_inside_prior_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            argv = fixture.argv("build")
            output_index = argv.index("--output-root") + 1
            nested = fixture.proposal_root / "forbidden-v2"
            argv[output_index] = str(nested)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, ADJUDICATE.main(argv))
            self.assertFalse(nested.exists())


if __name__ == "__main__":
    unittest.main()
