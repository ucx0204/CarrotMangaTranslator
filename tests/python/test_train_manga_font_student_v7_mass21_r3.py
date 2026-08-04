from __future__ import annotations

import math
import unittest
from types import SimpleNamespace

import torch

from scripts import train_manga_font_student_v7_mass21_r3 as r3


class MangaFontV7Mass21R3Tests(unittest.TestCase):
    def test_frozen_teacher_kl_is_zero_at_warm_start_and_finite_after_drift(
        self,
    ) -> None:
        teacher = torch.randn(3, r3.v7.mass21.ACTIVE_CANDIDATE_COUNT)
        student = teacher.clone().requires_grad_(True)
        weights = torch.tensor([0.5, 1.0, 1.5])
        exact = r3.frozen_teacher_kl_loss(
            torch,
            student,
            teacher,
            weights,
            denominator=4,
            temperature=2.0,
        )
        self.assertAlmostEqual(0.0, float(exact.detach()), places=6)
        exact.backward()
        self.assertTrue(torch.isfinite(student.grad).all())
        self.assertLess(float(student.grad.abs().max()), 1e-6)

        drifted = (teacher + torch.eye(3, teacher.shape[1]) * 2.0).requires_grad_(
            True
        )
        loss = r3.frozen_teacher_kl_loss(
            torch,
            drifted,
            teacher,
            weights,
            denominator=4,
            temperature=2.0,
        )
        loss.backward()
        self.assertGreater(float(loss.detach()), 0.0)
        self.assertTrue(torch.isfinite(drifted.grad).all())

    def test_pseudo_is_only_a_confidence_sized_teacher_residual(self) -> None:
        candidates = r3.v7.mass21.ACTIVE_CANDIDATE_COUNT
        teacher = torch.zeros(1, candidates)
        pseudo = torch.zeros(1, candidates)
        pseudo[0, 0] = 1.0
        work = torch.ones(1)

        low_student = teacher.clone().requires_grad_(True)
        low, low_alpha = r3.teacher_anchored_pseudo_residual_loss(
            torch,
            low_student,
            teacher,
            pseudo,
            torch.tensor([0.10]),
            work,
            denominator=1,
            temperature=2.0,
            residual_mix=0.25,
        )
        high_student = teacher.clone().requires_grad_(True)
        high, high_alpha = r3.teacher_anchored_pseudo_residual_loss(
            torch,
            high_student,
            teacher,
            pseudo,
            torch.tensor([0.80]),
            work,
            denominator=1,
            temperature=2.0,
            residual_mix=0.25,
        )
        high.backward()

        self.assertAlmostEqual(0.025, float(low_alpha), places=7)
        self.assertAlmostEqual(0.20, float(high_alpha), places=7)
        self.assertGreater(float(high.detach()), float(low.detach()))
        self.assertTrue(torch.isfinite(high_student.grad).all())
        with self.assertRaises(r3.MangaFontV7Mass21R3Error):
            r3.teacher_anchored_pseudo_residual_loss(
                torch,
                teacher,
                teacher,
                pseudo,
                torch.tensor([1.01]),
                work,
                denominator=1,
                temperature=2.0,
                residual_mix=0.25,
            )

    def test_prototype_anchor_is_exact_at_teacher_and_positive_after_drift(
        self,
    ) -> None:
        shape = (
            r3.v7.mass21.ACTIVE_CANDIDATE_COUNT,
            r3.v7.QUERY_COUNT,
            r3.v7.QUERY_DIM,
        )
        teacher = torch.nn.functional.normalize(torch.randn(shape), p=2, dim=-1)
        exact = teacher.clone().requires_grad_(True)
        exact_loss = r3.frozen_prototype_loss(torch, exact, teacher)
        self.assertEqual(0.0, float(exact_loss.detach()))

        drifted = teacher.clone()
        drifted[0, 0, 0] += 0.5
        drifted.requires_grad_(True)
        loss = r3.frozen_prototype_loss(torch, drifted, teacher)
        loss.backward()
        self.assertGreater(float(loss.detach()), 0.0)
        self.assertTrue(torch.isfinite(drifted.grad).all())

    def test_sparse_schedule_uses_every_source_exactly_once(self) -> None:
        args = r3.build_parser().parse_args(["train"])
        inputs = SimpleNamespace(
            real=SimpleNamespace(entries=tuple(None for _ in range(19_664)))
        )
        batches = r3._epoch_batches(args, inputs, 1)

        real = [value for batch in batches for value in batch.real_indices]
        full = [value for batch in batches for value in batch.full_human_indices]
        partial = [
            value for batch in batches for value in batch.partial_human_indices
        ]
        synthetic = [
            value for batch in batches for value in batch.synthetic_indices
        ]
        self.assertEqual(1_229, len(batches))
        self.assertEqual(19_664, len(real))
        self.assertEqual(19_664, len(set(real)))
        self.assertEqual(r3.v7.mass21.SUPERVISED_FULL21_ROWS, len(full))
        self.assertEqual(len(full), len(set(full)))
        self.assertEqual(r3.v7.mass21.SUPERVISED_PARTIAL15_ROWS, len(partial))
        self.assertEqual(len(partial), len(set(partial)))
        self.assertEqual(r3.v7.mass21.SYNTHETIC21_ROWS, len(synthetic))
        self.assertEqual(len(synthetic), len(set(synthetic)))
        self.assertGreater(
            sum(not batch.full_human_indices for batch in batches), 900
        )

    def test_sparse_loss_accepts_empty_auxiliary_sources_and_is_finite(self) -> None:
        candidates = r3.v7.mass21.ACTIVE_CANDIDATE_COUNT
        real_count = 2
        logits = torch.randn(real_count, candidates, requires_grad=True)
        teacher_logits = logits.detach().clone()
        views = torch.nn.functional.normalize(
            torch.randn(real_count, 3, 4, 8), p=2, dim=-1
        )
        attention = torch.softmax(torch.randn(real_count, 3, 4, 6), dim=-1)
        prototypes = torch.nn.functional.normalize(
            torch.randn(candidates, 4, 256), p=2, dim=-1
        )
        batch = {
            "full_count": 0,
            "full_masks": torch.empty((0, candidates), dtype=torch.bool),
            "full_targets": torch.empty((0, candidates)),
            "partial_count": 0,
            "partial_masks": torch.empty((0, candidates), dtype=torch.bool),
            "partial_targets": torch.empty((0, candidates)),
            "pseudo_positions": torch.empty(0, dtype=torch.long),
            "pseudo_targets": None,
            "pseudo_weights": None,
            "real_count": real_count,
            "real_loss_denominator": real_count,
            "real_weights": torch.ones(real_count),
            "synthetic_count": 0,
            "synthetic_labels": torch.empty(0, dtype=torch.long),
        }
        result = {
            "attention": attention,
            "candidate_prototypes": prototypes,
            "candidate_scores": logits,
            "frozen_teacher_candidate_prototypes": prototypes.clone(),
            "frozen_teacher_candidate_scores": teacher_logits,
            "view_embeddings": views,
        }
        weights = r3.StableLossWeights(
            0.05, 0.10, 0.02, 0.02, 0.005, 0.25, 0.001, 2.0, 0.5, 2.0, 0.25
        )
        loss, components = r3._compute_losses(
            torch=torch, result=result, batch=batch, weights=weights
        )
        loss.backward()

        self.assertTrue(math.isfinite(float(loss.detach())))
        self.assertTrue(torch.isfinite(logits.grad).all())
        self.assertEqual(2, components["teacher_rows"])
        self.assertEqual(0, components["pseudo_rows"])
        self.assertEqual(0.0, float(components["full_human"].detach()))
        self.assertEqual(0.0, float(components["synthetic"].detach()))

    def test_defaults_are_teacher_dominant_and_safety_caps_reject_r2_lr(
        self,
    ) -> None:
        args = r3.build_parser().parse_args(["train"])
        r3._validate_cli_configuration(args)
        configuration = r3._configuration(args)

        self.assertEqual(2e-6, args.head_lr)
        self.assertEqual(2.0, args.frozen_teacher_kl_weight)
        self.assertEqual(0.10, args.full_human_weight)
        self.assertEqual(0.02, args.partial_human_weight)
        self.assertEqual(0.05, args.synthetic_weight)
        self.assertEqual(0.25, args.pseudo_weight)
        self.assertEqual(r3.TEACHER_MODE, configuration["frozen_teacher_mode"])
        self.assertEqual(0.0, configuration["family_logit_gemma_weight"])
        self.assertEqual(0.0, configuration["family_logit_role_weight"])
        self.assertEqual(0.0, configuration["family_logit_genre_weight"])

        unsafe = r3.build_parser().parse_args(["train", "--head-lr", "1e-5"])
        with self.assertRaises(r3.MangaFontV7Mass21R3Error):
            r3._validate_cli_configuration(unsafe)

    def test_runtime_patch_restores_both_imported_modules(self) -> None:
        original_v7_runtime = r3.v7._runtime
        original_r2_compute = r3.r2._compute_losses
        with r3._patched_runtime():
            self.assertIs(r3._runtime, r3.v7._runtime)
            self.assertIs(r3._compute_losses, r3.r2._compute_losses)
        self.assertIs(original_v7_runtime, r3.v7._runtime)
        self.assertIs(original_r2_compute, r3.r2._compute_losses)

    def test_checkpoint_serializes_only_student_and_preserves_epoch0(self) -> None:
        args = r3.build_parser().parse_args(["train"])
        student = torch.nn.Linear(3, 2)
        teacher = torch.nn.Linear(3, 2)
        proxy = r3.FrozenTeacherStudentProxy(
            torch,
            student,
            teacher,
            torch.zeros(21, 4, 256),
        )
        optimizer = torch.optim.AdamW(student.parameters(), lr=args.head_lr)
        baseline = {
            "evaluated_positive_rows": r3.v7.VAL_ROWS,
            "variant_val_rows": r3.v7.VARIANT_VAL_ROWS,
        }
        with r3._patched_runtime():
            payload = r3._checkpoint_payload(
                torch=torch,
                args=args,
                candidate_ids=r3.v7.mass21.candidate_projection(
                    r3.v7.mass21.legacy15.FULL22_CANDIDATE_IDS
                ).active_ids,
                model=proxy,
                optimizer=optimizer,
                epoch=1,
                next_step=0,
                stale_epochs=0,
                best_metrics=baseline,
                best_predictions=[],
                best_state=r3.v7.v6._state_cpu(proxy),
                best_prototypes=torch.zeros(21, 4, 256),
                best_epoch=0,
                history=[],
                epoch_sums={},
                epoch_steps=0,
                source_fingerprint={"teacher": "sealed"},
                baseline_val=baseline,
                weighting={"frozen_teacher": r3.TEACHER_MODE},
            )

        self.assertEqual(r3.RUN_STATE_SCHEMA, payload["schema_version"])
        self.assertEqual(baseline, payload["baseline_val"])
        self.assertEqual({"weight", "bias"}, set(payload["model_state"]))
        self.assertFalse(any("teacher" in key for key in payload["model_state"]))
        self.assertEqual(r3._source_provenance(), payload["r2_source_provenance"])

    def test_cached_teacher_scoring_matches_direct_frozen_teacher_forward(self) -> None:
        torch.manual_seed(7)
        student = r3.v7.v6.build_font_query_head(
            torch, query_count=4, query_dim=256
        )
        teacher = r3.v7.v6.build_font_query_head(
            torch, query_count=4, query_dim=256
        )
        teacher.load_state_dict(student.state_dict(), strict=True)
        reference_tokens = torch.randn(21, 2, r3.v7.HIDDEN_SIZE)
        reference_labels = torch.arange(21, dtype=torch.long)
        view_tokens = torch.randn(2, 3, 2, r3.v7.HIDDEN_SIZE)
        with torch.no_grad():
            prototypes = teacher.candidate_prototypes(
                reference_tokens, reference_labels, 21
            )
            direct = teacher(view_tokens, reference_tokens, reference_labels, 21)
        proxy = r3.FrozenTeacherStudentProxy(
            torch, student, teacher, prototypes
        ).train(True)
        result = proxy(view_tokens, reference_tokens, reference_labels, 21)

        self.assertFalse(teacher.training)
        self.assertTrue(student.training)
        self.assertTrue(
            torch.allclose(
                direct["candidate_scores"],
                result["frozen_teacher_candidate_scores"],
                atol=1e-6,
                rtol=0.0,
            )
        )
        self.assertTrue(
            torch.equal(
                prototypes, result["frozen_teacher_candidate_prototypes"]
            )
        )


if __name__ == "__main__":
    unittest.main()
