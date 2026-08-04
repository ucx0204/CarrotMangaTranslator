from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts import materialize_manga_font_r5_qa_snapshot_v1 as materializer


class R5QASnapshotMaterializerTests(unittest.TestCase):
    @staticmethod
    def failed_metrics() -> dict[str, float | int]:
        return {
            "acceptable_at1": 0.72,
            "evaluated_positive_rows": 33,
            "preferred_at1": 0.42,
            "top1_max_candidate_share": 0.33,
            "top1_unique_candidate_count": 10,
            "variant_acceptable_at1": 0.71,
            "variant_preferred_at1": 0.35,
            "variant_val_rows": 28,
        }

    def test_selected_history_is_exactly_epoch1(self) -> None:
        metrics = self.failed_metrics()
        history = ({"epoch": 1, "record_sha256": "a" * 64, "val": metrics},)
        selected, record_sha = materializer.selected_history_val(
            history, selected_epoch=1
        )
        self.assertEqual(metrics, selected)
        self.assertEqual("a" * 64, record_sha)
        with self.assertRaisesRegex(
            materializer.SnapshotMaterializationError, "epoch 1"
        ):
            materializer.selected_history_val(history, selected_epoch=2)

    def test_research_gate_can_never_be_promoted(self) -> None:
        gate = materializer._research_gate(self.failed_metrics())
        self.assertFalse(gate["passed"])
        passing = {
            **self.failed_metrics(),
            "acceptable_at1": 0.8,
            "preferred_at1": 0.8,
            "top1_max_candidate_share": 0.2,
            "top1_unique_candidate_count": 10,
            "variant_acceptable_at1": 0.8,
            "variant_preferred_at1": 0.8,
        }
        with self.assertRaisesRegex(
            materializer.SnapshotMaterializationError, "cannot select or promote"
        ):
            materializer._research_gate(passing)

    def test_rewrite_manifest_updates_only_chosen_fields_and_seals(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            head = Path(temporary) / "head.safetensors"
            head.write_bytes(b"selected-head")
            source = {
                "best_epoch": 0,
                "best_val": {"old": True},
                "files": {
                    materializer.r5.r3.v7.BEST_HEAD: {
                        "file": materializer.r5.r3.v7.BEST_HEAD,
                        "sha256": "b" * 64,
                        "byte_size": 1,
                    }
                },
                "quality_gate": {"passed": False},
                "record_sha256": "c" * 64,
                "untouched": {"value": 7},
            }
            selection = {
                "release_approved": False,
                "schema_version": materializer.SCHEMA,
            }
            gate = materializer._research_gate(self.failed_metrics())
            rewritten = materializer.rewrite_manifest(
                source,
                selected_epoch=1,
                selected_val=self.failed_metrics(),
                chosen_gate=gate,
                selection_record=selection,
                staged_head=head,
            )
            self.assertEqual(1, rewritten["best_epoch"])
            self.assertEqual({"value": 7}, rewritten["untouched"])
            self.assertFalse(rewritten["quality_gate"]["passed"])
            self.assertFalse(
                rewritten[materializer.QA_SELECTION_KEY]["release_approved"]
            )
            self.assertEqual(
                materializer.sha256_file(head),
                rewritten["files"][materializer.r5.r3.v7.BEST_HEAD]["sha256"],
            )
            materializer.r5.r3.v7.base.validate_record_seal(
                rewritten, location="rewritten fixture"
            )

    def test_selection_record_is_explicitly_qa_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / materializer.r5.r3.v7.MANIFEST).write_text("{}")
            source_manifest = {
                "files": {
                    materializer.r5.r3.v7.BEST_HEAD: {"sha256": "d" * 64}
                },
                "quality_gate": {"passed": False},
                "record_sha256": "e" * 64,
            }
            snapshot = materializer.snapshot_eval.Snapshot(
                epoch=1,
                path=root / "epoch-001-head.safetensors",
                sha256="f" * 64,
                byte_size=1,
                state={},
            )
            selection = materializer.build_selection_record(
                source_root=root,
                source_manifest=source_manifest,
                snapshot_dir=root,
                snapshot=snapshot,
                evaluation_binding={
                    "file": str(root),
                    "manifest_sha256": "1" * 64,
                    "report_sha256": "2" * 64,
                },
                selected_metric={"record_sha256": "3" * 64},
                history_record_sha256="4" * 64,
                chosen_gate={"passed": False},
            )
            authority = selection["authority"]
            self.assertFalse(selection["release_approved"])
            self.assertFalse(authority["human_gold"])
            self.assertFalse(authority["independent_gold"])
            self.assertFalse(authority["quality_gate_authority"])
            self.assertFalse(authority["training_eligible"])
            self.assertEqual(
                {"chosen_epoch_passed": False, "promoted": False, "source_passed": False},
                selection["quality_gate"],
            )

    def test_materialize_refuses_source_alias_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(
                materializer.SnapshotMaterializationError, "separate"
            ):
                materializer.materialize(
                    source_output_dir=root,
                    snapshot_dir=root,
                    snapshot_evaluation_dir=root,
                    selected_epoch=1,
                    output_dir=root / "nested-output",
                )

    def test_cli_defaults_to_the_sealed_epoch1(self) -> None:
        args = materializer.build_parser().parse_args(
            [
                "materialize",
                "--source-output-dir",
                "source",
                "--snapshot-dir",
                "snapshots",
                "--snapshot-evaluation-dir",
                "evaluation",
                "--output-dir",
                "output",
            ]
        )
        self.assertEqual(1, args.selected_epoch)


if __name__ == "__main__":
    unittest.main()
