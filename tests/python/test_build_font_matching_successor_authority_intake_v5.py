from __future__ import annotations

import copy
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

from scripts import build_font_matching_successor_authority_intake_v5 as BUILDER
from scripts import font_matching_catalog_delta_ledger as LEDGER


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(BUILDER.canonical_json_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(BUILDER.jsonl_bytes(rows))


class SuccessorAuthorityFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.round_id = "fresh-round-003"
        self.output_number = 0
        strata: list[str] = []
        for name, count in BUILDER.EXACT_STRATUM_COUNTS.items():
            strata.extend([name] * count)
        self.selected_ids = [f"fm_{index:03d}" for index in range(60)]
        self.pool_ids = [f"fm_{index:03d}" for index in range(72)]
        self.stratum_by_id = {
            sample_id: (
                strata[index]
                if index < 60
                else list(BUILDER.EXACT_STRATUM_COUNTS)[
                    index % len(BUILDER.EXACT_STRATUM_COUNTS)
                ]
            )
            for index, sample_id in enumerate(self.pool_ids)
        }
        self.work_by_id = {
            sample_id: f"work-{index % 15:02d}"
            for index, sample_id in enumerate(self.pool_ids)
        }
        self.master_rows = [
            self._master_row(index, sample_id)
            for index, sample_id in enumerate(self.selected_ids)
        ]
        self.master_path = root / "successor-master.jsonl"
        self.split_path = root / "split-map.json"
        self.report_path = root / "successor-report.json"
        self.registry_path = root / "registry.json"
        self.inventory_path = root / "base-inventory.jsonl"
        self.assignments_path = root / "base-assignments.jsonl"
        project_root = Path(BUILDER.__file__).resolve().parents[1]
        self.render_bank_path = (
            project_root / "datasets" / "fontclip-font-render-bank-v2" / "manifest.json"
        )
        self.font_catalog_path = (
            project_root / "datasets" / "fontclip-font-catalog-v2" / "manifest.json"
        )
        self.selection_path = root / "selection.json"
        write_jsonl(self.master_path, self.master_rows)
        write_json(self.split_path, {"schema_version": "fixture", "rows": 60})
        self._rewrite_report()
        write_json(self.registry_path, {"schema_version": "fixture"})
        existing_ids = self.selected_ids[:10]
        write_jsonl(
            self.inventory_path,
            [{"sample_id": sample_id} for sample_id in existing_ids],
        )
        write_jsonl(
            self.assignments_path,
            [
                {
                    "sample_id": sample_id,
                    "stage": stage,
                    "assignment_id": f"historical-{sample_id}-{stage}",
                }
                for sample_id in existing_ids
                for stage in ("primary", "secondary")
            ],
        )
        write_json(
            self.selection_path,
            LEDGER.seal(
                {
                    "schema_version": LEDGER.SCHEMA_VERSION,
                    "record_type": LEDGER.SUCCESSOR_AUTHORITY_SELECTION_RECORD_TYPE,
                    "round_id": self.round_id,
                    "development_only": True,
                    "source_authority": "sealed_successor_master_registry_split",
                    "sample_count": 60,
                    "sample_ids": sorted(self.selected_ids),
                }
            ),
        )
        self.surface_path = root / "source-surface.bin"
        self.surface_path.write_bytes(b"candidate-free-source-pixels")
        self.precheck_paths = self._make_prechecks()
        self.queue = {}
        for shard in ("a", "b"):
            for row in BUILDER.read_jsonl(self.root / f"queue-{shard}.jsonl"):
                self.queue[str(row["sample_id"])] = row
        self.evidence = {
            sample_id: [
                {
                    "review_id": f"fresh-review-{reviewer}",
                    "reviewer_id": f"fresh-reviewer-{reviewer}",
                    "decision_record_sha256": BUILDER.sha256_bytes(
                        f"decision-{sample_id}-{reviewer}".encode()
                    ),
                    "decision_file_sha256": BUILDER.sha256_bytes(
                        f"file-{reviewer}".encode()
                    ),
                    "queue_item_record_sha256": self.queue[sample_id]["record_sha256"],
                    "reviewed_source_surfaces_sha256": BUILDER.sha256_bytes(
                        f"surface-{sample_id}-{reviewer}".encode()
                    ),
                    "eligibility": "clean",
                    "font_id": "must-not-propagate",
                    "score": 0.999,
                    "rank": 1,
                }
                for reviewer in ("a", "b")
            ]
            for sample_id in self.pool_ids
        }
        self.precheck_bindings = []

    def _master_row(self, index: int, sample_id: str) -> dict[str, object]:
        return {
            "id": sample_id,
            "split": "train",
            "sample_crop_sha256": BUILDER.sha256_bytes(f"crop-{index}".encode()),
            "groups": {
                "root": f"root-{index}",
                "variant": f"variant-{index}",
                "normalized_glyph": f"glyph-{index}",
            },
            "work": {"id": self.work_by_id[sample_id]},
            "page": {
                "id": f"page-{index}",
                "source_page_sha256": BUILDER.sha256_bytes(
                    f"page-bytes-{index}".encode()
                ),
            },
            "provenance": {
                "synthetic": False,
                "qa_overlay": False,
                "source_catalog_id": "fixture-real-source",
                "source_id": f"source-{index}",
                "source_lineage": [{"id": f"lineage-{index}"}],
            },
        }

    def _rewrite_report(self) -> None:
        write_json(
            self.report_path,
            {
                "outputs": {
                    "master_manifest_sha256": BUILDER.sha256_file(self.master_path),
                    "split_map_sha256": BUILDER.sha256_file(self.split_path),
                }
            },
        )

    def rewrite_master(self) -> None:
        write_jsonl(self.master_path, self.master_rows)
        self._rewrite_report()

    def _queue_row(self, sample_id: str, shard: str) -> dict[str, object]:
        return BUILDER.seal(
            {
                "schema_version": BUILDER.QUEUE_SCHEMA,
                "record_type": BUILDER.QUEUE_ITEM_RECORD_TYPE,
                "queue_id": f"fixture-{shard}",
                "shard": shard,
                "sample_id": sample_id,
                "canonical_split": "train",
                "work_id": self.work_by_id[sample_id],
                "proposed_stratum": self.stratum_by_id[sample_id],
            }
        )

    def _make_prechecks(self) -> list[Path]:
        summary_paths: list[Path] = []
        surface_sha = BUILDER.sha256_file(self.surface_path)
        for shard_index, shard in enumerate(("a", "b")):
            shard_ids = self.pool_ids[shard_index * 36 : (shard_index + 1) * 36]
            queue_rows = [self._queue_row(sample_id, shard) for sample_id in shard_ids]
            queue_path = self.root / f"queue-{shard}.jsonl"
            queue_manifest_path = self.root / f"queue-{shard}-manifest.json"
            write_jsonl(queue_path, queue_rows)
            queue_manifest = BUILDER.seal({"queue_id": f"fixture-{shard}"})
            write_json(queue_manifest_path, queue_manifest)
            queue_by_id = {str(row["sample_id"]): row for row in queue_rows}
            for reviewer_number in range(2):
                review_id = f"fixture-{shard}-review-{reviewer_number}"
                reviewer_id = f"reviewer-{shard}-{reviewer_number}"
                decision_rows: list[dict[str, object]] = []
                for review_order, sample_id in enumerate(shard_ids, 1):
                    decision_rows.append(
                        BUILDER.seal(
                            {
                                "schema_version": BUILDER.PRECHECK_DECISION_SCHEMA,
                                "record_type": BUILDER.PRECHECK_DECISION_RECORD_TYPE,
                                "review_id": review_id,
                                "reviewer_id": reviewer_id,
                                "review_order": review_order,
                                "sample_id": sample_id,
                                "canonical_split": "train",
                                "queue_binding": {
                                    "queue_item_record_sha256": queue_by_id[sample_id][
                                        "record_sha256"
                                    ],
                                    "queue_file_sha256": BUILDER.sha256_file(
                                        queue_path
                                    ),
                                    "queue_manifest_record_sha256": queue_manifest[
                                        "record_sha256"
                                    ],
                                },
                                "decision": {
                                    "status": "clean",
                                    "font_id": "must-not-propagate",
                                    "score": 0.999,
                                    "rank": 1,
                                    "confirmed_stratum": "must-not-propagate",
                                },
                                "source_review_contract": {
                                    "candidate_font_pixels_viewed": False,
                                    "manual_source_view_complete": True,
                                    "metadata_only_decision": False,
                                    "reviewed_surface_count": 1,
                                    "reviewed_surfaces": [
                                        {
                                            "viewed": True,
                                            "name": "source_only",
                                            "path": str(self.surface_path.resolve()),
                                            "declared_sha256": surface_sha,
                                            "observed_sha256": surface_sha,
                                            "declared_pixel_sha256": BUILDER.sha256_bytes(
                                                b"pixels"
                                            ),
                                            "declared_size_px": [16, 16],
                                        }
                                    ],
                                },
                            }
                        )
                    )
                decisions_path = (
                    self.root / f"decisions-{shard}-{reviewer_number}.jsonl"
                )
                write_jsonl(decisions_path, decision_rows)
                summary = BUILDER.seal(
                    {
                        "schema_version": BUILDER.PRECHECK_SUMMARY_SCHEMA,
                        "record_type": BUILDER.PRECHECK_SUMMARY_RECORD_TYPE,
                        "status": "sealed_complete",
                        "review_id": review_id,
                        "reviewer_id": reviewer_id,
                        "review_contract": {
                            "candidate_font_pixels_viewed": False,
                            "manual_source_view_complete": True,
                            "metadata_only_decision_count": 0,
                        },
                        "bindings": {
                            "decisions_path": str(decisions_path.resolve()),
                            "decisions_file_sha256": BUILDER.sha256_file(
                                decisions_path
                            ),
                            "queue_path": str(queue_path.resolve()),
                            "queue_file_sha256": BUILDER.sha256_file(queue_path),
                            "queue_manifest_path": str(queue_manifest_path.resolve()),
                            "queue_manifest_file_sha256": BUILDER.sha256_file(
                                queue_manifest_path
                            ),
                            "queue_manifest_record_sha256": queue_manifest[
                                "record_sha256"
                            ],
                        },
                        "sample_sets": {
                            "clean_sample_ids": sorted(shard_ids),
                            "reject_sample_ids": [],
                        },
                    }
                )
                summary_path = self.root / f"summary-{shard}-{reviewer_number}.json"
                write_json(summary_path, summary)
                summary_paths.append(summary_path)
        return summary_paths

    def build(
        self,
        *,
        evidence: dict[str, list[dict[str, object]]] | None = None,
        queue: dict[str, dict[str, object]] | None = None,
        contaminated: tuple[str, ...] = (),
        real_prechecks: bool = False,
    ) -> tuple[dict[str, object], Path]:
        self.output_number += 1
        output = self.root / f"output-{self.output_number}"
        kwargs = {
            "round_id": self.round_id,
            "selection_manifest": self.selection_path,
            "precheck_summaries": self.precheck_paths,
            "base_inventory": self.inventory_path,
            "base_assignments": self.assignments_path,
            "successor_master_manifest": self.master_path,
            "successor_master_report": self.report_path,
            "successor_split_map": self.split_path,
            "catalog_registry": self.registry_path,
            "render_bank_manifest": self.render_bank_path,
            "font_catalog_manifest": self.font_catalog_path,
            "output_dir": output,
            "contaminated_sample_ids": contaminated,
        }
        if real_prechecks:
            return BUILDER.build_intake(**kwargs), output
        mocked = (
            copy.deepcopy(evidence if evidence is not None else self.evidence),
            copy.deepcopy(self.precheck_bindings),
            copy.deepcopy(queue if queue is not None else self.queue),
        )
        with mock.patch.object(BUILDER, "_load_prechecks", return_value=mocked):
            return BUILDER.build_intake(**kwargs), output


class BuildSuccessorAuthorityIntakeV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = SuccessorAuthorityFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_valid_exact60_from_double_clean_72_across_15_works(self) -> None:
        manifest, output = self.fixture.build()
        self.assertEqual(manifest["selected_sample_count"], 60)
        self.assertEqual(manifest["double_clean_pool_count"], 72)
        self.assertEqual(len(manifest["double_clean_work_counts"]), 15)
        self.assertEqual(
            manifest["selected_stratum_counts"], BUILDER.EXACT_STRATUM_COUNTS
        )
        self.assertEqual(max(manifest["selected_work_counts"].values()), 4)
        self.assertEqual(manifest["fresh_public_task_sample_count"], 60)
        self.assertEqual(manifest["fresh_public_assignment_count"], 120)
        self.assertEqual(manifest["reused_existing_task_sample_count"], 0)
        self.assertEqual(manifest["superseded_existing_task_sample_count"], 10)
        self.assertEqual(len(BUILDER.read_jsonl(output / "samples.jsonl")), 60)
        assignments = BUILDER.read_jsonl(output / "assignments.jsonl")
        self.assertEqual(len(assignments), 120)
        historical_ids = {
            row["assignment_id"]
            for row in BUILDER.read_jsonl(self.fixture.assignments_path)
        }
        self.assertFalse(
            historical_ids.intersection({row["assignment_id"] for row in assignments})
        )

    def test_one_reviewer_is_rejected(self) -> None:
        evidence = copy.deepcopy(self.fixture.evidence)
        for sample_id in evidence:
            evidence[sample_id] = evidence[sample_id][:1]
        with self.assertRaisesRegex(BUILDER.IntakeError, "double-clean reserve"):
            self.fixture.build(evidence=evidence)

    def test_same_reviewer_is_rejected(self) -> None:
        evidence = copy.deepcopy(self.fixture.evidence)
        for rows in evidence.values():
            rows[1]["reviewer_id"] = rows[0]["reviewer_id"]
        with self.assertRaisesRegex(BUILDER.IntakeError, "double-clean reserve"):
            self.fixture.build(evidence=evidence)

    def test_contaminated_selected_sample_is_rejected_even_with_72_remaining(
        self,
    ) -> None:
        evidence = copy.deepcopy(self.fixture.evidence)
        queue = copy.deepcopy(self.fixture.queue)
        extra_id = "fm_999"
        queue[extra_id] = {
            "sample_id": extra_id,
            "work_id": "work-00",
            "proposed_stratum": "emphasis_shout",
        }
        evidence[extra_id] = [
            {"reviewer_id": "extra-a", "eligibility": "clean"},
            {"reviewer_id": "extra-b", "eligibility": "clean"},
        ]
        with self.assertRaisesRegex(BUILDER.IntakeError, "legacy contaminated"):
            self.fixture.build(
                evidence=evidence,
                queue=queue,
                contaminated=(self.fixture.selected_ids[0],),
            )

    def test_pool_below_72_is_rejected(self) -> None:
        evidence = copy.deepcopy(self.fixture.evidence)
        evidence.pop(self.fixture.pool_ids[-1])
        with self.assertRaisesRegex(BUILDER.IntakeError, "below required 72"):
            self.fixture.build(evidence=evidence)

    def test_missing_work_minimum_is_rejected(self) -> None:
        queue = copy.deepcopy(self.fixture.queue)
        victim = next(
            sample_id
            for sample_id in self.fixture.pool_ids
            if queue[sample_id]["work_id"] == "work-14"
        )
        queue[victim]["work_id"] = "work-00"
        with self.assertRaisesRegex(BUILDER.IntakeError, "min4 gate"):
            self.fixture.build(queue=queue)

    def test_exact_selected_stratum_quota_is_enforced(self) -> None:
        queue = copy.deepcopy(self.fixture.queue)
        selected_ordinary = next(
            sample_id
            for sample_id in self.fixture.selected_ids
            if queue[sample_id]["proposed_stratum"] == "ordinary_body"
        )
        unselected_emphasis = next(
            sample_id
            for sample_id in self.fixture.pool_ids[60:]
            if queue[sample_id]["proposed_stratum"] == "emphasis_shout"
        )
        queue[selected_ordinary]["proposed_stratum"] = "emphasis_shout"
        queue[unselected_emphasis]["proposed_stratum"] = "ordinary_body"
        with self.assertRaisesRegex(BUILDER.IntakeError, "frozen scored quota"):
            self.fixture.build(queue=queue)

    def test_selected_work_cap_is_enforced(self) -> None:
        moved = 0
        for row in self.fixture.master_rows:
            if row["work"]["id"] in {"work-01", "work-02"} and moved < 2:
                row["work"]["id"] = "work-00"
                moved += 1
        self.fixture.rewrite_master()
        with self.assertRaisesRegex(BUILDER.IntakeError, "exceeds max 5"):
            self.fixture.build()

    def test_selected_work_balance_is_enforced_below_cap(self) -> None:
        moved = False
        for row in self.fixture.master_rows:
            if (
                row["id"] in self.fixture.selected_ids
                and row["work"]["id"] == "work-01"
            ):
                row["work"]["id"] = "work-00"
                moved = True
                break
        self.assertTrue(moved)
        self.fixture.rewrite_master()
        with self.assertRaisesRegex(
            BUILDER.IntakeError, "exactly 15 works with exactly 4 samples"
        ):
            self.fixture.build()

    def test_precheck_label_score_and_rank_are_not_inherited(self) -> None:
        manifest, output = self.fixture.build()
        self.assertFalse(manifest["precheck_labels_inherited"])
        rows = BUILDER.read_jsonl(output / "samples.jsonl")
        for row in rows:
            self.assertEqual(
                set(row["eligibility_evidence"][0]),
                {
                    "review_id",
                    "reviewer_id",
                    "decision_record_sha256",
                    "decision_file_sha256",
                    "queue_item_record_sha256",
                    "reviewed_source_surfaces_sha256",
                },
            )
            self.assertNotIn("font_id", row)
            self.assertNotIn("score", row)
            self.assertNotIn("rank", row)
            self.assertNotIn("confirmed_stratum", row)

    def test_tampered_successor_report_is_rejected(self) -> None:
        report = BUILDER.read_json(self.fixture.report_path)
        report["outputs"]["master_manifest_sha256"] = "0" * 64
        write_json(self.fixture.report_path, report)
        with self.assertRaisesRegex(BUILDER.IntakeError, "report authority changed"):
            self.fixture.build()

    def test_legacy_prechecks_are_rejected(self) -> None:
        with self.assertRaisesRegex(
            BUILDER.IntakeError,
            "redacted review summary contract changed|complete reviewer pairs",
        ):
            BUILDER._load_prechecks(self.fixture.precheck_paths)

    def test_tampered_selection_is_rejected(self) -> None:
        selection = BUILDER.read_json(self.fixture.selection_path)
        selection["sample_ids"][0] = "fm_tampered"
        write_json(self.fixture.selection_path, selection)
        with self.assertRaises(LEDGER.DeltaLedgerError):
            self.fixture.build()

    def test_tampered_master_binding_is_rejected(self) -> None:
        self.fixture.master_path.write_bytes(
            self.fixture.master_path.read_bytes() + b"\n"
        )
        with self.assertRaisesRegex(BUILDER.IntakeError, "report authority changed"):
            self.fixture.build()

    def test_pool_and_selected_stratum_counts_match_frozen_contract(self) -> None:
        queue = self.fixture.queue
        counts = Counter(
            queue[sample_id]["proposed_stratum"]
            for sample_id in self.fixture.selected_ids
        )
        self.assertEqual(dict(counts), BUILDER.EXACT_STRATUM_COUNTS)


class BuildSuccessorAuthorityIntakeV5CliTests(unittest.TestCase):
    def test_expanded_v2_parent_derives_exact_frozen_new_seven(self) -> None:
        project_root = Path(BUILDER.__file__).resolve().parents[1]
        ids, aliases, version = BUILDER._render_candidates(
            project_root
            / "datasets"
            / "fontclip-font-render-bank-v2"
            / "manifest.json",
            project_root / "datasets" / "fontclip-font-catalog-v2" / "manifest.json",
        )
        self.assertEqual(ids, list(BUILDER.FRESH_DELTA_CANDIDATES))
        self.assertEqual(
            aliases,
            {
                font_id: value["blind_alias"]
                for font_id, value in BUILDER.FRESH_DELTA_CANDIDATES.items()
            },
        )
        self.assertEqual(version, "font-face-manifest-v1")

    def test_historical_exact7_subset_is_not_accepted_as_authority(self) -> None:
        project_root = Path(BUILDER.__file__).resolve().parents[1]
        with self.assertRaisesRegex(BUILDER.IntakeError, "expanded v2 authority"):
            BUILDER._render_candidates(
                project_root
                / "datasets"
                / "font-matching-catalog-rescue-inputs-v4"
                / "render-bank"
                / "manifest.json",
                project_root
                / "datasets"
                / "fontclip-font-catalog-v2"
                / "manifest.json",
            )

    def test_direct_file_help_smoke(self) -> None:
        script = Path(BUILDER.__file__).resolve()
        with tempfile.TemporaryDirectory() as temp_dir:
            completed = subprocess.run(
                [sys.executable, str(script), "--help"],
                cwd=temp_dir,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("--successor-master-manifest", completed.stdout)
        self.assertIn("--font-catalog-manifest", completed.stdout)


if __name__ == "__main__":
    unittest.main()
