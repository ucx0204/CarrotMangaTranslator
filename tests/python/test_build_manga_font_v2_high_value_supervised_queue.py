from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "high_value_queue",
    SCRIPTS / "build_manga_font_v2_high_value_supervised_queue.py",
)
assert SPEC and SPEC.loader
queue = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = queue
SPEC.loader.exec_module(queue)


CANDIDATES = tuple(queue.FONT_FAMILY_BY_ID)


def fixture_feature(
    suffix: str,
    *,
    category: str = "ordinary",
    role: str = "dialogue_body",
    single_day_probability: float = 0.16,
    work: str = "work-a",
    chapter: str | None = None,
) -> queue.FeatureRow:
    sample_id = f"fm_{suffix}"
    probabilities = [0.01] * len(CANDIDATES)
    probabilities[CANDIDATES.index("dohyeon")] = 0.22
    probabilities[CANDIDATES.index("nanum-gothic")] = 0.20
    probabilities[CANDIDATES.index("single-day")] = single_day_probability
    total = sum(probabilities)
    probabilities = [value / total for value in probabilities]
    master = {
        "id": sample_id,
        "split": "train",
        "font_label": None,
        "label_status": "unlabeled",
        "work": {"id": work, "title": work},
        "chapter": {"id": chapter or f"chapter-{suffix}", "title": suffix},
        "page": {"source_page_sha256": (suffix * 64)[:64]},
        "geometry": {},
        "metadata": {
            "candidate_primary_category": category,
            "orientation": "horizontal",
        },
        "views": {},
    }
    pseudo_core = {
        "candidate_ids": list(CANDIDATES),
        "label_authority": "pseudo_soft_not_gold",
        "probabilities": probabilities,
        "sample_id": sample_id,
        "source_category": category,
        "split": "train",
        "training_eligible": False,
    }
    pseudo = queue.seal_record(pseudo_core)
    fast = {
        "candidates": [
            {"candidate_id": "single-day", "aggregate": {"best_rank": 1}},
            {"candidate_id": "nanum-gothic", "aggregate": {"best_rank": 2}},
            {"candidate_id": "dohyeon", "aggregate": {"best_rank": 3}},
            {"candidate_id": "ridi-batang", "aggregate": {"best_rank": 4}},
            {"candidate_id": "nanum-brush-script", "aggregate": {"best_rank": 5}},
        ],
        "chapter_consistency": {
            "majority_font_id": "nanum-gothic",
            "outlier": True,
        },
        "pass_summaries": [
            {
                "direct_top1_font_id": "nanum-gothic",
                "ranker_top1_font_id": "single-day",
            }
        ],
        "priority": {"signals": {"view_top1_disagreement": 0.66}},
        "role_probe": {"role": role},
    }
    return queue.build_feature(master, pseudo, fast, None)


