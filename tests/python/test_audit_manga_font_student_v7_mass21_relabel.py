from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "audit_manga_font_student_v7_mass21_relabel.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "audit_manga_font_student_v7_mass21_relabel_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


AUDIT = load_script()


def dense(selected: str, *, second: str | None = None) -> list[float]:
    candidates = AUDIT.active_candidate_ids()
    runner_up = second or next(value for value in candidates if value != selected)
    values = {candidate_id: 0.3 / (len(candidates) - 2) for candidate_id in candidates}
    values[selected] = 0.5
    values[runner_up] = 0.2
    return [values[candidate_id] for candidate_id in candidates]


def review_row(
    sample_id: str,
    *,
    selected: str,
    source_category: str = "ordinary",
    split: str = "train",
    chapter_id: str = "chapter-1",
    row_index: int = 0,
    second: str | None = None,
    entropy: float = 0.4,
    margin: float = 0.3,
    disagreement: float = 0.0,
) -> dict:
    candidates = AUDIT.active_candidate_ids()
    probabilities = dense(selected, second=second)
    order = sorted(range(len(candidates)), key=lambda index: -probabilities[index])
    top5 = [
        {
            "font_id": candidates[index],
            "probability": probabilities[index],
            "rank": rank,
            "score": -float(rank),
        }
        for rank, index in enumerate(order[:5], 1)
    ]
    return AUDIT.labeler.seal_record(
        {
            "candidate_count": len(candidates),
            "candidate_ids": list(candidates),
            "chapter_id": chapter_id,
            "chapter_title": "1화",
            "confidence": 0.5,
            "direct_reference": {
                "selected_font_id": selected,
                "source": "fixture_visual_only",
            },
            "entropy": entropy,
            "family_logit_influence": {
                "chapter": 0.0,
                "family_prior": 0.0,
                "gemma": 0.0,
                "genre": 0.0,
                "role": 0.0,
            },
            "gugi_probability": 0.0,
            "label_authority": "pseudo_not_gold",
            "label_status": "pseudo_fixture",
            "master_row_sha256": "a" * 64,
            "model_source_kind": "cpu-fixture",
            "page_id": f"page-{sample_id}",
            "page_name": f"{sample_id}.png",
            "probabilities": probabilities,
            "probability_source": "visual_query_current",
            "promotion_allowed": False,
            "ranker": {
                "selected_font_id": selected,
                "top1_margin": margin,
                "top5": top5,
            },
            "role": {"top3": [{"confidence": 0.0, "role": "unknown"}]},
            "round": 2,
            "sample_id": sample_id,
            "schema_version": AUDIT.labeler.SCHEMA,
            "selected_font_id": selected,
            "source_category": source_category,
            "source_kind": "fixture",
            "source_row_index": row_index,
            "split": split,
            "style": {},
            "teacher_bindings": {
                "checkpoint_sha256": "b" * 64,
                "visual_features": {"kind": "cpu_fixture"},
            },
            "top5": top5,
            "training_eligible": False,
            "view_disagreement": {
                "js_divergence": disagreement / 2,
                "top1_candidate_ids": [selected, selected, selected],
                "top1_disagreement": disagreement,
            },
            "weight": 0.04,
            "work_id": "work-1",
            "work_title": "작품 1",
        }
    )


def pseudo_row(review: dict, *, weight: float = 0.04) -> dict:
    return AUDIT.labeler.seal_record(
        {
            "candidate_ids": review["candidate_ids"],
            "label_authority": "pseudo_soft_not_gold",
            "master_row_sha256": review["master_row_sha256"],
            "probabilities": review["probabilities"],
            "round": 2,
            "sample_id": review["sample_id"],
            "schema_version": AUDIT.mass21.PSEUDO_SCHEMA,
            "source_category": review["source_category"],
            "split": "train",
            "teacher_bindings": {
                "checkpoint_sha256": "b" * 64,
                "visual_features": {"kind": "cpu_fixture"},
            },
            "training_eligible": False,
            "weight": weight,
            "work_id": review["work_id"],
        }
    )


