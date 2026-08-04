from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.python import (
    test_prepare_font_matching_adjudication_neutral_v5 as preparation_test,
)


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_adjudication_direct_visual_queue_v5.py"
SPEC = importlib.util.spec_from_file_location(
    "build_font_matching_adjudication_direct_visual_queue_v5_for_test", SCRIPT
)
assert SPEC and SPEC.loader
QUEUE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUEUE)


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_bytes(QUEUE.derive.jsonl_bytes(rows))


class QueueFixture(preparation_test.Fixture):
    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.release_id = "fmbr-primary-direct-visual"
        self.surface_root = (
            self.workspace / "candidate-surfaces" / self.release_id
        )
        self.surface_root.mkdir(parents=True)
        self.source_root = self.workspace / "source-cards"
        self.source_root.mkdir()
        self.existing = self.root / "existing-neutral.jsonl"
        _write_jsonl(
            self.existing,
            [
                self.row("double-trigger", 1),
                self.row("exception", 2),
                self.row("untriggered", 3),
            ],
        )

        release = QUEUE.catalog_ledger.seal(
            {
                "release_id": self.release_id,
                "stage": "primary",
                "record_type": "test_primary_release",
            }
        )
        entries: list[dict] = []
        tasks: list[dict] = []
        commits: dict[tuple[str, str], dict] = {}
        for name, identity in self.identities.items():
            sample_id = identity["sample"]
            suffix = identity["suffix"]
            bindings = self.state["bindings_by_sample"][sample_id]
            for stage, binding in bindings.items():
                public_ids = binding["card"]["v5_public_ids"]
                source_sha = preparation_test._sha(f"source:{suffix}:{stage}")
                source_path = self.source_root / f"{public_ids['assignment_id']}.png"
                source_path.write_bytes(f"source:{suffix}:{stage}".encode("utf-8"))
                binding["card"]["v5_source_card"].update(
                    {
                        "file": str(source_path.resolve()),
                        "pixel_sha256": preparation_test._sha(
                            f"pixels:{suffix}:{stage}"
                        ),
                        "size_px": [24, 14],
                    }
                )
                neutral = preparation_test._neutral(
                    binding["assignment"]["assignment_id"],
                    sample_id,
                    source_sha,
                    1,
                )
                annotation = {
                    "record_sha256": preparation_test._sha(
                        f"annotation:{suffix}:{stage}"
                    ),
                    "source_only_card_sha256": source_sha,
                }
                for key in QUEUE.source_seal.SAFE_NEUTRAL_EVIDENCE_KEYS:
                    annotation[key] = neutral[key]
                commits[(public_ids["assignment_id"], stage)] = {
                    "annotations": {public_ids["sample_id"]: annotation}
                }

            primary = bindings["primary"]
            primary_public = primary["card"]["v5_public_ids"]
            source_sha = primary["card"]["v5_source_card"]["sha256"]
            source_path = Path(primary["card"]["v5_source_card"]["file"])
            full_path = self.surface_root / f"{suffix}-full.png"
            full_path.write_bytes(f"full:{suffix}".encode("utf-8"))
            full_sha = preparation_test._sha(f"full:{suffix}")
            entries.append(
                {
                    "assignment_id": primary_public["assignment_id"],
                    "sample_id": primary_public["sample_id"],
                    "source_only": {
                        "file": str(source_path.resolve()),
                        "sha256": source_sha,
                        "pixel_sha256": preparation_test._sha(
                            f"pixels:{suffix}:primary"
                        ),
                        "size_px": [24, 14],
                    },
                    "full_card": {
                        "file": str(full_path.resolve()),
                        "sha256": full_sha,
                        "pixel_sha256": preparation_test._sha(
                            f"full-pixels:{suffix}"
                        ),
                        "size_px": [24, 58],
                    },
                }
            )
            tasks.append(
                {
                    "assignment_id": primary_public["assignment_id"],
                    "sample_id": primary_public["sample_id"],
                    "source_only_card_sha256": source_sha,
                    "full_card_sha256": full_sha,
                }
            )
        manifest = QUEUE.catalog_ledger.seal(
            {
                "candidate_release_id": self.release_id,
                "candidate_release_record_sha256": release["record_sha256"],
                "batch_size": len(entries),
                "entries": entries,
            }
        )
        QUEUE.catalog_ledger.atomic_write(
            self.surface_root / "manifest.json",
            QUEUE.catalog_ledger.canonical_json_bytes(manifest, pretty=True),
        )
        self.state.update(
            {
                "root": self.workspace.resolve(),
                "candidate_releases": [release],
                "v5_candidate_tasks_by_release_id": {self.release_id: tasks},
                "v5_commit_by_assignment_stage": commits,
            }
        )

    def patches(self):
        load = mock.patch.object(
            QUEUE.catalog_ledger, "_load_workspace", return_value=self.state
        )
        reviews = mock.patch.object(
            QUEUE.catalog_ledger,
            "_validate_review_records",
            return_value=(self.reviews, {}),
        )
        return load, reviews

    def run(self) -> tuple[dict, mock.Mock]:
        load_patch, review_patch = self.patches()
        with load_patch as loader, review_patch:
            summary = QUEUE.write_queue(
                workspace=self.workspace,
                existing_neutral=[self.existing],
                output=self.output,
                report=self.report,
            )
        return summary, loader


