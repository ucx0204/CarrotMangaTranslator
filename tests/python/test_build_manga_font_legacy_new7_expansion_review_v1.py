import copy
import unittest

from scripts import build_manga_font_legacy_new7_expansion_review_v1 as review
from scripts import train_manga_font_student_v1 as trainer


def partial_row(index: int) -> dict:
    roles = (
        "sfx_emotion",
        "emphasis_dialogue",
        "shout",
        "aside_balloon_edge",
        "dialogue",
    )
    role = roles[index % len(roles)]
    cohorts = ["bubble_edge"] if role in {"aside_balloon_edge", "dialogue"} else []
    handwritten = 1.0 if role in {"sfx_emotion", "aside_balloon_edge", "dialogue"} else 0.0
    legacy_tiers = {
        "preferred": list(review.LEGACY15_IDS[:2]),
        "acceptable": list(review.LEGACY15_IDS[2:5]),
        "marginal": list(review.LEGACY15_IDS[5:10]),
        "unacceptable": list(review.LEGACY15_IDS[10:]),
        "unrenderable": [],
        "not_reviewed": list(review.NEW7_IDS),
        "none_acceptable": False,
    }
    return {
        "chapter_id": f"chapter-{index}",
        "cohorts": cohorts,
        "font_judgment": legacy_tiers,
        "page_id": f"page-{index}",
        "record_sha256": f"{index:064x}"[-64:],
        "role": {"primary": role},
        "sample_id": f"sample-{index}",
        "source": {
            "sample_crop_sha256": f"{index + 1000:064x}"[-64:],
            "source_page_sha256": f"{index + 2000:064x}"[-64:],
        },
        "source_style": {
            "energy": 0.8,
            "handwritten": handwritten,
            "irregularity": handwritten,
            "slant": 0.2,
        },
        "work_id": f"work-{index % 15}",
    }


def example(index: int) -> trainer.HumanExample:
    row = partial_row(index)
    return trainer.HumanExample(
        sample_id=row["sample_id"],
        work_id=row["work_id"],
        split="train",
        positive_indices=(0,),
        eligible_indices=tuple(range(15)),
        none_target=0.0,
        role_index=0,
        style_values=(),
        style_mask=(),
        treatment_indices=(),
        row=row,
    )


class LegacyNew7ExpansionReviewTest(unittest.TestCase):
    def test_legacy15_lock_is_order_insensitive_but_tier_sensitive(self) -> None:
        row = partial_row(1)
        first = review._legacy15_lock(row)  # noqa: SLF001
        reordered = copy.deepcopy(row)
        reordered["font_judgment"]["acceptable"].reverse()
        second = review._legacy15_lock(reordered)  # noqa: SLF001
        self.assertEqual(first["membership_sha256"], second["membership_sha256"])

        moved = copy.deepcopy(row)
        candidate = moved["font_judgment"]["acceptable"].pop()
        moved["font_judgment"]["marginal"].append(candidate)
        third = review._legacy15_lock(moved)  # noqa: SLF001
        self.assertNotEqual(first["membership_sha256"], third["membership_sha256"])

    def test_selection_meets_diversity_quotas_and_exclusion(self) -> None:
        examples = [example(index) for index in range(210)]
        exclusion = {
            "sample_ids": {"sample-0", "sample-1"},
            "page_ids": {"page-2", "page-3"},
            "source_shas": {partial_row(4)["source"]["source_page_sha256"]},
        }
        selected, stats = review.select_examples(
            examples, count=160, exclusion=exclusion
        )
        self.assertEqual(len(selected), 160)
        self.assertEqual(stats["work_count"], 15)
        self.assertLessEqual(stats["max_per_work"], review.MAX_PER_WORK)
        self.assertLessEqual(stats["max_per_chapter"], review.MAX_PER_CHAPTER)
        self.assertEqual(stats["page_id_unique_count"], 160)
        self.assertTrue(
            all(
                stats["tag_counts"][tag] >= quota
                for tag, quota in review.TARGET_QUOTAS.items()
            )
        )
        self.assertFalse(
            {value.sample_id for value in selected} & exclusion["sample_ids"]
        )

    def test_draft_entry_rejects_legacy_candidate_or_not_reviewed(self) -> None:
        row = partial_row(7)
        expected = {
            "legacy15_lock": review._legacy15_lock(row),  # noqa: SLF001
            "sample_id": row["sample_id"],
            "selection_rank": 1,
        }
        valid = {
            "confidence": "medium",
            "new7_tiers": {
                candidate_id: "unacceptable" for candidate_id in review.NEW7_IDS
            },
            "visually_reviewed": True,
        }
        normalized = review._validate_draft_entry(  # noqa: SLF001
            valid, expected_row=expected, location="draft"
        )
        self.assertFalse(set(normalized["new7_tiers"]) & set(review.LEGACY15_IDS))

        legacy_leak = copy.deepcopy(valid)
        legacy_leak["new7_tiers"][review.LEGACY15_IDS[0]] = "preferred"
        with self.assertRaisesRegex(review.LegacyNew7ReviewError, "exactly new7"):
            review._validate_draft_entry(  # noqa: SLF001
                legacy_leak, expected_row=expected, location="draft"
            )

        unfinished = copy.deepcopy(valid)
        unfinished["new7_tiers"][review.NEW7_IDS[0]] = "not_reviewed"
        with self.assertRaisesRegex(review.LegacyNew7ReviewError, "unfinished"):
            review._validate_draft_entry(  # noqa: SLF001
                unfinished, expected_row=expected, location="draft"
            )

    def test_array_draft_syntax_defaults_unlisted_new7_to_unacceptable(self) -> None:
        row = partial_row(8)
        expected = {
            "legacy15_lock": review._legacy15_lock(row),  # noqa: SLF001
            "sample_id": row["sample_id"],
            "selection_rank": 1,
        }
        entry = {
            "preferred": [review.NEW7_IDS[0]],
            "acceptable": [review.NEW7_IDS[1]],
            "confidence": "high",
            "visually_reviewed": True,
        }
        normalized = review._validate_draft_entry(  # noqa: SLF001
            entry, expected_row=expected, location="draft"
        )
        self.assertEqual(normalized["new7_tiers"][review.NEW7_IDS[0]], "preferred")
        self.assertEqual(
            normalized["new7_tiers"][review.NEW7_IDS[-1]], "unacceptable"
        )

    def test_authority_requires_explicit_human_finalization(self) -> None:
        with self.assertRaisesRegex(
            review.LegacyNew7ReviewError, "confirm-human-finalization"
        ):
            review.build_authority(
                review_dir=None,  # type: ignore[arg-type]
                draft_dir=None,  # type: ignore[arg-type]
                legacy_overlay_dir=None,  # type: ignore[arg-type]
                catalog_registry=None,  # type: ignore[arg-type]
                output_dir=None,  # type: ignore[arg-type]
                reviewer="primary",
                secondary_reviewer="secondary",
                confirm_human_finalization=False,
            )


if __name__ == "__main__":
    unittest.main()
