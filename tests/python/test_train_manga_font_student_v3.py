from __future__ import annotations

import unittest
from types import MappingProxyType

import torch

from scripts import train_manga_font_student_v1 as base
from scripts import train_manga_font_student_v3 as trainer


def human_example(
    *,
    sample_id: str,
    role: str,
    candidates: tuple[str, ...],
    preferred: tuple[str, ...],
    acceptable: tuple[str, ...] = (),
    not_reviewed: tuple[str, ...] = (),
    unrenderable: tuple[str, ...] = (),
) -> base.HumanExample:
    candidate_index = {value: index for index, value in enumerate(candidates)}
    return base.HumanExample(
        sample_id=sample_id,
        work_id=f"work-{sample_id}",
        split="val",
        positive_indices=tuple(
            candidate_index[value] for value in (*preferred, *acceptable)
        ),
        eligible_indices=tuple(
            index
            for index, value in enumerate(candidates)
            if value not in {*not_reviewed, *unrenderable}
        ),
        none_target=0.0,
        role_index=base.ROLE_VALUES.index(role),
        style_values=tuple(0.0 for _ in base.STYLE_FIELDS),
        style_mask=tuple(False for _ in base.STYLE_FIELDS),
        treatment_indices=tuple(0 for _ in base.TREATMENT_VALUES),
        row=MappingProxyType(
            {
                "font_judgment": {
                    "preferred": list(preferred),
                    "acceptable": list(acceptable),
                    "not_reviewed": list(not_reviewed),
                    "unrenderable": list(unrenderable),
                }
            }
        ),
    )


