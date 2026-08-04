from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_multistage_review_queue.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "build_font_matching_multistage_review_queue_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


QUEUE = load_script()


def master_row(
    sample_id: str,
    *,
    split: str = "train",
    category: str = "ordinary",
    chapter_id: str = "chapter-a",
    page_number: int = 1,
) -> dict:
    return {
        "chapter": {"id": chapter_id, "title": "3화"},
        "geometry": {"bbox_px": [1, 2, 30, 40], "page_size_px": [100, 200]},
        "id": sample_id,
        "metadata": {"candidate_primary_category": category},
        "page": {
            "id": f"page-{sample_id}",
            "name": f"{page_number:03d}.png",
            "source_locator": {
                "file_sha256": f"{page_number:064x}",
                "path": f"works/work-a/{page_number:03d}.png",
                "storage_root": "library_root",
            },
            "source_page_sha256": f"{page_number:064x}",
        },
        "split": split,
        "views": {
            name: {
                "catalog_id": "fixture",
                "file_sha256": f"{page_number + index + 10:064x}",
                "path": f"images/{name}/{sample_id}.png",
                "status": "available",
            }
            for index, name in enumerate(QUEUE.VIEW_NAMES)
        },
        "work": {"id": "work-a", "title": "작품 A"},
    }


def pseudo_row(
    master: dict,
    *,
    pass_number: int,
    top1: str = "font-a",
    second: str = "font-b",
    margin: float = 0.2,
    role: str = "dialogue",
    variant_probability: float = 0.1,
) -> dict:
    first_probability = 0.5
    second_probability = first_probability - margin
    candidates = [top1, second, "font-c", "font-d", "font-e"]
    probabilities = [
        first_probability,
        second_probability,
        min(second_probability, 0.2),
        min(second_probability, 0.1),
        min(second_probability, 0.05),
    ]
    work = master["work"]
    chapter = master["chapter"]
    page = master["page"]
    core = {
        "candidate_count": 22,
        "chapter_id": chapter["id"],
        "chapter_title": chapter["title"],
        "direct_reference": {
            "selected_font_id": top1,
            "top5": [],
        },
        "label_authority": "pseudo_not_gold",
        "label_status": f"pseudo_fixture_pass_{pass_number}",
        "none_probability": 0.01,
        "page_id": page["id"],
        "page_name": page["name"],
        "pass_number": pass_number,
        "ranker": {
            "selected_font_id": top1,
            "top1_margin": margin,
            "top5": [
                {
                    "font_id": font_id,
                    "probability": probability,
                    "rank": index,
                    "score": probability * 2,
                }
                for index, (font_id, probability) in enumerate(
                    zip(candidates, probabilities, strict=True), 1
                )
            ],
        },
        "review": {"priority": 0, "status": "pending"},
        "role": {
            "top3": [
                {"confidence": 0.8, "role": role},
                {"confidence": 0.1, "role": "other"},
            ],
            "variant_probability": variant_probability,
        },
        "sample_id": master["id"],
        "schema_version": "font-matching-fast-pseudo-label-v1",
        "selected_font_id": top1,
        "selection_source": "fixture_ranker_top1",
        "source_category": master["metadata"]["candidate_primary_category"],
        "source_kind": "base",
        "split": master["split"],
        "style": {"energy": 0.5},
        "training_eligible": False,
        "treatment": {"orientation": {"confidence": 0.9, "value": "vertical"}},
        "view_gate_weights": {"context_224": 0.4, "glyph_224": 0.3, "raw_224": 0.3},
        "work_id": work["id"],
        "work_title": work["title"],
    }
    return QUEUE.seal_record(core)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(QUEUE.canonical_json(row) + "\n" for row in rows),
        encoding="utf-8",
    )


class QueueFixture:
    def __init__(self, root: Path, rows: list[dict]) -> None:
        self.root = root
        self.master = root / "manifest.jsonl"
        self.pass1 = root / "pass1.jsonl"
        self.pass2 = root / "pass2.jsonl"
        self.rows = {row["id"]: row for row in rows}
        write_jsonl(self.master, rows)

    def write_passes(
        self, pass1: list[dict], pass2: list[dict]
    ) -> list[QUEUE.PseudoPassSpec]:
        write_jsonl(self.pass1, pass1)
        write_jsonl(self.pass2, pass2)
        return [
            QUEUE.PseudoPassSpec("pass1", self.pass1),
            QUEUE.PseudoPassSpec("pass2", self.pass2),
        ]

    def build(
        self,
        pass1: list[dict],
        pass2: list[dict],
        **kwargs,
    ) -> list[dict]:
        return QUEUE.build_review_queue(
            master_manifest_path=self.master,
            pseudo_pass_specs=self.write_passes(pass1, pass2),
            **kwargs,
        )