class HighValueQueueTests(unittest.TestCase):
    def test_focus_quotas_are_exact_for_first_800(self) -> None:
        quotas = queue.focus_quotas(800)
        self.assertEqual(sum(quotas.values()), 800)
        self.assertEqual(set(quotas), set(queue.FOCUS_WEIGHTS))
        self.assertGreaterEqual(quotas["single_day_ordinary_hard_negative"], 100)

    def test_single_day_positive_and_hard_negative_are_separate_sampling_strata(self) -> None:
        ordinary = fixture_feature("ordinary", category="ordinary", role="dialogue_body")
        specialist = fixture_feature("sound", category="page_sound", role="sfx_impact")
        queue.annotate_information_features([ordinary, specialist])
        self.assertIn("single_day_ordinary_hard_negative", ordinary.focus_flags)
        self.assertNotIn("single_day_specialist_positive", ordinary.focus_flags)
        self.assertIn("single_day_specialist_positive", specialist.focus_flags)
        self.assertNotIn("single_day_ordinary_hard_negative", specialist.focus_flags)

    def test_display_sampling_separates_sign_shout_and_sfx_without_label_authority(self) -> None:
        sign = {
            "metadata": {"orientation": "horizontal", "candidate_score": 0.5},
            "geometry": {"final_bbox_px": [0, 0, 300, 80], "page_size_px": [1000, 1500]},
        }
        shout = {
            "metadata": {
                "orientation": "vertical",
                "candidate_score": 0.95,
                "style_metrics": {"outline_structure_ratio": 0.3},
            },
            "geometry": {"final_bbox_px": [0, 0, 80, 300], "page_size_px": [1000, 1500]},
        }
        self.assertEqual(queue.sampling_role_hint(sign, None, "text_free"), "sign")
        self.assertEqual(queue.sampling_role_hint(shout, None, "text_free"), "shout")
        self.assertEqual(queue.sampling_role_hint(shout, None, "page_sound"), "sfx")

    def test_seven_candidate_panel_is_deterministic_diverse_and_opaque_ordered(self) -> None:
        row = fixture_feature("seven", category="ordinary", role="dialogue_body")
        queue.annotate_information_features([row])
        row.primary_focus = "single_day_ordinary_hard_negative"
        first = queue.choose_seven_candidates(row, CANDIDATES)
        second = queue.choose_seven_candidates(row, CANDIDATES)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 7)
        self.assertEqual(len(set(first)), 7)
        self.assertIn("single-day", first)
        families = {queue.FONT_FAMILY_BY_ID[candidate] for candidate in first}
        self.assertTrue(families & queue.BODY_FAMILIES)
        self.assertTrue(families & queue.SPECIALIST_FAMILIES)
        self.assertNotEqual(first[:3], row.raw_top[:3])

    def test_balanced_selection_is_unique_and_spreads_works_pages(self) -> None:
        rows = [
            fixture_feature(
                f"{index:064x}",
                category="page_sound" if index % 4 == 0 else "ordinary",
                role="sfx_impact" if index % 4 == 0 else "dialogue_body",
                work=f"work-{index % 4}",
                chapter=f"chapter-{index % 12}",
            )
            for index in range(48)
        ]
        queue.annotate_information_features(rows)
        selected = queue.select_balanced_rows(rows, 24)
        self.assertEqual(len(selected), 24)
        self.assertEqual(len({row.sample_id for row in selected}), 24)
        work_counts: dict[str, int] = {}
        for row in selected:
            work_counts[row.work_id] = work_counts.get(row.work_id, 0) + 1
        self.assertLessEqual(max(work_counts.values()) - min(work_counts.values()), 2)
        self.assertLessEqual(max(list(row.page_sha256 for row in selected).count(page) for page in {row.page_sha256 for row in selected}), 2)

    def test_public_row_rejects_candidate_or_model_leak(self) -> None:
        core = {
            "authority": {
                "automatic_label_promotion_allowed": False,
                "candidate_search_complete": False,
                "label_authority": "none_pending_blind_review",
                "model_scores_visible": False,
                "training_eligible": False,
            },
            "binding_id": "binding",
            "chapter_token": "chapter",
            "orientation": "horizontal",
            "page_token": "page",
            "record_type": queue.RECORD_TYPE,
            "review_id": "review",
            "review_order": 1,
            "role_sampling_hint": {
                "must_be_human_verified": True,
                "role": "dialogue",
                "source": "layout_probe_for_review_navigation_not_label_authority",
            },
            "sample_id": "fm_fixture",
            "schema_version": queue.SCHEMA_VERSION,
            "sheet": {
                "file": "contact-sheets/sheet-001.png",
                "row_index": 0,
                "sha256": "a" * 64,
            },
            "slots": list("ABCDEFG"),
            "source": {"geometry": {}, "views": {}},
            "source_identity_sha256": "b" * 64,
            "split": "train",
            "work_token": "work",
        }
        queue.validate_public_row(queue.seal_record(core), CANDIDATES)
        leaky = dict(core)
        leaky["primary_focus"] = "model_disagreement"
        with self.assertRaisesRegex(queue.HighValueQueueError, "leaks"):
            queue.validate_public_row(queue.seal_record(leaky), CANDIDATES)
        named = dict(core)
        named["notes"] = "single-day"
        with self.assertRaisesRegex(queue.HighValueQueueError, "candidate identity"):
            queue.validate_public_row(queue.seal_record(named), CANDIDATES)

    def test_exclusion_inventory_separates_review_val33_blind_and_qa(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reviewed = root / "manga-font-v7-review-agent-a-round2-v1"
            reviewed.mkdir()
            (reviewed / "confirmed.jsonl").write_text(
                json.dumps({"sample_id": "fm_reviewed"}) + "\n", encoding="utf-8"
            )
            val = root / "manga-font-student-human-overlay-adjudicated-val33-v1"
            val.mkdir()
            (val / "val-samples-adjudicated.jsonl").write_text(
                json.dumps({"sample_id": "fm_val33"}) + "\n", encoding="utf-8"
            )
            blind = root / "manga-font-v2-independent-blind-calibration-eval-pool-r2"
            blind.mkdir()
            (blind / "review-queue.jsonl").write_text(
                json.dumps({"sample_id": "fm_blind"}) + "\n", encoding="utf-8"
            )
            (blind / "private-bindings.jsonl").write_text(
                json.dumps({"sample_id": "fm_blind"}) + "\n", encoding="utf-8"
            )
            qa_dir = root / "library-full-pipeline-font-qa-v10" / "cohorts"
            qa_dir.mkdir(parents=True)
            page_sha = "c" * 64
            (qa_dir / "baseline40.jsonl").write_text(
                json.dumps({"page": {"imageSha256": page_sha}}) + "\n",
                encoding="utf-8",
            )
            inventory = queue.load_exclusion_inventory(root)
            self.assertIn("fm_reviewed", inventory.reviewed_ids)
            self.assertIn("fm_val33", inventory.val33_ids)
            self.assertIn("fm_blind", inventory.blind_pool_ids)
            self.assertIn(page_sha, inventory.qa_page_sha256)

    def test_pending_decision_never_claims_training_authority(self) -> None:
        public = queue.seal_record(
            {"record_sha256": "ignored", "review_id": "r", "sample_id": "fm_x"}
        )
        decision = queue._decision_template(public)
        self.assertFalse(decision["authority"]["training_eligible"])
        self.assertFalse(decision["candidate_search_complete"])
        self.assertEqual(decision["decision_status"], "pending")


if __name__ == "__main__":
    unittest.main()
