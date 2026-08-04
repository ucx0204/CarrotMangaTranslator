from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from types import MappingProxyType
from unittest import mock

import torch

from scripts import train_manga_font_student_v1 as base
from scripts import train_manga_font_student_v2 as trainer


def human_example(
    *,
    preferred: tuple[str, ...],
    acceptable: tuple[str, ...],
    candidates: tuple[str, ...],
    none_target: float = 0.0,
) -> base.HumanExample:
    candidate_index = {value: index for index, value in enumerate(candidates)}
    positives = (*preferred, *acceptable)
    return base.HumanExample(
        sample_id="human-1",
        work_id="work-1",
        split="train",
        positive_indices=tuple(candidate_index[value] for value in positives),
        eligible_indices=tuple(range(len(candidates))),
        none_target=none_target,
        role_index=0,
        style_values=tuple(0.0 for _ in base.STYLE_FIELDS),
        style_mask=tuple(False for _ in base.STYLE_FIELDS),
        treatment_indices=tuple(0 for _ in base.TREATMENT_VALUES),
        row=MappingProxyType(
            {
                "font_judgment": {
                    "preferred": list(preferred),
                    "acceptable": list(acceptable),
                }
            }
        ),
    )


def synthetic_example(sample_id: str, font_id: str) -> base.SyntheticExample:
    return base.SyntheticExample(
        sample_id=sample_id,
        split="train",
        font_id=font_id,
        label_index=0,
        views=MappingProxyType({}),
    )


