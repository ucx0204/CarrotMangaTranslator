from __future__ import annotations

import unittest

from scripts import finalize_manga_font_named_train_secondary_overlay_v1 as overlay
from scripts import build_manga_font_named_train_review_v1 as named


class FinalizeMangaFontNamedTrainSecondaryOverlayV1Test(unittest.TestCase):
    def test_partition_is_complete_and_disjoint(self) -> None:
        entry = {
            "preferred": [named.EXPECTED_IDS[0]],
            "acceptable": [named.EXPECTED_IDS[1]],
            "marginal": [named.EXPECTED_IDS[2]],
        }
        result = overlay._partition(entry, sample_id="sample")  # noqa: SLF001
        flattened = [
            value
            for tier in (
                "preferred",
                "acceptable",
                "marginal",
                "unacceptable",
                "unrenderable",
                "not_reviewed",
            )
            for value in result[tier]
        ]
        self.assertEqual(set(flattened), set(named.EXPECTED_IDS))
        self.assertEqual(len(flattened), len(set(flattened)))

    def test_partition_rejects_duplicate_candidate(self) -> None:
        value = named.EXPECTED_IDS[0]
        with self.assertRaisesRegex(
            overlay.SecondaryNamedTrainOverlayError, "invalid secondary"
        ):
            overlay._partition(  # noqa: SLF001
                {
                    "preferred": [value],
                    "acceptable": [value],
                    "marginal": [],
                },
                sample_id="sample",
            )


if __name__ == "__main__":
    unittest.main()