class TrainMangaFontStudentV3Test(unittest.TestCase):
    def test_tiered_materializer_can_use_captured_base_without_recursing(self) -> None:
        candidates = ("a", "b")
        example = human_example(
            sample_id="materialize",
            role="shout",
            candidates=candidates,
            preferred=("b",),
        )

        def captured(**_kwargs: object) -> dict[str, torch.Tensor]:
            return {
                "human_targets": torch.zeros((1, 2)),
                "sentinel": torch.ones((1,)),
            }

        result = trainer._tiered_materialize(  # noqa: SLF001
            torch=torch,
            processor=object(),
            resolver=object(),
            synthetic_examples=(),
            human_examples=(example,),
            candidate_ids=candidates,
            base_materialize=captured,
        )
        self.assertEqual(result["sentinel"].item(), 1.0)
        self.assertEqual(
            result["human_targets"].tolist(),
            [[0.0, trainer.PREFERRED_CODE]],
        )

    def test_runtime_score_is_exact_prototype_plus_deployed_residual(self) -> None:
        torch.manual_seed(7)
        ranker = trainer.build_runtime_ranker_v3(
            torch, candidate_count=3, dropout=0.0, residual_scale=0.75
        ).eval()
        views = torch.randn(2, 3, base.PROJECTION_DIM)
        prototypes = torch.randn(6, base.PROJECTION_DIM)
        bags = (torch.tensor([0, 1]), torch.tensor([2, 3]), torch.tensor([4, 5]))
        output = ranker(views, prototypes, bags)
        torch.testing.assert_close(
            output["candidate_scores"],
            output["prototype_candidate_scores"]
            + output["candidate_residual_scores"],
        )

    def test_candidate_residual_has_no_frequency_bias(self) -> None:
        ranker = trainer.build_runtime_ranker_v3(
            torch, candidate_count=4, dropout=0.0, residual_scale=1.0
        )
        self.assertIsNone(ranker.candidate_residual.bias)

    def test_human_deployment_loss_backpropagates_to_residual_candidates(self) -> None:
        torch.manual_seed(9)
        ranker = trainer.build_runtime_ranker_v3(
            torch, candidate_count=3, dropout=0.0, residual_scale=1.0
        )
        output = ranker(
            torch.randn(2, 3, base.PROJECTION_DIM),
            torch.randn(3, base.PROJECTION_DIM),
            (torch.tensor([0]), torch.tensor([1]), torch.tensor([2])),
        )
        targets = torch.tensor(
            [
                [trainer.PREFERRED_CODE, 0.0, trainer.ACCEPTABLE_CODE],
                [0.0, trainer.PREFERRED_CODE, 0.0],
            ]
        )
        loss = trainer.tiered_deployment_loss(
            torch,
            output["candidate_scores"],
            targets,
            torch.ones_like(targets, dtype=torch.bool),
            preferred_weight=1.0,
            acceptable_weight=0.2,
        )
        loss.backward()
        self.assertIsNotNone(ranker.candidate_residual.weight.grad)
        self.assertGreater(float(ranker.candidate_residual.weight.grad.abs().sum()), 0.0)

    def test_tiered_loss_rewards_preferred_set_mass(self) -> None:
        targets = torch.tensor(
            [[trainer.PREFERRED_CODE, trainer.ACCEPTABLE_CODE, 0.0]]
        )
        mask = torch.ones_like(targets, dtype=torch.bool)
        flat = trainer.tiered_deployment_loss(
            torch,
            torch.zeros((1, 3)),
            targets,
            mask,
            preferred_weight=1.0,
            acceptable_weight=0.2,
        )
        preferred = trainer.tiered_deployment_loss(
            torch,
            torch.tensor([[5.0, 0.0, 0.0]]),
            targets,
            mask,
            preferred_weight=1.0,
            acceptable_weight=0.2,
        )
        self.assertLess(float(preferred), float(flat))

    def test_legacy15_partial_scope_masks_successor_candidates_exactly(self) -> None:
        candidates = ("old-a", "old-b", "new-c", "new-d")
        example = human_example(
            sample_id="legacy-partial",
            role="sfx_impact",
            candidates=candidates,
            preferred=("old-a",),
            acceptable=("old-b",),
            not_reviewed=("new-c", "new-d"),
        )
        scope = trainer.candidate_supervision_scope(example, candidates)
        self.assertTrue(scope["partial_candidate_supervision"])
        self.assertFalse(scope["none_auxiliary_supervised"])
        self.assertEqual(example.eligible_indices, (0, 1))

        logits = torch.tensor([[0.0, 0.0, 50.0, 60.0]], requires_grad=True)
        targets = torch.tensor(
            [[trainer.PREFERRED_CODE, trainer.ACCEPTABLE_CODE, 0.0, 0.0]]
        )
        masks = torch.tensor([[True, True, False, False]])
        loss = trainer.tiered_deployment_loss(
            torch,
            logits,
            targets,
            masks,
            preferred_weight=1.0,
            acceptable_weight=0.2,
        )
        loss.backward()
        torch.testing.assert_close(logits.grad[0, 2:], torch.zeros(2))

    def test_partial_scope_masks_none_auxiliary_but_keeps_other_tasks(self) -> None:
        outputs = {
            "none_logits": torch.tensor([2.0], requires_grad=True),
            "role_logits": torch.zeros((1, len(base.ROLE_VALUES)), requires_grad=True),
            "style_logits": torch.zeros((1, len(base.STYLE_FIELDS)), requires_grad=True),
            "treatment_logits": {
                field: torch.zeros((1, len(values)), requires_grad=True)
                for field, values in base.TREATMENT_VALUES.items()
            },
        }
        loss, parts = trainer.masked_human_auxiliary_loss(
            torch=torch,
            outputs=outputs,
            none_targets=torch.ones(1),
            none_masks=torch.zeros(1, dtype=torch.bool),
            role_targets=torch.zeros(1, dtype=torch.long),
            style_targets=torch.zeros((1, len(base.STYLE_FIELDS))),
            style_masks=torch.ones((1, len(base.STYLE_FIELDS)), dtype=torch.bool),
            treatment_targets=torch.zeros(
                (1, len(base.TREATMENT_VALUES)), dtype=torch.long
            ),
        )
        loss.backward()
        self.assertEqual(parts["none_supervised_rows"], 0)
        self.assertIsNone(outputs["none_logits"].grad)
        self.assertGreater(float(outputs["role_logits"].grad.abs().sum()), 0.0)

    def test_diversity_loss_detects_collapsed_candidate_vectors(self) -> None:
        ranker = trainer.build_runtime_ranker_v3(
            torch, candidate_count=3, dropout=0.0, residual_scale=1.0
        )
        with torch.no_grad():
            ranker.candidate_residual.weight.fill_(1.0)
        collapsed = trainer.candidate_weight_diversity_loss(torch, ranker)
        with torch.no_grad():
            ranker.candidate_residual.weight.zero_()
            ranker.candidate_residual.weight[:, :3].copy_(torch.eye(3))
        diverse = trainer.candidate_weight_diversity_loss(torch, ranker)
        self.assertGreater(float(collapsed.detach()), float(diverse.detach()))

    def test_frequency_weights_are_bounded_and_train_label_only(self) -> None:
        candidates = ("a", "b", "c")
        examples = [
            human_example(
                sample_id=f"a-{index}",
                role="shout",
                candidates=candidates,
                preferred=("a",),
            )
            for index in range(8)
        ]
        examples.append(
            human_example(
                sample_id="rare",
                role="shout",
                candidates=candidates,
                preferred=("c",),
            )
        )
        weights = trainer.human_frequency_row_weights(examples, candidates)
        self.assertTrue(all(0.5 <= value <= 2.0 for value in weights))
        self.assertGreater(weights[-1], weights[0])

    def test_epoch_batches_balance_full22_and_partial_sources(self) -> None:
        candidates = ("old-a", "old-b", "new-c")
        full = human_example(
            sample_id="full",
            role="dialogue",
            candidates=candidates,
            preferred=("new-c",),
        )
        partial = [
            human_example(
                sample_id=f"partial-{index}",
                role="sfx_impact",
                candidates=candidates,
                preferred=("old-a",),
                not_reviewed=("new-c",),
            )
            for index in range(6)
        ]
        source = tuple([full, *partial])
        batches = (
            base.EpochBatch((0, 1), (1, 2, 3, 4)),
            base.EpochBatch((2, 3), (2, 3, 4, 5)),
        )
        balanced = trainer.rebalance_epoch_human_batches(
            batches,
            source,
            candidates,
            partial_fraction=0.5,
            seed=7,
        )
        for batch in balanced:
            self.assertEqual(sum(index == 0 for index in batch.human_indices), 2)
            self.assertEqual(sum(index != 0 for index in batch.human_indices), 2)

    def test_constant_baseline_reports_preferred_acceptable_and_variant(self) -> None:
        candidates = ("a", "b", "c")
        rows = (
            human_example(
                sample_id="one",
                role="dialogue",
                candidates=candidates,
                preferred=("a",),
                acceptable=("b",),
            ),
            human_example(
                sample_id="two",
                role="shout",
                candidates=candidates,
                preferred=("b",),
                acceptable=("a",),
            ),
            human_example(
                sample_id="three",
                role="sfx_impact",
                candidates=candidates,
                preferred=("b",),
            ),
        )
        result = trainer.constant_candidate_baseline(rows, candidates)
        self.assertEqual(result["preferred_at1"]["candidate_id"], "b")
        self.assertEqual(result["variant_preferred_at1"]["rate"], 1.0)
        self.assertEqual(result["acceptable_at1"]["rate"], 1.0)

    def test_quality_gate_rejects_constant_equivalent_collapse(self) -> None:
        baseline = {
            "acceptable_at1": {"rate": 0.5},
            "preferred_at1": {"rate": 0.25},
            "variant_acceptable_at1": {"rate": 0.6},
            "variant_preferred_at1": {"rate": 0.3},
        }
        metrics = {
            "acceptable_at1": 0.5,
            "preferred_at1": 0.25,
            "variant_preferred_at1": 0.3,
            "top1_unique_candidate_count": 1,
            "top1_max_candidate_share": 1.0,
        }
        gate = trainer.evaluate_quality_gate(
            metrics,
            baseline,
            minimum_preferred_gain=0.03,
            minimum_acceptable_gain=0.02,
            maximum_top1_share=0.55,
            minimum_unique_top1=4,
        )
        self.assertFalse(gate["passed"])
        self.assertFalse(gate["checks"]["top1_distribution_not_collapsed"])

    def test_parser_requires_both_named_overlay_stages(self) -> None:
        parser = trainer.build_parser()
        args = parser.parse_args(
            [
                "preflight",
                "--synthetic-dir",
                "synthetic",
                "--human-export-dir",
                "human",
                "--human-val-overlay-dir",
                "val-overlay",
                "--human-val-finals-dir",
                "val-finals",
                "--human-train-overlay-dir",
                "train48",
                "--human-train-secondary-overlay-dir",
                "secondary3",
                "--human-train-secondary-corrections",
                "corrections.json",
                "--human-train-legacy15-overlay-dir",
                "legacy15",
                "--catalog-registry",
                "registry.json",
                "--warm-start-student-dir",
                "v2",
            ]
        )
        self.assertEqual(args.human_train_overlay_dir.name, "train48")
        self.assertEqual(
            args.human_train_secondary_overlay_dir.name, "secondary3"
        )
        self.assertEqual(args.human_train_secondary_corrections.name, "corrections.json")
        self.assertEqual(args.human_train_legacy15_overlay_dir.name, "legacy15")


if __name__ == "__main__":
    unittest.main()