class MultistageReviewQueueTests(unittest.TestCase):
    def test_priority_order_combines_variant_disagreement_and_margin(self) -> None:
        rows = [
            master_row("variant", category="page_sound", chapter_id="c1"),
            master_row("disagree", chapter_id="c2", page_number=2),
            master_row("small", chapter_id="c3", page_number=3),
            master_row("routine", chapter_id="c4", page_number=4),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary), rows)
            pass1 = [
                pseudo_row(fixture.rows["variant"], pass_number=1),
                pseudo_row(fixture.rows["disagree"], pass_number=1),
                pseudo_row(fixture.rows["small"], pass_number=1, margin=0.02),
                pseudo_row(fixture.rows["routine"], pass_number=1),
            ]
            pass2 = [
                pseudo_row(fixture.rows["variant"], pass_number=2),
                pseudo_row(
                    fixture.rows["disagree"],
                    pass_number=2,
                    top1="font-b",
                    second="font-a",
                ),
                pseudo_row(fixture.rows["small"], pass_number=2, margin=0.02),
                pseudo_row(fixture.rows["routine"], pass_number=2),
            ]
            queue = fixture.build(pass1, pass2, review_round=2)

        self.assertEqual(
            ["variant", "disagree", "small", "routine"],
            [row["sample_id"] for row in queue],
        )
        self.assertEqual([0, 1, 2, 4], [row["priority"]["tier"] for row in queue])
        disagree = queue[1]
        self.assertEqual(2, disagree["review_round"])
        self.assertEqual("pending", disagree["review_status"])
        self.assertEqual(
            ["pass1", "pass2"], [row["pass_id"] for row in disagree["passes"]]
        )
        self.assertEqual(5, len(disagree["passes"][0]["ranker_top5"]))
        self.assertEqual(
            {"font-a", "font-b"},
            {row["font_id"] for row in disagree["recommended_top_candidates"][:2]},
        )
        self.assertEqual(fixture.rows["disagree"]["views"], disagree["views"])
        QUEUE.validate_record_seal(disagree, location="queue")

    def test_stable_ordinary_chapter_font_switch_is_prioritized(self) -> None:
        rows = [
            master_row(sample_id, chapter_id="same-chapter", page_number=index)
            for index, sample_id in enumerate(("a", "b", "c", "outlier"), 1)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary), rows)
            pass1 = [
                pseudo_row(
                    row,
                    pass_number=1,
                    top1="font-b" if row["id"] == "outlier" else "font-a",
                    second="font-a" if row["id"] == "outlier" else "font-b",
                )
                for row in rows
            ]
            pass2 = [
                pseudo_row(
                    row,
                    pass_number=2,
                    top1="font-b" if row["id"] == "outlier" else "font-a",
                    second="font-a" if row["id"] == "outlier" else "font-b",
                )
                for row in rows
            ]
            queue = fixture.build(pass1, pass2)

        outlier = next(row for row in queue if row["sample_id"] == "outlier")
        self.assertEqual(3, outlier["priority"]["tier"])
        self.assertIn("ordinary_chapter_font_switch", outlier["priority"]["reasons"])
        self.assertEqual("font-a", outlier["chapter_consistency"]["baseline_font_id"])
        self.assertEqual(3, outlier["chapter_consistency"]["baseline_support_count"])
        self.assertEqual(0.75, outlier["chapter_consistency"]["baseline_vote_ratio"])
        self.assertEqual("outlier", queue[0]["sample_id"])

    def test_test_split_is_queued_but_can_never_be_promoted_to_train(self) -> None:
        test_row = master_row("test-item", split="test", chapter_id="test-c")
        train_row = master_row(
            "train-item", split="train", chapter_id="train-c", page_number=2
        )
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary), [test_row, train_row])
            pass1 = [
                pseudo_row(test_row, pass_number=1),
                pseudo_row(train_row, pass_number=1),
            ]
            pass2 = [pseudo_row(train_row, pass_number=2)]
            queue = fixture.build(pass1, pass2)

        test_item = next(row for row in queue if row["split"] == "test")
        train_item = next(row for row in queue if row["split"] == "train")
        self.assertTrue(test_item["promotion_policy"]["queue_inclusion_allowed"])
        self.assertFalse(test_item["promotion_policy"]["training_promotion_allowed"])
        self.assertFalse(
            test_item["promotion_policy"]["direct_pseudo_training_allowed"]
        )
        self.assertFalse(
            test_item["promotion_policy"]["post_review_gold_training_promotion_allowed"]
        )
        self.assertTrue(
            test_item["promotion_policy"]["test_split_training_promotion_forbidden"]
        )
        self.assertEqual(
            "test_split_isolation",
            test_item["promotion_policy"]["training_promotion_forbidden_reason"],
        )
        self.assertFalse(test_item["training_eligible"])
        self.assertFalse(test_item["provenance"]["pixels_opened"])
        self.assertEqual("pseudo_not_gold", test_item["provenance"]["authority"])
        self.assertIn("missing_pseudo_pass", test_item["priority"]["reasons"])
        self.assertTrue(
            train_item["promotion_policy"][
                "post_review_gold_training_promotion_allowed"
            ]
        )

    def test_diffuse_chapter_votes_do_not_invent_a_font_switch(self) -> None:
        font_by_sample = {
            "a1": "font-a",
            "a2": "font-a",
            "a3": "font-a",
            "b1": "font-b",
            "b2": "font-b",
            "f1": "font-f",
        }
        rows = [
            master_row(sample_id, chapter_id="diffuse", page_number=index)
            for index, sample_id in enumerate(font_by_sample, 1)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary), rows)
            pass1 = [
                pseudo_row(
                    row,
                    pass_number=1,
                    top1=font_by_sample[row["id"]],
                    second="font-b"
                    if font_by_sample[row["id"]] == "font-a"
                    else "font-a",
                )
                for row in rows
            ]
            pass2 = [
                pseudo_row(
                    row,
                    pass_number=2,
                    top1=font_by_sample[row["id"]],
                    second="font-b"
                    if font_by_sample[row["id"]] == "font-a"
                    else "font-a",
                )
                for row in rows
            ]
            queue = fixture.build(pass1, pass2)

        self.assertTrue(all(row["chapter_consistency"] is None for row in queue))
        self.assertTrue(
            all(
                "ordinary_chapter_font_switch" not in row["priority"]["reasons"]
                for row in queue
            )
        )

    def test_gold_tamper_and_master_identity_drift_fail_closed(self) -> None:
        row = master_row("sample")
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary), [row])
            valid1 = pseudo_row(row, pass_number=1)
            valid2 = pseudo_row(row, pass_number=2)

            gold = QUEUE.seal_record(
                {
                    **{
                        key: value
                        for key, value in valid1.items()
                        if key != "record_sha256"
                    },
                    "label_authority": "gold",
                }
            )
            with self.assertRaisesRegex(
                QUEUE.MultistageReviewQueueError, "only pseudo_not_gold"
            ):
                fixture.build([gold], [valid2])

            tampered = copy.deepcopy(valid1)
            tampered["ranker"]["selected_font_id"] = "font-z"
            with self.assertRaisesRegex(
                QUEUE.MultistageReviewQueueError, "seal mismatch"
            ):
                fixture.build([tampered], [valid2])

            drifted = copy.deepcopy(valid1)
            drifted.pop("record_sha256")
            drifted["split"] = "test"
            drifted = QUEUE.seal_record(drifted)
            with self.assertRaisesRegex(
                QUEUE.MultistageReviewQueueError, "split drifted"
            ):
                fixture.build([drifted], [valid2])

    def test_atomic_writer_refuses_implicit_overwrite(self) -> None:
        row = master_row("sample")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = QueueFixture(root, [row])
            queue = fixture.build(
                [pseudo_row(row, pass_number=1)],
                [pseudo_row(row, pass_number=2)],
            )
            output = root / "queue.jsonl"
            QUEUE.write_jsonl(output, queue, replace_existing=False)
            parsed = [
                json.loads(line)
                for line in output.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(1, len(parsed))
            QUEUE.validate_record_seal(parsed[0], location="written queue")
            with self.assertRaisesRegex(
                QUEUE.MultistageReviewQueueError, "output exists"
            ):
                QUEUE.write_jsonl(output, queue, replace_existing=False)

    def test_pass_cli_order_is_canonical_and_policy_tamper_is_rejected(self) -> None:
        row = master_row("sample")
        with tempfile.TemporaryDirectory() as temporary:
            fixture = QueueFixture(Path(temporary), [row])
            specs = fixture.write_passes(
                [pseudo_row(row, pass_number=1)],
                [pseudo_row(row, pass_number=2)],
            )
            forward = QUEUE.build_review_queue(
                master_manifest_path=fixture.master,
                pseudo_pass_specs=specs,
            )
            reverse = QUEUE.build_review_queue(
                master_manifest_path=fixture.master,
                pseudo_pass_specs=list(reversed(specs)),
            )
            self.assertEqual(forward, reverse)

            tampered = copy.deepcopy(forward[0])
            tampered.pop("record_sha256")
            tampered["promotion_policy"]["direct_pseudo_training_allowed"] = True
            tampered = QUEUE.seal_record(tampered)
            with self.assertRaisesRegex(
                QUEUE.MultistageReviewQueueError, "promotion policy drift"
            ):
                QUEUE.validate_queue_record(tampered)


if __name__ == "__main__":
    unittest.main()
