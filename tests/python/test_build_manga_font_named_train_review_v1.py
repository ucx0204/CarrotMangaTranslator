import copy
import unittest

from scripts import build_manga_font_named_train_review_v1 as review


def base_row() -> dict:
    return {
        "font_judgment": {"preferred": ["mongtori"]},
        "provenance": {"approval": "completed_human_final_label"},
        "record_sha256": "a" * 64,
        "review_provenance": {"authority": {"training_only": True}},
        "sample_id": "fm_train_1",
        "source": {
            "views": {
                "raw_224": {"path": "raw.png"},
                "context_224": {"path": "context.png"},
                "glyph_224": {"path": "glyph.png"},
            }
        },
        "split": "train",
        "work_id": "work-1",
    }


def valid_overlay(row: dict) -> dict:
    result = copy.deepcopy(row)
    result["font_judgment"] = {"preferred": ["gaegu"]}
    result["provenance"]["named_train_review_overlay"] = {
        "base_train_record_sha256": row["record_sha256"],
        "font_judgment_only": True,
        "human_named_review": True,
        "test_data_used": False,
    }
    result["review_provenance"]["named_train_review_overlay"] = {
        "schema_version": review.OVERLAY_SCHEMA_VERSION
    }
    return result


class MangaFontNamedTrainReviewTest(unittest.TestCase):
    def test_overlay_scope_allows_only_judgment_and_named_provenance(self) -> None:
        row = base_row()
        review._assert_overlay_scope(  # noqa: SLF001
            row, valid_overlay(row), sample_id=row["sample_id"]
        )

    def test_overlay_scope_rejects_view_binding_mutation(self) -> None:
        row = base_row()
        overlay = valid_overlay(row)
        overlay["source"]["views"]["glyph_224"]["path"] = "other.png"
        with self.assertRaisesRegex(review.NamedTrainReviewError, "pixels"):
            review._assert_overlay_scope(  # noqa: SLF001
                row, overlay, sample_id=row["sample_id"]
            )

    def test_overlay_scope_rejects_wrong_base_record_authority(self) -> None:
        row = base_row()
        overlay = valid_overlay(row)
        overlay["provenance"]["named_train_review_overlay"][
            "base_train_record_sha256"
        ] = "b" * 64
        with self.assertRaisesRegex(review.NamedTrainReviewError, "authority"):
            review._assert_overlay_scope(  # noqa: SLF001
                row, overlay, sample_id=row["sample_id"]
            )


if __name__ == "__main__":
    unittest.main()
