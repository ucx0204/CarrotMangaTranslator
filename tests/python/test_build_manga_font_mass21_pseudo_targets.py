from __future__ import annotations

import unittest

from scripts import build_manga_font_mass21_pseudo_targets as pseudo
from scripts import build_manga_font_legacy15_train_overlay_v1 as legacy15


ACTIVE = tuple(value for value in legacy15.FULL22_CANDIDATE_IDS if value != "gugi")


def head(selected: str, probabilities: tuple[float, ...], ids: tuple[str, ...]) -> dict:
    return {
        "selected_font_id": selected,
        "top1_margin": 0.01,
        "top5": [
            {
                "font_id": font_id,
                "probability": probability,
                "rank": index + 1,
            }
            for index, (font_id, probability) in enumerate(zip(ids, probabilities))
        ],
    }


def pass_row(ranker_font: str, direct_font: str) -> dict:
    ranker_ids = (ranker_font,) + tuple(
        value
        for value in ("nanum-gothic", "nanum-myeongjo", "jua", "single-day", "gaegu")
        if value != ranker_font
    )[:4]
    direct_ids = (direct_font,) + tuple(
        value
        for value in ("nanum-barun-gothic", "ridi-batang", "gaegu", "dohyeon", "jua")
        if value != direct_font
    )[:4]
    return {
        "ranker": head(ranker_font, (0.25, 0.12, 0.09, 0.07, 0.05), ranker_ids),
        "direct_reference": head(
            direct_font, (0.20, 0.11, 0.08, 0.06, 0.05), direct_ids
        ),
    }


class BuildMangaFontMass21PseudoTargetsTest(unittest.TestCase):
    def test_dense_top5_preserves_observed_and_spreads_omitted_mass(self) -> None:
        source = (*ACTIVE, "gugi")
        value = head(
            "nanum-gothic",
            (0.20, 0.10, 0.08, 0.06, 0.04),
            (
                "nanum-gothic",
                "nanum-myeongjo",
                "jua",
                "gaegu",
                "single-day",
            ),
        )

        dense = pseudo._dense_top5(value, source_ids=source, location="fixture")

        self.assertEqual(len(dense), 22)
        self.assertAlmostEqual(sum(dense), 1.0)
        self.assertAlmostEqual(dense[source.index("nanum-gothic")], 0.20)
        self.assertAlmostEqual(
            dense[source.index("mongtori")], (1.0 - 0.48) / 17.0
        )

    def test_fusion_removes_gugi_and_retains_dense_active21_simplex(self) -> None:
        probabilities, weight, metadata = pseudo._fused_target(
            pass_row("gugi", "nanum-gothic"),
            pass_row("gugi", "nanum-gothic"),
            active_ids=ACTIVE,
        )

        self.assertEqual(len(probabilities), 21)
        self.assertNotIn("gugi", ACTIVE)
        self.assertAlmostEqual(sum(probabilities), 1.0)
        self.assertTrue(all(value > 0.0 for value in probabilities))
        self.assertLess(weight, 0.08)
        self.assertTrue(metadata["retired_top1_downweighted"])

    def test_agreeing_nonretired_teachers_receive_more_weight(self) -> None:
        _, agreeing, agreeing_metadata = pseudo._fused_target(
            pass_row("nanum-gothic", "nanum-gothic"),
            pass_row("nanum-gothic", "nanum-gothic"),
            active_ids=ACTIVE,
        )
        _, disagreeing, _ = pseudo._fused_target(
            pass_row("jua", "nanum-gothic"),
            pass_row("nanum-gothic", "ridi-batang"),
            active_ids=ACTIVE,
        )

        self.assertGreater(agreeing, disagreeing)
        self.assertTrue(agreeing_metadata["pass_agreement"])
        self.assertTrue(agreeing_metadata["pass2_head_agreement"])

    def test_record_seal_excludes_its_own_field(self) -> None:
        row = {"sample_id": "sample", "weight": 0.1}
        sealed = {**row, "record_sha256": pseudo._record_sha(row)}
        self.assertEqual(sealed["record_sha256"], pseudo._record_sha(sealed))


if __name__ == "__main__":
    unittest.main()
