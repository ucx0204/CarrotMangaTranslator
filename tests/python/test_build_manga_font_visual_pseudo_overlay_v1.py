from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "build_manga_font_visual_pseudo_overlay_v1.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "build_manga_font_visual_pseudo_overlay_v1_tested", SCRIPT_PATH
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


OVERLAY = load_script()
ACTIVE = OVERLAY._active_ids()


def pseudo_row(sample_id: str, probabilities: list[float], weight: float) -> dict:
    return OVERLAY.audit.seal_record(
        {
            "candidate_ids": list(ACTIVE),
            "label_authority": "pseudo_soft_not_gold",
            "master_row_sha256": "a" * 64,
            "probabilities": probabilities,
            "round": 2,
            "sample_id": sample_id,
            "schema_version": OVERLAY.audit.mass21.PSEUDO_SCHEMA,
            "source_category": "ordinary",
            "split": "train",
            "teacher_bindings": {"checkpoint_sha256": "b" * 64},
            "training_eligible": False,
            "weight": weight,
            "work_id": "work-1",
        }
    )


def probabilities(top_index: int = 0) -> list[float]:
    values = [0.01] * len(ACTIVE)
    values[top_index] = 0.8
    values[-1] += 1.0 - sum(values)
    return values


def item(sample_id: str, split: str = "train") -> object:
    return OVERLAY.ReviewItem(
        sample_id=sample_id,
        record_sha256=(sample_id.encode().hex() + "0" * 64)[:64],
        split=split,
        visible_font_ids=ACTIVE[:5],
        current_top1_font_id=ACTIVE[0],
    )


def decision(
    sample_id: str,
    *,
    kind: str,
    selected: str | None,
    split_item: object,
    acceptable: tuple[str, ...] = (),
    digest: str | None = None,
) -> object:
    return OVERLAY.VisualDecision(
        sample_id=sample_id,
        kind=kind,
        review_item_sha256=split_item.record_sha256,
        reviewed_font_ids=split_item.visible_font_ids,
        selected_font_id=selected,
        acceptable_font_ids=acceptable,
        confidence=None if kind == "review_needed" else 0.9,
        source_path="fixture.jsonl",
        source_sha256="c" * 64,
        source_line=1,
        decision_sha256=digest or ("d" * 64),
        raw={
            "current_top1_font_id": split_item.current_top1_font_id,
            "decision_metadata": {
                "old_top1_font_id": split_item.current_top1_font_id
            },
        },
    )


