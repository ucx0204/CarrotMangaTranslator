import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts import build_manga_font_legacy_new7_remaining120_draft_v1 as remaining


REPO_ROOT = Path(__file__).resolve().parents[2]
REVIEW_DIR = (
    REPO_ROOT
    / "artifacts"
    / "manga-font-legacy-new7-expansion-review-variant160-v1"
)
SOURCE_PATH = (
    REPO_ROOT
    / "artifacts"
    / "manga-font-legacy-new7-expansion-remaining120-visual-judgments-source-v1.json"
)
DRAFT_DIR = (
    REPO_ROOT
    / "artifacts"
    / "manga-font-legacy-new7-expansion-visual-draft-remaining120-v1"
)


class Remaining120DraftTest(unittest.TestCase):
    def valid_profile(self) -> dict:
        return {
            "preferred": [remaining.NEW7_IDS[0]],
            "acceptable": [remaining.NEW7_IDS[1]],
            "marginal": [remaining.NEW7_IDS[2]],
            "unacceptable": list(remaining.NEW7_IDS[3:]),
            "notes": "explicit seven-way visual partition",
        }

    def test_profile_expands_exact_new7_into_four_final_tiers(self) -> None:
        tiers, notes = remaining._normalize_profile(  # noqa: SLF001
            self.valid_profile(), location="profile"
        )
        self.assertEqual(list(tiers), list(remaining.NEW7_IDS))
        self.assertEqual(set(tiers.values()), set(remaining.FINAL_TIERS))
        self.assertEqual(notes, "explicit seven-way visual partition")

    def test_profile_rejects_duplicate_or_implicit_candidate(self) -> None:
        duplicate = self.valid_profile()
        duplicate["acceptable"].append(remaining.NEW7_IDS[0])
        with self.assertRaisesRegex(remaining.Remaining120DraftError, "duplicate"):
            remaining._normalize_profile(duplicate, location="profile")  # noqa: SLF001

        missing = self.valid_profile()
        missing["unacceptable"].pop()
        with self.assertRaisesRegex(remaining.Remaining120DraftError, "all seven"):
            remaining._normalize_profile(missing, location="profile")  # noqa: SLF001

    def test_safe_output_rejects_workspace_or_home(self) -> None:
        with self.assertRaises(remaining.Remaining120DraftError):
            remaining._safe_output(Path.cwd())  # noqa: SLF001
        with self.assertRaises(remaining.Remaining120DraftError):
            remaining._safe_output(Path.home())  # noqa: SLF001

    @unittest.skipUnless(REVIEW_DIR.exists() and SOURCE_PATH.exists(), "sealed inputs absent")
    def test_real_source_is_exact_rank41_160_and_not_first40(self) -> None:
        expected = remaining._expected_rows(REVIEW_DIR)  # noqa: SLF001
        source = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))
        normalized, audit = remaining._normalize_source(source, expected)  # noqa: SLF001
        self.assertEqual(len(normalized), 120)
        self.assertEqual(
            [row["selection_rank"] for row in normalized], list(range(41, 161))
        )
        first40 = {
            row["sample_id"]
            for row in remaining._read_review_rows(REVIEW_DIR)[:40]  # noqa: SLF001
        }
        self.assertFalse(first40 & {row["sample_id"] for row in normalized})
        self.assertTrue(all(set(row["new7_tiers"]) == set(remaining.NEW7_IDS) for row in normalized))
        self.assertEqual(audit["visual_rows_opened"], 120)

    @unittest.skipUnless(REVIEW_DIR.exists() and SOURCE_PATH.exists(), "sealed inputs absent")
    def test_real_source_rejects_rank_drift(self) -> None:
        expected = remaining._expected_rows(REVIEW_DIR)  # noqa: SLF001
        source = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))
        tampered = copy.deepcopy(source)
        sample_id = expected[0]["sample_id"]
        tampered["judgments"][sample_id]["selection_rank"] = 42
        with self.assertRaisesRegex(remaining.Remaining120DraftError, "rank drifted"):
            remaining._normalize_source(tampered, expected)  # noqa: SLF001

    @unittest.skipUnless(REVIEW_DIR.exists() and DRAFT_DIR.exists(), "draft absent")
    def test_published_bundle_passes_hash_boundary_validation(self) -> None:
        result = remaining.validate_draft(DRAFT_DIR, REVIEW_DIR)
        self.assertEqual(result["draft_count"], 120)
        self.assertEqual(result["selection_rank_range"], [41, 160])
        self.assertEqual(result["first40_overlap_count"], 0)
        self.assertEqual(result["test_overlap_count"], 0)
        self.assertEqual(result["fresh64_overlap_count"], 0)
        self.assertEqual(result["qa40_overlap_count"], 0)
        self.assertEqual(result["legacy15_membership_mutations"], 0)


if __name__ == "__main__":
    unittest.main()
