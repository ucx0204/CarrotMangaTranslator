from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "label_font_matching_master_fast.py"
SPEC = importlib.util.spec_from_file_location("label_font_matching_master_fast_tested", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
FAST = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FAST
SPEC.loader.exec_module(FAST)


class FastFontLabelTest(unittest.TestCase):
    def test_variant_disagreement_is_reviewed_first(self) -> None:
        priority, reasons = FAST._review_priority(
            category="page_sound",
            ranker_margin=0.04,
            ranker_top1="font-a",
            direct_top1="font-b",
            variant_probability=0.9,
        )
        self.assertEqual(priority, 0)
        self.assertIn("variant_or_nonballoon_text", reasons)
        self.assertIn("small_top1_margin", reasons)
        self.assertIn("ranker_reference_disagreement", reasons)

    def test_ordinary_agreement_remains_lower_priority(self) -> None:
        priority, reasons = FAST._review_priority(
            category="ordinary",
            ranker_margin=0.4,
            ranker_top1="font-a",
            direct_top1="font-a",
            variant_probability=0.1,
        )
        self.assertEqual(priority, 2)
        self.assertEqual(reasons, ["ordinary_high_margin"])

    def test_direct_reference_score_respects_view_gate(self) -> None:
        features = np.asarray(
            [[[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]]], dtype=np.float32
        )
        prototypes = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        bags = [np.asarray([0]), np.asarray([1])]
        raw_only = np.asarray([[1.0, 0.0, 0.0]], dtype=np.float32)
        context_only = np.asarray([[0.0, 1.0, 0.0]], dtype=np.float32)
        raw_scores = FAST._direct_reference_scores(
            features=features,
            prototypes=prototypes,
            bags=bags,
            view_weights=raw_only,
        )
        context_scores = FAST._direct_reference_scores(
            features=features,
            prototypes=prototypes,
            bags=bags,
            view_weights=context_only,
        )
        self.assertGreater(raw_scores[0, 0], raw_scores[0, 1])
        self.assertGreater(context_scores[0, 1], context_scores[0, 0])

    def test_compact_index_preserves_nonblind_review_context(self) -> None:
        row = {
            "id": "fm_sample",
            "split": "train",
            "work": {"id": "work-a", "title": "작품"},
            "chapter": {"id": "chapter-a", "title": "3화"},
            "page": {"id": "page-a", "name": "003.jpg"},
            "metadata": {"candidate_primary_category": "text_free"},
            "provenance": {"source_kind": "hard"},
        }
        compact = FAST._compact_index_row(7, row)
        self.assertEqual(compact["work_title"], "작품")
        self.assertEqual(compact["chapter_title"], "3화")
        self.assertEqual(compact["source_category"], "text_free")
        self.assertEqual(compact["row_index"], 7)
        self.assertRegex(compact["record_sha256"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
