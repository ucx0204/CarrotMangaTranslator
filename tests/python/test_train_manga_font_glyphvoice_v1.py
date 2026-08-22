from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import torch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

MODEL_SPEC = importlib.util.spec_from_file_location(
    "manga_font_glyphvoice_v1_model_test",
    SCRIPT_DIR / "manga_font_glyphvoice_v1_model.py",
)
assert MODEL_SPEC is not None and MODEL_SPEC.loader is not None
MODEL = importlib.util.module_from_spec(MODEL_SPEC)
MODEL_SPEC.loader.exec_module(MODEL)

TRAIN_SPEC = importlib.util.spec_from_file_location(
    "train_manga_font_glyphvoice_v1_test",
    SCRIPT_DIR / "train_manga_font_glyphvoice_v1.py",
)
assert TRAIN_SPEC is not None and TRAIN_SPEC.loader is not None
TRAIN = importlib.util.module_from_spec(TRAIN_SPEC)
sys.modules[TRAIN_SPEC.name] = TRAIN
TRAIN_SPEC.loader.exec_module(TRAIN)


class GlyphVoiceModelTest(unittest.TestCase):
    def test_local_model_keeps_multiscale_stroke_tokens_and_scores_candidates(
        self,
    ) -> None:
        torch.manual_seed(1)
        model = MODEL.GlyphVoiceLocalModel().eval()
        queries = torch.rand(2, 3, MODEL.INPUT_SIZE, MODEL.INPUT_SIZE)
        candidates = torch.rand(4, 2, 3, MODEL.INPUT_SIZE, MODEL.INPUT_SIZE)
        with torch.inference_mode():
            scores, global_embedding, tokens = model.score(queries, candidates)
        self.assertEqual(scores.shape, (2, 4))
        self.assertEqual(global_embedding.shape, (2, MODEL.EMBED_DIM))
        self.assertEqual(tokens.shape, (2, MODEL.TOKEN_COUNT, MODEL.TOKEN_DIM))
        self.assertTrue(torch.isfinite(scores).all())
        inventory = MODEL.model_inventory(model)
        self.assertGreater(inventory["parameter_count"], 100_000)
        self.assertLess(inventory["parameter_count"], 1_000_000)

    def test_candidate_query_sampler_is_balanced_across_all_candidates(self) -> None:
        targets = torch.tensor([0, 0, 0, 1, 1, 2, 2, 2, 2])
        indices = TRAIN._sample_candidate_query_indices(  # noqa: SLF001
            targets,
            queries_per_candidate=3,
            rng=__import__("random").Random(7),
        )
        sampled = targets[indices]
        self.assertEqual(torch.bincount(sampled, minlength=3).tolist(), [3, 3, 3])

    def test_voice_set_is_exact_local_at_zero_initialization(self) -> None:
        torch.manual_seed(2)
        voice = MODEL.PageVoiceSet(21).eval()
        logits = torch.randn(3, 5, 21)
        embeddings = torch.randn(3, 5, MODEL.EMBED_DIM)
        padding = torch.tensor(
            [
                [False, False, False, False, False],
                [False, False, False, True, True],
                [False, False, True, True, True],
            ]
        )
        with torch.inference_mode():
            refined, exception, residual = voice(logits, embeddings, padding)
        self.assertTrue(torch.equal(refined, logits))
        self.assertEqual(int(torch.count_nonzero(residual)), 0)
        self.assertTrue(torch.isfinite(exception).all())

    def test_partial_label_loss_never_backpropagates_to_unreviewed_candidate(
        self,
    ) -> None:
        logits = torch.tensor([[0.2, -0.1, 0.3, 9.0]], requires_grad=True)
        eligible = torch.tensor([[True, True, True, False]])
        positive = torch.tensor([[True, False, False, False]])
        preferred = torch.tensor([[True, False, False, False]])
        weights = torch.ones(1)
        loss = MODEL.partial_set_nll(logits, eligible, positive, preferred, weights)
        loss.backward()
        assert logits.grad is not None
        self.assertEqual(float(logits.grad[0, 3]), 0.0)
        self.assertGreater(abs(float(logits.grad[0, 0])), 0.0)

    def test_synthetic_pair_sampler_can_form_cross_script_positive(self) -> None:
        rows = [
            TRAIN.SyntheticRow(
                sample_id="ja",
                face_id="bridge",
                family_id="family",
                script="japanese",
                split="train",
                category="cross_script_bridge",
                image_path=Path("ja.png"),
            ),
            TRAIN.SyntheticRow(
                sample_id="ko",
                face_id="bridge",
                family_id="family",
                script="korean",
                split="train",
                category="cross_script_bridge",
                image_path=Path("ko.png"),
            ),
            TRAIN.SyntheticRow(
                sample_id="ja2",
                face_id="mono",
                family_id="other",
                script="japanese",
                split="train",
                category="japanese_only",
                image_path=Path("ja2.png"),
            ),
            TRAIN.SyntheticRow(
                sample_id="ja3",
                face_id="mono",
                family_id="other",
                script="japanese",
                split="train",
                category="japanese_only",
                image_path=Path("ja3.png"),
            ),
        ]
        groups = {"bridge": [0, 1], "mono": [2, 3]}
        indices = TRAIN._sample_synthetic_pair_indices(  # noqa: SLF001
            rows, groups, face_count=2, rng=__import__("random").Random(3)
        )
        pairs = [indices[offset : offset + 2] for offset in range(0, len(indices), 2)]
        bridge_pair = next(pair for pair in pairs if rows[pair[0]].face_id == "bridge")
        self.assertEqual(
            {rows[index].script for index in bridge_pair}, {"japanese", "korean"}
        )

    def test_reviewed_pairwise_loss_prefers_positive_over_reviewed_negative(
        self,
    ) -> None:
        logits = torch.tensor([[0.0, 0.0, 7.0]], requires_grad=True)
        eligible = torch.tensor([[True, True, False]])
        positive = torch.tensor([[True, False, False]])
        preferred = torch.tensor([[True, False, False]])
        pair, preference, bce = TRAIN._reviewed_pairwise_loss(  # noqa: SLF001
            logits, eligible, positive, preferred, torch.ones(1)
        )
        (pair + preference + bce).backward()
        assert logits.grad is not None
        self.assertLess(float(logits.grad[0, 0]), 0.0)
        self.assertGreater(float(logits.grad[0, 1]), 0.0)
        self.assertEqual(float(logits.grad[0, 2]), 0.0)


if __name__ == "__main__":
    unittest.main()
