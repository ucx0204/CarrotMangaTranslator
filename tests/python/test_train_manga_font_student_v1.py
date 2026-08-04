from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "train_manga_font_student_v1.py"
SPEC = importlib.util.spec_from_file_location("train_manga_font_student_v1_tested", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
TRAINER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRAINER
SPEC.loader.exec_module(TRAINER)


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(TRAINER.json_bytes(value, pretty=True))


class HumanExportFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True)
        self.candidates = tuple(f"font-{index:02d}" for index in range(22))
        self.registry_sha = "a" * 64
        rows = [
            self.row("train", "sample-train", "work-train"),
            self.row("val", "sample-val", "work-val"),
        ]
        test_row = self.row("test", "sentinel-test-label", "work-test")
        payload = b"".join(
            (TRAINER.canonical_json(row) + "\n").encode("utf-8")
            for row in [*rows, test_row]
        )
        samples = self.root / "samples.jsonl"
        samples.write_bytes(payload)
        descriptor = {
            "byte_size": len(payload),
            "file": "samples.jsonl",
            "record_count": 3,
            "sha256": TRAINER.sha256_bytes(payload),
        }
        manifest = {
            "artifacts": {"samples.jsonl": descriptor},
            "candidate_count": 22,
            "contracts": {
                "augmentation_isolation": {
                    "core_files_accept_synthetic": False,
                    "evaluation_splits_accept_generated": False,
                },
                "evaluation": {
                    "generated_examples_allowed": False,
                    "qa_overlay_examples_allowed": False,
                },
                "source_inputs": {
                    "required_views": list(TRAINER.VIEW_NAMES),
                    "review_card_pixels_allowed": False,
                },
            },
            "real_sample_count": 3,
            "registry_exclusions": {
                "catalog_registry_sha256": self.registry_sha,
            },
            "schema_version": TRAINER.HUMAN_EXPORT_SCHEMA,
        }
        write_json(self.root / "manifest.json", manifest)
        report = {
            "checks": {
                "core_qa_overlay_count": 0,
                "core_synthetic_count": 0,
                "generated_evaluation_count": 0,
            },
            "manifest_sha256": TRAINER.sha256_file(self.root / "manifest.json"),
            "outputs": {"samples.jsonl": descriptor},
            "schema_version": TRAINER.HUMAN_EXPORT_REPORT_SCHEMA,
        }
        write_json(self.root / "report.json", report)
        marker = {
            "manifest_sha256": TRAINER.sha256_file(self.root / "manifest.json"),
            "owner": TRAINER.HUMAN_EXPORT_OWNER,
            "report_sha256": TRAINER.sha256_file(self.root / "report.json"),
            "safe_replace": True,
            "schema_version": TRAINER.HUMAN_EXPORT_SCHEMA,
        }
        write_json(self.root / TRAINER.HUMAN_EXPORT_MARKER, marker)

    def row(self, split: str, sample_id: str, work_id: str) -> dict[str, Any]:
        judgment = {
            "preferred": [self.candidates[0]],
            "acceptable": [self.candidates[1]],
            "marginal": [],
            "unacceptable": list(self.candidates[2:]),
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": False,
        }
        core = {
            "font_judgment": judgment,
            "input_bindings": {"catalog_registry_sha256": self.registry_sha},
            "provenance": {
                "approval": "completed_human_final_label",
                "qa_overlay": False,
                "synthetic": False,
            },
            "role": {"primary": "dialogue"},
            "sample_id": sample_id,
            "schema_version": TRAINER.HUMAN_SAMPLE_SCHEMA,
            "source": {"views": {name: {} for name in TRAINER.VIEW_NAMES}},
            "source_style": {
                **{field: 0.5 for field in TRAINER.STYLE_FIELDS},
                "unknown_fields": [],
            },
            "split": split,
            "treatment": {
                field: values[0]
                for field, values in TRAINER.TREATMENT_VALUES.items()
            },
            "work_id": work_id,
        }
        return TRAINER.seal_record(core)


class FakeParameter:
    def __init__(self) -> None:
        self.requires_grad = True


class FakeLayer:
    def __init__(self) -> None:
        self.parameter = FakeParameter()

    def requires_grad_(self, value: bool) -> FakeLayer:
        self.parameter.requires_grad = value
        return self

    def parameters(self):
        return iter((self.parameter,))


class FakeVision:
    def __init__(self, count: int) -> None:
        self.layers = [FakeLayer() for _ in range(count)]
        self.vision_model = SimpleNamespace(
            encoder=SimpleNamespace(layers=self.layers)
        )

    def requires_grad_(self, value: bool) -> FakeVision:
        for layer in self.layers:
            layer.requires_grad_(value)
        return self