class DirectVisualQueueV5Tests(unittest.TestCase):
    def test_builds_only_missing_trigger_from_one_validated_load(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary))
            summary, loader = fixture.run()

            loader.assert_called_once_with(fixture.workspace.resolve())
            rows = QUEUE.catalog_ledger.read_jsonl(fixture.output)
            self.assertEqual(1, len(rows))
            row = rows[0]
            QUEUE.catalog_ledger.validate_seal(row, "queue row")
            self.assertEqual("fmra-primary-only-primary", row["private_assignment_id"])
            self.assertEqual(["confidence_below_0.80"], row["trigger_reasons"])
            self.assertFalse(row["secondary_required"])
            self.assertTrue(Path(row["actual_primary_full_card"]["file"]).is_file())
            self.assertEqual(
                preparation_test._sha("full:primary-only"),
                row["actual_primary_full_card"]["sha256"],
            )
            self.assertEqual(
                0.0, row["adoptable_neutral_template"]["review_confidence"]
            )
            self.assertIsNone(
                row["source_annotation_safe_projections"]["secondary"]
            )

            report = QUEUE.catalog_ledger.read_json(fixture.report)
            QUEUE.catalog_ledger.validate_seal(report, "queue report")
            self.assertEqual(1, report["counts"]["missing_trigger_queue_rows"])
            self.assertEqual(
                1, report["counts"]["excluded_eligibility_exception_samples"]
            )
            self.assertEqual(1, report["counts"]["excluded_untriggered_samples"])
            self.assertEqual(1, summary["records"])
            serialized = fixture.output.read_text(encoding="utf-8")
            serialized += fixture.report.read_text(encoding="utf-8")
            self.assertNotIn("ko-candidate-", serialized)
            self.assertNotIn("font_judgment", serialized)
            self.assertNotIn("prior_final", serialized)
            self.assertNotIn("gugi", serialized)

    def test_descriptor_byte_mismatch_fails_without_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary))
            primary_only = fixture.identities["primary-only"]
            bad_path = fixture.surface_root / f"{primary_only['suffix']}-full.png"
            bad_path.write_bytes(b"changed after sealed descriptor")
            load_patch, review_patch = fixture.patches()
            with load_patch, review_patch:
                with self.assertRaisesRegex(
                    QUEUE.DirectVisualQueueError, "bytes or descriptor changed"
                ):
                    QUEUE.write_queue(
                        workspace=fixture.workspace,
                        existing_neutral=[fixture.existing],
                        output=fixture.output,
                        report=fixture.report,
                    )
            self.assertFalse(fixture.output.exists())
            self.assertFalse(fixture.report.exists())

    def test_existing_trigger_union_can_leave_multiple_rows_in_review_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary))
            _write_jsonl(
                fixture.existing,
                [
                    fixture.row("exception", 1),
                    fixture.row("untriggered", 2),
                ],
            )
            summary, _ = fixture.run()
            rows = QUEUE.catalog_ledger.read_jsonl(fixture.output)
            self.assertEqual(2, summary["records"])
            self.assertEqual(
                ["fmra-primary-only-primary", "fmra-double-trigger-primary"],
                [row["private_assignment_id"] for row in rows],
            )
            self.assertEqual([1, 2], [row["queue_index"] for row in rows])
            self.assertEqual(
                [1, 2],
                [row["primary_review_order"] for row in rows],
            )


if __name__ == "__main__":
    unittest.main()
