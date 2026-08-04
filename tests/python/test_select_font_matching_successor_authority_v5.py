from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from scripts import build_font_matching_successor_authority_intake_v5 as INTAKE
from scripts import font_matching_catalog_delta_ledger as LEDGER
from scripts import select_font_matching_successor_authority_v5 as SELECTOR


class SelectionFixture:
    def __init__(self) -> None:
        strata: list[str] = []
        for name, count in INTAKE.EXACT_STRATUM_COUNTS.items():
            strata.extend([name] * count)
        self.sample_ids = [f"fm_selector_{index:03d}" for index in range(90)]
        self.queue: dict[str, dict[str, object]] = {}
        self.evidence: dict[str, list[dict[str, object]]] = {}
        for index, sample_id in enumerate(self.sample_ids):
            stratum = (
                strata[index] if index < len(strata) else strata[index % len(strata)]
            )
            self.queue[sample_id] = {
                "sample_id": sample_id,
                "canonical_split": "train",
                "work_id": f"work-{index % 15:02d}",
                "chapter_id": f"chapter-{index:03d}",
                "proposed_role": "dialogue",
                "proposed_stratum": stratum,
                "review_order": index + 1,
                "visual_lineage_conflict_keys": [f"lineage\0{sample_id}"],
            }
            self.evidence[sample_id] = [
                {"reviewer_id": reviewer, "eligibility": "clean"}
                for reviewer in ("reviewer-a", "reviewer-b")
            ]

    def select(
        self,
        *,
        evidence: dict[str, list[dict[str, object]]] | None = None,
        queue: dict[str, dict[str, object]] | None = None,
        forbidden_conflict_keys: set[str] | None = None,
    ) -> tuple[dict[str, object], dict[str, object]]:
        return SELECTOR.select_from_loaded_prechecks(
            round_id="delta7-fresh-rubric-v4-round-003",
            selection_seed="selector-fixture-seed",
            evidence=evidence if evidence is not None else self.evidence,
            queue_by_sample=queue if queue is not None else self.queue,
            precheck_bindings=[],
            forbidden_conflict_keys=forbidden_conflict_keys,
        )


class SuccessorAuthoritySelectorV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = SelectionFixture()

    def test_exact_selection_is_balanced_sealed_and_deterministic(self) -> None:
        first, first_audit = self.fixture.select()
        second, second_audit = self.fixture.select()
        self.assertEqual(first, second)
        self.assertEqual(first_audit, second_audit)
        self.assertEqual(first["sample_count"], 60)
        self.assertEqual(len(first["sample_ids"]), 60)
        selected = set(first["sample_ids"])
        work_counts = Counter(
            self.fixture.queue[sample_id]["work_id"] for sample_id in selected
        )
        strata_counts = Counter(
            self.fixture.queue[sample_id]["proposed_stratum"] for sample_id in selected
        )
        self.assertEqual(len(work_counts), 15)
        self.assertEqual(set(work_counts.values()), {4})
        self.assertEqual(dict(strata_counts), INTAKE.EXACT_STRATUM_COUNTS)
        self.assertEqual(first_audit["pool"]["double_clean_pool_count"], 90)
        self.assertFalse(first_audit["solver"]["exact_solver"]["fail_closed"])

    def test_fewer_than_72_double_clean_rows_fail_closed(self) -> None:
        evidence = {
            sample_id: [dict(row) for row in rows]
            for sample_id, rows in self.fixture.evidence.items()
        }
        for sample_id in self.fixture.sample_ids[:19]:
            evidence[sample_id][1]["eligibility"] = "reject"
        with self.assertRaisesRegex(SELECTOR.SelectionError, "below required 72"):
            self.fixture.select(evidence=evidence)

    def test_wrong_work_coverage_fails_before_selection(self) -> None:
        queue = {sample_id: dict(row) for sample_id, row in self.fixture.queue.items()}
        for sample_id, row in queue.items():
            if row["work_id"] == "work-14":
                row["work_id"] = "work-00"
        with self.assertRaisesRegex(SELECTOR.SelectionError, "15-work"):
            self.fixture.select(queue=queue)

    def test_forbidden_prior_lineage_can_make_quota_infeasible(self) -> None:
        forbidden = {
            str(row["visual_lineage_conflict_keys"][0])
            for row in self.fixture.queue.values()
            if row["proposed_stratum"] == "sign_ui_title"
        }
        with self.assertRaisesRegex(
            SELECTOR.SelectionError, "no exact scored selection"
        ):
            self.fixture.select(forbidden_conflict_keys=forbidden)

    def test_publication_validates_exact_bytes_and_ledger_schema(self) -> None:
        selection, audit = self.fixture.select()
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "selection"
            SELECTOR.publish_selection(
                output_dir=output, selection=selection, audit=audit
            )
            SELECTOR.validate_published_selection(
                output_dir=output, selection=selection, audit=audit
            )
            selected, binding = LEDGER._read_successor_authority_selection_manifest(
                output / SELECTOR.SELECTION_FILE,
                round_id="delta7-fresh-rubric-v4-round-003",
            )
            self.assertEqual(selected, set(selection["sample_ids"]))
            self.assertEqual(binding["record_sha256"], selection["record_sha256"])
            (output / SELECTOR.AUDIT_FILE).write_bytes(b"tampered")
            with self.assertRaisesRegex(SELECTOR.SelectionError, "changed"):
                SELECTOR.validate_published_selection(
                    output_dir=output, selection=selection, audit=audit
                )

    def test_direct_file_help_smoke(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(Path(SELECTOR.__file__).resolve()), "--help"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("{build,validate}", completed.stdout)


if __name__ == "__main__":
    unittest.main()
