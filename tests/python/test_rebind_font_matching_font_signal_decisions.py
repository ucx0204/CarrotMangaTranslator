from __future__ import annotations

import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
FINALIZER_TEST = (
    ROOT / "tests" / "python" / "test_finalize_font_matching_font_signal_audit.py"
)
FINALIZER_TEST_SPEC = importlib.util.spec_from_file_location(
    "font_signal_finalizer_fixture_for_rebind", FINALIZER_TEST
)
assert FINALIZER_TEST_SPEC and FINALIZER_TEST_SPEC.loader
FIXTURE = importlib.util.module_from_spec(FINALIZER_TEST_SPEC)
sys.modules[FINALIZER_TEST_SPEC.name] = FIXTURE
FINALIZER_TEST_SPEC.loader.exec_module(FIXTURE)

SCRIPT = ROOT / "scripts" / "rebind_font_matching_font_signal_decisions.py"
SPEC = importlib.util.spec_from_file_location("font_signal_decision_rebind", SCRIPT)
assert SPEC and SPEC.loader
REBIND = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = REBIND
SPEC.loader.exec_module(REBIND)


class DecisionRebindTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fixture = FIXTURE.Fixture(self.root / "prior")
        self.new_source = self.root / "current-rescue"
        self.new_source.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_reordered_source(self, *, tamper: bool = False) -> None:
        audits = copy.deepcopy(self.fixture.audits)
        first_order = audits[0]["audit_order"]
        second_order = audits[1]["audit_order"]
        for row, new_order in ((audits[0], second_order), (audits[1], first_order)):
            row.pop("record_sha256")
            row["audit_order"] = new_order
            if tamper and row is audits[0]:
                row["evidence"]["views"]["glyph_224"]["file_sha256"] = "a" * 64
            sealed = FIXTURE.source_seal(row)
            row.clear()
            row.update(sealed)
        audits.sort(key=lambda row: row["audit_order"])
        FIXTURE.rewrite_source_report(
            self.new_source,
            audits,
            copy.deepcopy(self.fixture.assignments),
            copy.deepcopy(self.fixture.selections),
        )

    def test_rebinds_only_order_changed_rows_and_validates(self) -> None:
        self._write_reordered_source()
        output = self.root / "rebound"
        artifacts = REBIND.build_artifacts(
            old_rescue=self.fixture.source,
            new_rescue=self.new_source,
            decisions_path=self.fixture.decisions_path,
        )
        REBIND.write_artifacts(output, artifacts)
        report = REBIND.validate_artifacts(
            old_rescue=self.fixture.source,
            new_rescue=self.new_source,
            decisions_path=self.fixture.decisions_path,
            output=output,
        )
        self.assertEqual(62, report["summary"]["byte_equivalent_evidence_count"])
        self.assertEqual(2, report["summary"]["audit_order_only_change_count"])
        self.assertEqual(0, report["summary"]["human_outcome_changes"])
        rebound = REBIND.audit.read_jsonl(output / REBIND.DECISIONS_FILE, "rebound")
        original = {row["sample_id"]: row for row in self.fixture.decisions}
        for row in rebound:
            prior = original[row["sample_id"]]
            self.assertEqual(prior["outcome"], row["outcome"])
            self.assertEqual(prior["rationale"], row["rationale"])
            self.assertEqual(prior["reviewer"], row["reviewer"])
            self.assertEqual(prior["reviewed_at"], row["reviewed_at"])

    def test_rejects_any_pixel_evidence_change(self) -> None:
        self._write_reordered_source(tamper=True)
        with self.assertRaisesRegex(
            REBIND.DecisionRebindError, "evidence changed beyond audit_order"
        ):
            REBIND.build_artifacts(
                old_rescue=self.fixture.source,
                new_rescue=self.new_source,
                decisions_path=self.fixture.decisions_path,
            )


if __name__ == "__main__":
    unittest.main()