class MangaFontStudentTests(unittest.TestCase):
    def test_runtime_and_local_encoder_contract_is_pinned(self) -> None:
        self.assertEqual(TRAINER.MODEL_ID, "google/siglip2-base-patch16-224")
        self.assertEqual(TRAINER.PROJECTION_DIM, 256)
        self.assertEqual(TRAINER.CANDIDATE_COUNT, 22)
        self.assertEqual(TRAINER.TRAINABLE_VISION_BLOCKS, 4)
        self.assertIn("candidate_scores", self._runtime_outputs())
        self.assertIn("view_gate_weights", self._runtime_outputs())

    def test_only_last_four_vision_blocks_are_trainable(self) -> None:
        vision = FakeVision(12)
        selected = TRAINER.configure_last_vision_blocks(vision, block_count=4)
        self.assertEqual(selected, (8, 9, 10, 11))
        self.assertEqual(
            [layer.parameter.requires_grad for layer in vision.layers],
            [False] * 8 + [True] * 4,
        )

    def test_mixed_batch_plan_is_reproducible_and_about_one_quarter_human(self) -> None:
        first = TRAINER.build_epoch_batches(
            synthetic_count=101,
            human_count=3,
            batch_size=16,
            human_fraction=0.25,
            seed=7,
        )
        second = TRAINER.build_epoch_batches(
            synthetic_count=101,
            human_count=3,
            batch_size=16,
            human_fraction=0.25,
            seed=7,
        )
        self.assertEqual(first, second)
        synthetic = sum(len(batch.synthetic_indices) for batch in first)
        human = sum(len(batch.human_indices) for batch in first)
        self.assertEqual(synthetic, 101)
        self.assertLess(abs(human / (human + synthetic) - 0.25), 0.03)
        self.assertGreater(human, 3)  # oversampling with replacement is explicit.

    def test_soft_acceptable_set_target_masks_unrenderable_candidates(self) -> None:
        target, mask = TRAINER.soft_target_and_mask(
            candidate_count=5,
            positive_indices=(1, 3),
            eligible_indices=(0, 1, 2, 3),
        )
        self.assertEqual(target, (0.0, 0.5, 0.0, 0.5, 0.0))
        self.assertEqual(mask, (True, True, True, True, False))
        with self.assertRaises(TRAINER.MangaFontStudentError):
            TRAINER.soft_target_and_mask(
                candidate_count=5,
                positive_indices=(4,),
                eligible_indices=(0, 1),
            )

    def test_early_stop_prioritizes_acceptable_at1_then_recall_at3(self) -> None:
        best = {
            "acceptable_at1": 0.80,
            "recall_at3": 0.90,
            "soft_listwise_loss": 0.2,
        }
        better_top1 = {
            "acceptable_at1": 0.81,
            "recall_at3": 0.1,
            "soft_listwise_loss": 9.0,
        }
        worse_top1 = {
            "acceptable_at1": 0.79,
            "recall_at3": 1.0,
            "soft_listwise_loss": 0.01,
        }
        self.assertTrue(
            TRAINER.is_better_metrics(better_top1, best, min_delta=1e-4)
        )
        self.assertFalse(
            TRAINER.is_better_metrics(worse_top1, best, min_delta=1e-4)
        )

    def test_human_test_label_is_never_json_deserialized(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = HumanExportFixture(Path(temporary) / "human")
            original_loads = TRAINER.json.loads

            def guarded_loads(value: Any, *args: Any, **kwargs: Any) -> Any:
                text = value.decode("utf-8") if isinstance(value, bytes) else str(value)
                if "sentinel-test-label" in text:
                    raise AssertionError("test label was deserialized")
                return original_loads(value, *args, **kwargs)

            with mock.patch.object(TRAINER.json, "loads", side_effect=guarded_loads):
                snapshot = TRAINER.validate_human_input(
                    fixture.root,
                    candidate_ids=fixture.candidates,
                    catalog_registry_sha256=fixture.registry_sha,
                )
        self.assertEqual(len(snapshot.train_examples), 1)
        self.assertEqual(len(snapshot.val_examples), 1)
        self.assertEqual(snapshot.skipped_test_rows, 1)
        self.assertEqual(snapshot.train_examples[0].role_index, 0)

    def test_prototype_selection_is_balanced_and_deterministic(self) -> None:
        candidates = tuple(f"font-{index:02d}" for index in range(22))
        examples = [
            TRAINER.SyntheticExample(
                sample_id=f"{candidate}-{local}",
                split="train",
                font_id=candidate,
                label_index=index,
                views={},
            )
            for index, candidate in enumerate(candidates)
            for local in reversed(range(3))
        ]
        selected, bags = TRAINER.select_prototype_examples(
            examples, candidate_ids=candidates, per_font=2
        )
        self.assertEqual(len(selected), 44)
        self.assertTrue(all(bag["count"] == 2 for bag in bags))
        self.assertEqual([row.sample_id for row in selected[:2]], ["font-00-0", "font-00-1"])

    @staticmethod
    def _runtime_outputs() -> list[str]:
        return [
            "candidate_scores",
            "none_logits",
            "role_logits",
            "style_logits",
            *(
                f"treatment_{field}_logits"
                for field in sorted(TRAINER.TREATMENT_VALUES)
            ),
            "view_gate_weights",
        ]


if __name__ == "__main__":
    unittest.main()