class TrainMangaFontStudentV2Test(unittest.TestCase):
    def test_legacy_val_only_v2_extension_remains_valid(self) -> None:
        contract = {
            "source_code_sha256": "base-trainer-sha",
            "trainer_extension": {
                "base_trainer_source_code_sha256": "base-trainer-sha",
                "human_val_overlay": {
                    "base_train_record_count": 109,
                    "status": "ready_for_val_only_merge",
                    "val_record_count": 33,
                },
                "schema_version": trainer.EXTENSION_SCHEMA,
                "source_code_sha256": next(
                    iter(trainer.LEGACY_VAL_ONLY_SOURCE_SHA256S)
                ),
            },
            "prototype_bank": {"selection_policy": trainer.PROTOTYPE_POLICY},
        }
        with (
            mock.patch.object(base, "validate_output", return_value={"status": "ready"}),
            mock.patch.object(base, "read_json", return_value=contract),
        ):
            result = trainer.validate_v2_output(Path("legacy-v2"))
        self.assertEqual(result["training_extension"], trainer.EXTENSION_SCHEMA)

    def test_present_train_overlay_is_validated_fail_closed(self) -> None:
        contract = {
            "source_code_sha256": "base-trainer-sha",
            "trainer_extension": {
                "base_trainer_source_code_sha256": "base-trainer-sha",
                "human_train_overlay": {"status": "tampered"},
                "human_val_overlay": {
                    "base_train_record_count": 109,
                    "status": "ready_for_val_only_merge",
                    "val_record_count": 33,
                },
                "schema_version": trainer.EXTENSION_SCHEMA,
                "source_code_sha256": base.sha256_file(
                    Path(trainer.__file__).resolve()
                ),
            },
            "prototype_bank": {"selection_policy": trainer.PROTOTYPE_POLICY},
        }
        with (
            mock.patch.object(base, "validate_output", return_value={"status": "ready"}),
            mock.patch.object(base, "read_json", return_value=contract),
            self.assertRaisesRegex(trainer.MangaFontStudentV2Error, "train overlay"),
        ):
            trainer.validate_v2_output(Path("named-overlay-v2"))

    def test_tier_codes_preserve_preferred_and_acceptable(self) -> None:
        candidates = ("a", "b", "c", "d")
        example = human_example(
            preferred=("b",), acceptable=("c", "d"), candidates=candidates
        )
        self.assertEqual(
            trainer.tier_code_target(example, candidates),
            (0.0, trainer.PREFERRED_CODE, trainer.ACCEPTABLE_CODE, trainer.ACCEPTABLE_CODE),
        )

    def test_acceptable_only_legacy_row_becomes_primary_set(self) -> None:
        candidates = ("a", "b", "c")
        example = human_example(
            preferred=(), acceptable=("a", "c"), candidates=candidates
        )
        self.assertEqual(
            trainer.tier_code_target(example, candidates),
            (trainer.PREFERRED_CODE, 0.0, trainer.PREFERRED_CODE),
        )

    def test_none_acceptable_row_stays_inactive_for_font_loss(self) -> None:
        candidates = ("a", "b", "c")
        example = human_example(
            preferred=(),
            acceptable=(),
            candidates=candidates,
            none_target=1.0,
        )
        self.assertEqual(trainer.tier_code_target(example, candidates), (0.0, 0.0, 0.0))
        targets = torch.zeros((1, 3), dtype=torch.float32)
        loss = trainer.tiered_partial_label_loss(
            torch,
            torch.tensor([[2.0, 1.0, 0.0]]),
            targets,
            torch.ones_like(targets, dtype=torch.bool),
            preferred_weight=1.0,
            acceptable_weight=0.25,
        )
        self.assertEqual(float(loss), 0.0)

    def test_partial_label_loss_uses_set_mass_not_uniform_member_ce(self) -> None:
        logits = torch.zeros((1, 4), dtype=torch.float32)
        targets = torch.tensor(
            [[trainer.PREFERRED_CODE, trainer.ACCEPTABLE_CODE, 0.0, 0.0]]
        )
        masks = torch.ones_like(targets, dtype=torch.bool)
        loss = trainer.tiered_partial_label_loss(
            torch,
            logits,
            targets,
            masks,
            preferred_weight=1.0,
            acceptable_weight=0.25,
        )
        expected = (torch.log(torch.tensor(4.0)) + 0.25 * torch.log(torch.tensor(2.0))) / 1.25
        self.assertAlmostEqual(float(loss), float(expected), places=6)
        better = trainer.tiered_partial_label_loss(
            torch,
            torch.tensor([[5.0, 0.0, 0.0, 0.0]]),
            targets,
            masks,
            preferred_weight=1.0,
            acceptable_weight=0.25,
        )
        self.assertLess(float(better), float(loss))

    def test_none_rows_do_not_amplify_active_font_loss(self) -> None:
        logits = torch.zeros((2, 3), dtype=torch.float32)
        targets = torch.tensor(
            [
                [trainer.PREFERRED_CODE, 0.0, 0.0],
                [0.0, 0.0, 0.0],
            ]
        )
        masks = torch.ones_like(targets, dtype=torch.bool)
        loss = trainer.tiered_partial_label_loss(
            torch,
            logits,
            targets,
            masks,
            preferred_weight=1.0,
            acceptable_weight=0.0,
        )
        self.assertAlmostEqual(float(loss), float(torch.log(torch.tensor(3.0))) / 2.0)

    def test_stratified_prototypes_cover_role_orientation_targets(self) -> None:
        candidate_ids = ("font-a", "font-b")
        examples = []
        metadata = {}
        roles = {
            "ordinary": "dialogue",
            "expressive": "shout",
            "sfx": "sfx_impact",
            "sign": "sign_ui_title",
        }
        for font_id in candidate_ids:
            for family, role in roles.items():
                for orientation in ("horizontal", "vertical"):
                    for geometry, angle in (("clean", 0.0), ("styled", 8.0)):
                        sample_id = f"{font_id}-{family}-{orientation}-{geometry}"
                        examples.append(synthetic_example(sample_id, font_id))
                        metadata[sample_id] = {
                            "augmentation": {
                                "angle_degrees": angle,
                                "slant": 0.0,
                                "stroke_width_px": 1,
                            },
                            "orientation": orientation,
                            "role": role,
                            "text": "테스트",
                        }
        selected, bags = trainer.select_stratified_prototypes(
            examples,
            candidate_ids=candidate_ids,
            per_font=16,
            metadata=metadata,
        )
        self.assertEqual([bag["count"] for bag in bags], [16, 16])
        self.assertEqual(len(selected), 32)
        for font_id in candidate_ids:
            signatures = {
                trainer.prototype_signature(metadata[row.sample_id])
                for row in selected
                if row.font_id == font_id
            }
            self.assertEqual(len(signatures), 16)
            self.assertEqual({value[2] for value in signatures}, {"clean", "styled"})

    def test_synthetic_test_poison_is_skipped_before_json_deserialization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            train_row = {
                "augmentation": {
                    "angle_degrees": 0.0,
                    "slant": 0.0,
                    "stroke_width_px": 0,
                },
                "orientation": "horizontal",
                "role": "dialogue",
                "sample_id": "train-1",
                "split": "train",
                "text": "안녕",
            }
            (root / "manifest.jsonl").write_bytes(
                (base.canonical_json(train_row) + "\n").encode("utf-8")
                + b'{"split":"test","poison":INVALID}\n'
            )
            snapshot = base.SyntheticSnapshot(
                root=root,
                candidate_ids=("font-a",),
                train_examples=(synthetic_example("train-1", "font-a"),),
                manifest_sha256="a" * 64,
                report_sha256="b" * 64,
                record_count=2,
            )
            metadata = trainer.load_synthetic_train_metadata(snapshot)
            self.assertEqual(set(metadata), {"train-1"})

    def test_stratified_prototypes_reject_collapsed_source_inventory(self) -> None:
        examples = []
        metadata = {}
        for index in range(16):
            sample_id = f"collapsed-{index:02d}"
            examples.append(synthetic_example(sample_id, "font-a"))
            metadata[sample_id] = {
                "augmentation": {
                    "angle_degrees": 0.0,
                    "slant": 0.0,
                    "stroke_width_px": 0,
                },
                "orientation": "horizontal",
                "role": "dialogue",
                "text": "본문",
            }
        with self.assertRaisesRegex(trainer.MangaFontStudentV2Error, "coverage"):
            trainer.select_stratified_prototypes(
                examples,
                candidate_ids=("font-a",),
                per_font=12,
                metadata=metadata,
            )

    def test_metric_priority_starts_with_variant_preferred(self) -> None:
        metrics = {
            "acceptable_at1": 0.9,
            "acceptable_hit_at3": 0.8,
            "preferred_at1": 0.7,
            "tiered_gold_loss": 1.2,
            "variant_acceptable_hit_at3": 0.6,
            "variant_preferred_at1": 0.5,
        }
        self.assertEqual(trainer.metric_priority_key(metrics)[0], 0.5)

    def test_policy_monkeypatch_is_restored_after_failure(self) -> None:
        original = base._materialize_batch  # noqa: SLF001
        args = argparse.Namespace(
            preferred_loss_weight=1.0,
            acceptable_loss_weight=0.25,
        )
        with self.assertRaisesRegex(RuntimeError, "stop"):
            with trainer.patched_v1_training_policy(
                args=args, candidate_ids=("font-a",), metadata={}
            ):
                self.assertIsNot(base._materialize_batch, original)  # noqa: SLF001
                raise RuntimeError("stop")
        self.assertIs(base._materialize_batch, original)  # noqa: SLF001

    def test_parser_defaults_raise_human_and_prototype_emphasis(self) -> None:
        parser = trainer.build_parser()
        args = parser.parse_args(
            [
                "train",
                "--synthetic-dir",
                "synthetic",
                "--human-export-dir",
                "human",
                "--human-val-overlay-dir",
                "overlay",
                "--human-val-finals-dir",
                "finals",
                "--human-train-overlay-dir",
                "train-overlay",
                "--catalog-registry",
                "registry.json",
                "--output-dir",
                "output",
            ]
        )
        self.assertEqual(args.human_fraction, 0.40)
        self.assertEqual(args.prototypes_per_font, 16)
        self.assertEqual(args.preferred_loss_weight, 1.0)
        self.assertEqual(args.acceptable_loss_weight, 0.25)
        self.assertEqual(args.human_train_overlay_dir, Path("train-overlay"))


if __name__ == "__main__":
    unittest.main()
