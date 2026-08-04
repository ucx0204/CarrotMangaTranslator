from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import save_file

from scripts import evaluate_manga_font_r5_qa_snapshots as evaluator


ACTIVE = evaluator._active_ids()


def prediction(sample_id: str, ranking: tuple[str, ...], *, split: str = "val"):
    probabilities = [0.0] * len(ACTIVE)
    for rank, font_id in enumerate(ranking):
        probabilities[ACTIVE.index(font_id)] = float(len(ACTIVE) - rank)
    total = sum(probabilities)
    return evaluator.heldout_eval.Prediction(
        sample_id=sample_id,
        split=split,
        work_id="work",
        chapter_id="chapter",
        page_id="page",
        master_row_sha256="a" * 64,
        source_category="ordinary",
        source_kind="hard",
        source_row_index=0,
        candidate_ids=ACTIVE,
        probabilities=tuple(value / total for value in probabilities),
        ranking=ranking,
        record_sha256="b" * 64,
    )


def decision(
    sample_id: str,
    kind: str,
    *,
    cohort: str,
    selected: str | None,
    split: str = "val",
):
    return evaluator.heldout_eval.HeldoutDecision(
        sample_id=sample_id,
        split=split,
        cohort=cohort,
        decision_kind=kind,
        review_item_sha256="c" * 64,
        reviewed_font_ids=ACTIVE[:5],
        selected_font_id=selected,
        acceptable_font_ids=(),
        source_top1_font_id=ACTIVE[0],
        decision_sha256="d" * 64,
        role="dialogue",
        source_category="ordinary",
    )


class R5SnapshotEvaluationTests(unittest.TestCase):
    @staticmethod
    def write_snapshot(root: Path, epoch: int, *, candidates=ACTIVE) -> Path:
        path = root / f"epoch-{epoch:03d}-head.safetensors"
        save_file(
            {"weight": torch.zeros((2, 2))},
            str(path),
            metadata={
                "candidate_ids": json.dumps(list(candidates)),
                "epoch": str(epoch),
                "purpose": evaluator.SNAPSHOT_PURPOSE,
                "schema_version": evaluator.r5.QA_SNAPSHOT_SCHEMA,
            },
        )
        return path

    def test_snapshot_loader_requires_contiguous_epoch0_and_exact_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_snapshot(root, 0)
            self.write_snapshot(root, 1)
            snapshots = evaluator.load_snapshots(root)
            self.assertEqual((0, 1), tuple(value.epoch for value in snapshots))
            self.assertEqual(ACTIVE, tuple(snapshots[0].binding()["candidate_ids"]))

    def test_snapshot_loader_rejects_candidate_or_epoch_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_snapshot(root, 0, candidates=ACTIVE[:-1])
            with self.assertRaisesRegex(
                evaluator.SnapshotEvaluationError, "metadata/state drifted"
            ):
                evaluator.load_snapshots(root)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_snapshot(root, 1)
            with self.assertRaisesRegex(
                evaluator.SnapshotEvaluationError, "contiguous"
            ):
                evaluator.load_snapshots(root)

    def test_epoch0_top5_self_check_is_fail_closed(self) -> None:
        baseline = {"sample": prediction("sample", ACTIVE)}
        result = evaluator.require_epoch0_topk_self_check(
            baseline, dict(baseline), top_k=5
        )
        self.assertEqual("passed", result["status"])
        changed = (ACTIVE[1], ACTIVE[0], *ACTIVE[2:])
        candidate = {"sample": prediction("sample", changed)}
        with self.assertRaisesRegex(
            evaluator.SnapshotEvaluationError, "self-check failed"
        ):
            evaluator.require_epoch0_topk_self_check(
                baseline, candidate, top_k=5
            )

    def test_metrics_separate_abcd_post_cutoff_and_split(self) -> None:
        baseline_ranking = ACTIVE
        corrected_ranking = (ACTIVE[1], ACTIVE[0], *ACTIVE[2:])
        decisions = {
            "abcd": decision(
                "abcd", "confirmed", cohort="val", selected=ACTIVE[0]
            ),
            "post": decision(
                "post",
                "correction",
                cohort=evaluator.POST_CUTOFF_COHORT,
                selected=ACTIVE[1],
                split="test",
            ),
        }
        baseline = {
            sample_id: prediction(sample_id, baseline_ranking, split=row.split)
            for sample_id, row in decisions.items()
        }
        candidate = {
            "abcd": prediction("abcd", baseline_ranking),
            "post": prediction("post", corrected_ranking, split="test"),
        }
        rows = evaluator.heldout_eval.build_evaluation_rows(
            decisions, baseline, candidate
        )
        metrics = evaluator.compute_metrics(rows)
        self.assertEqual(
            1, metrics["by_evaluation_set"]["abcd_heldout"]["counts"]["rows"]
        )
        self.assertEqual(
            1,
            metrics["by_evaluation_set"][evaluator.POST_CUTOFF_COHORT][
                "counts"
            ]["rows"],
        )
        self.assertEqual(
            1,
            metrics["post_cutoff_e_by_split"]["test"]["correction"]["rows"],
        )

    def test_selected_cache_reader_reads_only_requested_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory_name = "shard"
            shard = root / evaluator.cache.SHARDS_DIR / directory_name
            shard.mkdir(parents=True)
            shape = (
                3,
                len(evaluator.labeler.VIEW_NAMES),
                evaluator.labeler.v7.PATCH_COUNT,
                evaluator.labeler.v7.HIDDEN_SIZE,
            )
            values = np.zeros(shape, dtype="<f2")
            values[1].fill(1.0)
            np.save(shard / evaluator.cache.SHARD_ARRAY, values, allow_pickle=False)
            row = evaluator.CacheIndexRow(1, "sample", "val", 0)
            selected = evaluator.SelectedCache(
                root=root,
                rows={"sample": row},
                shards={
                    0: {
                        "directory": directory_name,
                        "start_cache_index": 0,
                        "end_cache_index_exclusive": 3,
                    }
                },
                binding={},
            )
            result = selected.read([row])
            self.assertEqual((1, *shape[1:]), result.shape)
            self.assertEqual(1.0, float(result.mean()))
            self.assertEqual(1, selected.rows_read)

    def test_cli_pins_cache_and_epoch0_top5_defaults(self) -> None:
        args = evaluator.build_parser().parse_args(
            [
                "evaluate",
                "--snapshot-dir",
                "snapshots",
                "--reference-model-dir",
                "reference",
                "--hidden-cache-dir",
                "cache",
                "--baseline-review-predictions",
                "baseline.jsonl",
                "--heldout-decisions",
                "heldout.jsonl",
                "--output-dir",
                "output",
            ]
        )
        self.assertEqual(evaluator.DEFAULT_CACHE_MANIFEST_SHA256, args.expected_hidden_cache_manifest_sha256)
        self.assertEqual(evaluator.DEFAULT_CACHE_IDENTITY_SHA256, args.expected_hidden_cache_identity_sha256)
        self.assertEqual(5, args.epoch0_self_check_top_k)


if __name__ == "__main__":
    unittest.main()
