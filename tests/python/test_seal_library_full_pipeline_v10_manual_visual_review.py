from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load_script():
    path = ROOT / "scripts" / "seal_library_full_pipeline_v10_manual_visual_review.py"
    spec = importlib.util.spec_from_file_location(
        "seal_library_full_pipeline_v10_manual_visual_review_test_target", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SEALER = load_script()


def diagnostic_fixture_pages():
    counts = {page: 1 for page in range(1, 41) if page not in (3, 21, 35, 37)}
    counts.update({1: 258, 7: 3, 13: 5, 17: 13, 19: 7})
    pages = [{"fontDecisions": []} for _ in range(40)]
    flat = []
    for page_number in range(1, 41):
        for block_index in range(counts.get(page_number, 0)):
            row = {
                "blockIndex": block_index,
                "blockId": f"p{page_number}-b{block_index}",
                "sourceText": "通常",
                "translatedText": "보통",
                "selectedFontId": "ridi-batang",
                "effectiveFontFamily": "ridi-batang",
                "role": None,
                "applied": False,
                "effectiveOutlineWidthScale": None,
                "effectiveOutlineContrastRatio": None,
            }
            pages[page_number - 1]["fontDecisions"].append(row)
            flat.append((page_number, row))
    assert len(flat) == 317

    single_text = {
        (7, 2): ("やた", "허둥"),
        (13, 4): ("忙忙し", "허둥\n허둥"),
        (17, 12): ("は", "앗"),
        (19, 6): ("…けど", "...지만"),
        (23, 0): ("ひっ!!", "히익!!"),
    }
    by_key = {(page, row["blockIndex"]): row for page, row in flat}
    for key, (source, translated) in single_text.items():
        row = by_key[key]
        row["sourceText"] = source
        row["translatedText"] = translated
        row["selectedFontId"] = "single-day"
        row["effectiveFontFamily"] = "single-day"
        row["role"] = "emphasis_dialogue"

    remaining_roles = {
        "emphasis_dialogue": 228,
        "dialogue": 59,
        "narration": 3,
        "sfx_impact": 1,
        "sfx_motion": 4,
        "shout": 3,
        "sign_ui_title": 12,
        "thought": 2,
    }
    unassigned = [row for _page, row in flat if row["role"] is None]
    cursor = 0
    for role, count in remaining_roles.items():
        for row in unassigned[cursor : cursor + count]:
            row["role"] = role
        cursor += count
    assert cursor == len(unassigned)

    single_rows = [by_key[key] for key in SEALER.EXPECTED_SINGLE_DAY_KEYS]
    other_rows = [row for _page, row in flat if row not in single_rows]
    for row in single_rows + other_rows[:269]:
        row["applied"] = True
        row["effectiveOutlineWidthScale"] = 1
        row["effectiveOutlineContrastRatio"] = 18.883060964594996
    (single_rows + other_rows[:269])[0]["effectiveOutlineContrastRatio"] = 17.14286993113182
    return pages


class ManualVisualReviewSealTests(unittest.TestCase):
    def test_verdicts_partition_and_reproduce_summary(self) -> None:
        SEALER.validate_fixed_verdict_partition()
        rows = [
            {"verdict": SEALER.verdict_for_page(page_number)}
            for page_number in range(1, 41)
        ]
        summary = SEALER.aggregate_page_reviews(rows)
        self.assertEqual(summary["reviewedPages"], 40)
        self.assertEqual(summary["translatedPages"], 36)
        self.assertEqual(
            summary["verdictCounts"],
            {"good": 16, "acceptable": 13, "bad": 7, "notApplicable": 4},
        )
        self.assertEqual(summary["translatedPageRates"]["goodPercent"], 44.44)
        self.assertEqual(summary["translatedPageRates"]["acceptablePercent"], 36.11)
        self.assertEqual(summary["translatedPageRates"]["badPercent"], 19.44)
        self.assertEqual(
            summary["translatedPageRates"]["usableGoodOrAcceptablePercent"], 80.56
        )

    def test_diagnostics_are_recomputed_from_317_decisions(self) -> None:
        diagnostics = SEALER.decision_diagnostics(diagnostic_fixture_pages())
        self.assertEqual(diagnostics["blocks"]["total"], 317)
        self.assertEqual(diagnostics["blocks"]["applied"], 274)
        self.assertEqual(diagnostics["roles"]["counts"], SEALER.EXPECTED_ROLE_COUNTS)
        self.assertEqual(diagnostics["roles"]["emphasisDialogue"]["sharePercent"], 73.5)
        self.assertEqual(diagnostics["singleDay"]["appliedCount"], 5)
        self.assertTrue(diagnostics["singleDay"]["allEmphasisDialogue"])
        self.assertEqual(
            diagnostics["singleDay"]["questionableOrdinaryTrailingPhraseCount"], 1
        )
        self.assertEqual(diagnostics["outline"]["zeroWidthAppliedCount"], 0)
        self.assertEqual(diagnostics["outline"]["minimumContrastRatioRounded3"], 17.143)

    def test_single_day_outside_emphasis_fails_closed(self) -> None:
        pages = diagnostic_fixture_pages()
        single = pages[6]["fontDecisions"][2]
        dialogue = next(
            row
            for page in pages
            for row in page["fontDecisions"]
            if row["role"] == "dialogue"
        )
        single["role"], dialogue["role"] = dialogue["role"], single["role"]
        with self.assertRaisesRegex(
            SEALER.ManualVisualReviewError, "escaped the emphasis_dialogue role"
        ):
            SEALER.decision_diagnostics(pages)

    def test_outline_scale_loss_fails_closed(self) -> None:
        pages = diagnostic_fixture_pages()
        pages[0]["fontDecisions"][0]["effectiveOutlineWidthScale"] = 0
        with self.assertRaisesRegex(SEALER.ManualVisualReviewError, "lost the required outline"):
            SEALER.decision_diagnostics(pages)

    def test_exclusive_writer_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "manual-visual-review.json"
            SEALER.write_json_exclusive(output, {"first": True})
            with self.assertRaisesRegex(SEALER.ManualVisualReviewError, "Refusing to overwrite"):
                SEALER.write_json_exclusive(output, {"second": True})
            self.assertIn('"first": true', output.read_text(encoding="utf-8"))

    def test_authority_forbids_non_evaluation_uses(self) -> None:
        authority = SEALER.AUTHORITY
        self.assertEqual(authority["mode"], "evaluation_only")
        self.assertTrue(authority["evaluationEligible"])
        for key in (
            "trainingEligible",
            "trainingLabelAuthority",
            "calibrationEligible",
            "calibrationLabelAuthority",
            "pseudoLabelEligible",
            "pseudoLabelAuthority",
            "automaticLabelPromotionAllowed",
            "humanGold",
            "releaseEligible",
            "releaseAuthority",
            "automaticReleaseAuthority",
        ):
            self.assertIs(authority[key], False, key)


if __name__ == "__main__":
    unittest.main()