class RelabelAuditTest(unittest.TestCase):
    def fixture(self):
        candidates = AUDIT.active_candidate_ids()
        a, b, c, d, e = candidates[:5]
        rows = [
            review_row("plain-a1", selected=a, row_index=0),
            review_row("plain-a2", selected=a, row_index=1),
            review_row("plain-a3", selected=a, row_index=2),
            review_row("plain-outlier", selected=b, row_index=3),
            review_row(
                "gold", selected=b, second=a, chapter_id="chapter-2", row_index=4
            ),
            review_row(
                "edge",
                selected=e,
                source_category="bubble_edge",
                row_index=5,
                entropy=0.8,
            ),
            review_row(
                "emphasis",
                selected=c,
                source_category="text_free",
                split="val",
                row_index=6,
            ),
            review_row(
                "sfx",
                selected=d,
                source_category="page_sound",
                split="test",
                row_index=7,
            ),
        ]
        pseudos = [
            pseudo_row(row, weight=0.01 if row["sample_id"] == "edge" else 0.08)
            for row in rows
            if row["split"] == "train"
        ]
        gold = AUDIT.GoldBundle(
            labels={
                "gold": AUDIT.GoldLabel(
                    "gold", frozenset({a}), frozenset({a, b}), "dialogue", "fixture"
                )
            },
            reviewed_ids=frozenset({"gold", "retired-only"}),
            retired_only_ids=frozenset({"retired-only"}),
            bindings={"fixture": True},
        )
        previous = {str(row["sample_id"]): a for row in rows if row["split"] == "train"}
        return rows, pseudos, gold, previous

    def test_audits_groups_gold_transitions_and_separates_review_buckets(self) -> None:
        rows, pseudos, gold, previous = self.fixture()
        result = AUDIT.audit_records(
            rows, pseudos, gold=gold, previous_top1=previous
        )

        self.assertEqual(8, result.report["counts"]["review_rows"])
        self.assertEqual(7, result.report["counts"]["priority_rows"])
        self.assertEqual(5, result.report["counts"]["next_pseudo_rows"])
        self.assertEqual(1, result.report["counts"]["gold_evaluation_rows"])
        self.assertEqual(1.0, result.report["gold"]["metrics"]["acceptable_at1"])
        self.assertEqual(0.0, result.report["gold"]["metrics"]["preferred_at1"])
        self.assertEqual(1.0, result.report["gold"]["metrics"]["preferred_hit_at3"])
        self.assertIn("plain_dialogue", result.report["groups"]["by_role"])
        self.assertIn("aside_balloon_edge", result.report["groups"]["by_role"])
        self.assertIn("emphasis_free_text", result.report["groups"]["by_role"])
        self.assertIn("sfx", result.report["groups"]["by_role"])

        by_id = {row["sample_id"]: row for row in result.priority_rows}
        self.assertIn(
            "plain_dialogue_same_chapter_majority_outlier",
            by_id["plain-outlier"]["priority"]["reasons"],
        )
        self.assertNotIn(
            "plain_dialogue_same_chapter_majority_outlier",
            by_id["edge"]["priority"]["reasons"],
        )
        self.assertEqual("aside_balloon_edge", by_id["edge"]["review_bucket"])
        self.assertNotIn("gold", by_id)
        self.assertEqual(
            {"plain-a1", "plain-a2", "plain-a3", "plain-outlier", "edge"},
            {row["sample_id"] for row in result.next_pseudo_rows},
        )
        self.assertEqual(
            result.report["next_pseudo_contract"]["low_confidence_rows_before"],
            result.report["next_pseudo_contract"]["low_confidence_rows_retained"],
        )
        self.assertEqual(0, result.report["next_pseudo_contract"]["test_rows"])

    def test_detects_mass_transition_and_candidate_disappearance(self) -> None:
        candidates = AUDIT.active_candidate_ids()
        old, new = candidates[:2]
        rows = [
            {"sample_id": f"sample-{index}", "selected_font_id": new}
            for index in range(12)
        ]
        previous = {f"sample-{index}": old for index in range(12)}

        transition = AUDIT._transition_audit(rows, previous, candidates)

        kinds = {warning["type"] for warning in transition["warnings"]}
        self.assertIn("candidate_disappearance", kinds)
        self.assertIn("changed_rows_destination_collapse", kinds)
        self.assertIn("source_font_mass_transition", kinds)
        self.assertEqual(12, transition["matrix"][old][new])

    def test_rejects_nonzero_semantic_family_logit_influence(self) -> None:
        rows, pseudos, gold, previous = self.fixture()
        corrupt = dict(rows[0])
        corrupt.pop("record_sha256")
        corrupt["family_logit_influence"] = dict(corrupt["family_logit_influence"])
        corrupt["family_logit_influence"]["role"] = 0.01
        rows[0] = AUDIT.labeler.seal_record(corrupt)

        with self.assertRaisesRegex(AUDIT.RelabelAuditError, "nonvisual"):
            AUDIT.audit_records(rows, pseudos, gold=gold, previous_top1=previous)

    def test_writes_and_revalidates_cpu_only_artifact(self) -> None:
        rows, pseudos, gold, previous = self.fixture()
        result = AUDIT.audit_records(
            rows, pseudos, gold=gold, previous_top1=previous
        )
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "audit"
            validated = AUDIT.write_output(
                output,
                result,
                source_bindings={"fixture": True},
                gold_bindings=gold.bindings,
            )

            self.assertEqual("validated_cpu_only_relabel_audit", validated["status"])
            report = json.loads((output / AUDIT.REPORT_FILE).read_text(encoding="utf-8"))
            self.assertEqual(0, report["authority"]["automatic_gold_promotions"])
            self.assertEqual(0, report["authority"]["fabricated_corrections"])
            self.assertEqual(0, report["influence_audit"]["gugi_candidate_slots"])
            self.assertEqual(5, report["next_pseudo_contract"]["dense_soft_teacher_rows"])
            self.assertEqual(
                "validated_cpu_only_relabel_audit",
                AUDIT.validate_output(output)["status"],
            )

    def test_rejects_gemma_bound_pseudo_teacher(self) -> None:
        rows, pseudos, gold, previous = self.fixture()
        corrupt = dict(pseudos[0])
        corrupt.pop("record_sha256")
        corrupt["teacher_bindings"] = {"gemma_model": "forbidden"}
        pseudos[0] = AUDIT.labeler.seal_record(corrupt)

        with self.assertRaisesRegex(AUDIT.RelabelAuditError, "Gemma"):
            AUDIT.audit_records(rows, pseudos, gold=gold, previous_top1=previous)


if __name__ == "__main__":
    unittest.main()