class VisualPseudoOverlayTests(unittest.TestCase):
    def test_correction_only_redistributes_visible_mass(self) -> None:
        source = probabilities()
        source[0] = 0.3
        source[1] = 0.05
        source[2] = 0.1
        source[3] = 0.08
        source[4] = 0.07
        source[-1] += 1.0 - sum(source)
        review_item = item("correction")
        visual = decision(
            "correction",
            kind="correction",
            selected=ACTIVE[1],
            acceptable=(ACTIVE[2],),
            split_item=review_item,
        )
        updated, report = OVERLAY._apply_correction(
            source,
            candidate_ids=ACTIVE,
            decision=visual,
            parameters=OVERLAY.Parameters(),
        )
        self.assertAlmostEqual(sum(source), sum(updated), places=12)
        self.assertLessEqual(report["actual_transfer"], 0.2 + 1e-12)
        self.assertGreater(updated[1], source[1])
        self.assertGreater(updated[2], source[2])
        for index in range(5, len(ACTIVE)):
            self.assertEqual(source[index], updated[index])

    def test_binding_excludes_val_test_and_human_as_qa_only(self) -> None:
        train_item = item("train")
        val_item = item("val", "val")
        human_item = item("human")
        needed_item = item("needed")
        decisions = {
            "train": decision(
                "train", kind="confirmed", selected=ACTIVE[0], split_item=train_item
            ),
            "val": decision(
                "val", kind="confirmed", selected=ACTIVE[0], split_item=val_item
            ),
            "human": decision(
                "human", kind="confirmed", selected=ACTIVE[0], split_item=human_item
            ),
            "needed": decision(
                "needed", kind="review_needed", selected=None, split_item=needed_item
            ),
        }
        applied, heldout, counts = OVERLAY._bind_decisions(
            decisions,
            items={
                row.sample_id: row
                for row in (train_item, val_item, human_item, needed_item)
            },
            pseudo_ids={"train", "needed"},
            human_ids={"human"},
            candidate_ids=ACTIVE,
        )
        self.assertEqual({"train"}, set(applied))
        self.assertEqual(2, len(heldout))
        self.assertEqual(1, counts["heldout_non_train_split"])
        self.assertEqual(1, counts["heldout_existing_human_supervision_overlap"])
        self.assertEqual(1, counts["train_review_needed_unchanged"])
        self.assertTrue(all(row["training_eligible"] is False for row in heldout))
        self.assertTrue(
            all(row["evaluation_authority"] == OVERLAY.QA_AUTHORITY for row in heldout)
        )

    def test_duplicate_contradiction_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_item = item("duplicate")
            base = {
                "acceptable_font_ids": [],
                "confidence": 0.9,
                "correction_reason": "visual_top1_confirmed",
                "decision_status": "completed",
                "label_authority": "pseudo_not_gold",
                "none_acceptable": False,
                "notes": "",
                "promotion_allowed": False,
                "record_type": "manga_font_fast_named_review_decision_template",
                "review_item_sha256": source_item.record_sha256,
                "review_pass": 1,
                "review_purpose": "fast_pick",
                "reviewed_at": "2026-08-03T00:00:00Z",
                "reviewed_font_ids": list(source_item.visible_font_ids),
                "reviewer": "fixture",
                "sample_id": "duplicate",
                "schema_version": OVERLAY.review.SCHEMA_VERSION,
                "selected_font_id": ACTIVE[0],
                "training_eligible": False,
            }
            first = root / "first.jsonl"
            second = root / "second.jsonl"
            first.write_text(json.dumps(base) + "\n", encoding="utf-8")
            conflict = copy.deepcopy(base)
            conflict["selected_font_id"] = ACTIVE[1]
            conflict["correction_reason"] = "mismatch"
            second.write_text(json.dumps(conflict) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(
                OVERLAY.VisualPseudoOverlayError, "contradictory duplicate"
            ):
                OVERLAY._load_decisions([first, second])

    def test_build_validate_and_existing_loader_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            correction_row = pseudo_row("correction", probabilities(), 0.4)
            confirmed_row = pseudo_row("confirmed", probabilities(), 0.5)
            untouched_row = pseudo_row("untouched", probabilities(), 0.6)
            source_rows = [correction_row, confirmed_row, untouched_row]
            correction_item = item("correction")
            confirmed_item = item("confirmed")
            val_item = item("heldout", "test")
            correction = decision(
                "correction",
                kind="correction",
                selected=ACTIVE[1],
                acceptable=(ACTIVE[2],),
                split_item=correction_item,
            )
            confirmed = decision(
                "confirmed",
                kind="confirmed",
                selected=ACTIVE[0],
                split_item=confirmed_item,
            )
            heldout = decision(
                "heldout",
                kind="confirmed",
                selected=ACTIVE[0],
                split_item=val_item,
            )
            output = root / "output"
            with (
                mock.patch.object(
                    OVERLAY,
                    "_load_sealed_pseudo",
                    return_value=(
                        source_rows,
                        ACTIVE,
                        set(),
                        {
                            "file": "fixture",
                            "sha256": "a" * 64,
                            "row_count": 3,
                            "sample_order_sha256": "b" * 64,
                        },
                    ),
                ),
                mock.patch.object(
                    OVERLAY,
                    "_load_review_bundle",
                    return_value=(
                        {
                            "correction": correction_item,
                            "confirmed": confirmed_item,
                            "heldout": val_item,
                        },
                        set(),
                        {"file": "fixture-review", "record_count": 3},
                    ),
                ),
                mock.patch.object(
                    OVERLAY,
                    "_load_decisions",
                    return_value=(
                        {
                            "correction": correction,
                            "confirmed": confirmed,
                            "heldout": heldout,
                        },
                        [],
                    ),
                ),
            ):
                result = OVERLAY.build_overlay(
                    pseudo_targets=root / "ignored.jsonl",
                    review_dir=root / "ignored-review",
                    decision_paths=[root / "ignored-decisions.jsonl"],
                    output_dir=output,
                    expected_row_count=3,
                )
            self.assertEqual(3, result["pseudo_rows"])
            self.assertEqual(2, result["train_applied_rows"])
            self.assertEqual(1, result["heldout_visual_qa_rows"])
            rows = [
                json.loads(line)
                for line in (output / OVERLAY.PSEUDO_FILE)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(untouched_row, rows[2])
            self.assertEqual(confirmed_row["probabilities"], rows[1]["probabilities"])
            self.assertGreater(rows[1]["weight"], confirmed_row["weight"])
            loaded = OVERLAY.audit.mass21.load_pseudo_targets(
                output / OVERLAY.PSEUDO_FILE,
                candidate_ids=ACTIVE,
                real_train_ids=frozenset(row["sample_id"] for row in source_rows),
                human_gold_ids=frozenset(),
            )
            self.assertEqual(3, len(loaded.targets))
            tampered = json.loads((output / OVERLAY.REPORT_FILE).read_text())
            tampered["authority"]["human_gold_promotions"] = 1
            (output / OVERLAY.REPORT_FILE).write_text(
                json.dumps(tampered), encoding="utf-8"
            )
            with self.assertRaises(OVERLAY.VisualPseudoOverlayError):
                OVERLAY.validate_output(output)


if __name__ == "__main__":
    unittest.main()
