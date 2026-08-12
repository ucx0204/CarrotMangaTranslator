from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "refine_manga_font_v2_pseudo_labels.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "refine_manga_font_v2_pseudo_labels_tested", SCRIPT_PATH
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


REFINE = load_script()
ACTIVE = REFINE._active_ids()
SINGLE_DAY_INDEX = ACTIVE.index(REFINE.SINGLE_DAY_ID)


def probability_vector(
    *, single_day: float = 0.30, top_index: int = 0, top_probability: float = 0.45
) -> list[float]:
    values = [0.0] * len(ACTIVE)
    values[SINGLE_DAY_INDEX] = single_day
    values[top_index] = top_probability
    remaining = 1.0 - sum(values)
    recipients = [
        index
        for index in range(len(values))
        if index not in {SINGLE_DAY_INDEX, top_index}
    ]
    for index in recipients:
        values[index] = remaining / len(recipients)
    values[-1] += 1.0 - sum(values)
    return values


def pseudo_row(
    sample_id: str,
    source_category: str,
    *,
    probabilities: list[float] | None = None,
    visual_review: dict | None = None,
) -> dict:
    core = {
        "candidate_ids": list(ACTIVE),
        "label_authority": REFINE.LOADER_AUTHORITY,
        "master_row_sha256": "a" * 64,
        "probabilities": probabilities or probability_vector(),
        "round": 5,
        "sample_id": sample_id,
        "schema_version": REFINE.audit.mass21.PSEUDO_SCHEMA,
        "source_category": source_category,
        "split": "train",
        "teacher_bindings": {"checkpoint_sha256": "b" * 64},
        "training_eligible": False,
        "weight": 0.40,
        "work_id": "work-1",
    }
    if visual_review is not None:
        core["pseudo_visual_review"] = visual_review
    return REFINE.seal_record(core)


def pass_evidence(
    sample_id: str,
    source_category: str,
    *,
    selected_font_id: str = "dohyeon",
    confidence: float = 0.50,
    disagreement: float = 1.0,
) -> object:
    return REFINE.PassEvidence(
        sample_id=sample_id,
        record_sha256="c" * 64,
        split="train",
        source_category=source_category,
        master_row_sha256="a" * 64,
        work_id="work-1",
        selected_font_id=selected_font_id,
        confidence=confidence,
        top1_disagreement=disagreement,
    )


def visual_decision(
    *,
    selected: str,
    original_top1: str,
    kind: str = "correction",
    confidence: float = 0.9,
) -> dict:
    reviewed = list(ACTIVE[:4]) + [REFINE.SINGLE_DAY_ID]
    if selected not in reviewed:
        reviewed[3] = selected
    return {
        "acceptable_font_ids": [],
        "authority": REFINE.visual.AUTHORITY,
        "confidence": confidence,
        "decision_kind": kind,
        "decision_sha256": "d" * 64,
        "original_record_sha256": "e" * 64,
        "original_top1_font_id": original_top1,
        "reviewed_font_ids": reviewed,
        "selected_font_id": selected,
        "visible_candidates_only": True,
    }


class PseudoRefinementTests(unittest.TestCase):
    def test_single_day_category_policy_is_bounded_and_page_sound_is_preserved(
        self,
    ) -> None:
        rows = [
            pseudo_row("ordinary", "ordinary"),
            pseudo_row("bubble", "bubble_edge"),
            pseudo_row("sound", "page_sound"),
            pseudo_row("consensus", "text_free"),
            pseudo_row("uncertain", "ocr_hard"),
        ]
        evidence = {
            "ordinary": pass_evidence("ordinary", "ordinary"),
            "bubble": pass_evidence("bubble", "bubble_edge"),
            "sound": pass_evidence("sound", "page_sound"),
            "consensus": pass_evidence(
                "consensus",
                "text_free",
                selected_font_id=REFINE.SINGLE_DAY_ID,
                confidence=0.95,
                disagreement=0.0,
            ),
            "uncertain": pass_evidence("uncertain", "ocr_hard"),
        }
        output, lineage, report = REFINE._refine_rows(
            rows,
            pass_evidence=evidence,
            candidate_ids=ACTIVE,
            parameters=REFINE.Parameters(),
        )
        probabilities = {
            row["sample_id"]: row["probabilities"][SINGLE_DAY_INDEX] for row in output
        }
        self.assertAlmostEqual(0.30 * 0.08, probabilities["ordinary"])
        self.assertAlmostEqual(0.30 * 0.55, probabilities["bubble"])
        self.assertEqual(rows[2], output[2])
        self.assertEqual(rows[3], output[3])
        self.assertAlmostEqual(0.30 * 0.75, probabilities["uncertain"])
        self.assertEqual(
            {"ordinary", "bubble", "uncertain"}, {row["sample_id"] for row in lineage}
        )
        self.assertLess(
            report["single_day_probability_mass_after"],
            report["single_day_probability_mass_before"],
        )

    def test_visual_decision_is_a_strong_soft_target_and_can_override_category_prior(
        self,
    ) -> None:
        source_probabilities = probability_vector(single_day=0.20, top_probability=0.60)
        source_top1 = ACTIVE[0]
        source = pseudo_row(
            "visual",
            "ordinary",
            probabilities=source_probabilities,
            visual_review=visual_decision(
                selected=REFINE.SINGLE_DAY_ID,
                original_top1=source_top1,
                kind="correction",
            ),
        )
        output, lineage, report = REFINE._refine_rows(
            [source],
            pass_evidence={"visual": pass_evidence("visual", "ordinary")},
            candidate_ids=ACTIVE,
            parameters=REFINE.Parameters(),
        )
        refined = output[0]
        self.assertEqual(
            REFINE.SINGLE_DAY_ID,
            REFINE._top1(ACTIVE, refined["probabilities"]),
        )
        self.assertGreater(refined["probabilities"][SINGLE_DAY_INDEX], 0.70)
        self.assertGreaterEqual(refined["weight"], 0.98)
        self.assertEqual(1, report["visual_applied_correction"])
        self.assertEqual(
            ["single_day_category_prior", "strong_visual_soft_target"],
            [action["kind"] for action in lineage[0]["actions"]],
        )

    def test_teacher_bindings_and_loader_contract_are_preserved(self) -> None:
        source = pseudo_row("loader", "ordinary")
        output, lineage, _ = REFINE._refine_rows(
            [source],
            pass_evidence={"loader": pass_evidence("loader", "ordinary")},
            candidate_ids=ACTIVE,
            parameters=REFINE.Parameters(),
        )
        refined = output[0]
        self.assertEqual(source["candidate_ids"], refined["candidate_ids"])
        self.assertEqual(source["teacher_bindings"], refined["teacher_bindings"])
        self.assertEqual(REFINE.LOADER_AUTHORITY, refined["label_authority"])
        self.assertEqual(REFINE.LINEAGE_AUTHORITY, lineage[0]["label_authority"])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pseudo.jsonl"
            path.write_bytes(REFINE.json_bytes(refined))
            loaded = REFINE.audit.mass21.load_pseudo_targets(
                path,
                candidate_ids=ACTIVE,
                real_train_ids=frozenset({"loader"}),
                human_gold_ids=frozenset(),
            )
            self.assertEqual(1, len(loaded.targets))

    def test_invalid_embedded_visual_authority_fails_closed(self) -> None:
        decision = visual_decision(selected=ACTIVE[1], original_top1=ACTIVE[0])
        decision["authority"] = "human_gold"
        source = pseudo_row("bad", "ordinary", visual_review=decision)
        with self.assertRaisesRegex(REFINE.PseudoRefinementError, "binding drifted"):
            REFINE._refine_rows(
                [source],
                pass_evidence={"bad": pass_evidence("bad", "ordinary")},
                candidate_ids=ACTIVE,
                parameters=REFINE.Parameters(),
            )

    def test_build_validate_seals_lineage_and_refuses_unowned_replacement(self) -> None:
        rows = [
            pseudo_row("one", "ordinary"),
            pseudo_row("two", "page_sound"),
            pseudo_row("three", "ocr_hard"),
        ]
        evidence = {
            "one": pass_evidence("one", "ordinary"),
            "two": pass_evidence("two", "page_sound"),
            "three": pass_evidence("three", "ocr_hard"),
        }
        pseudo_binding = {
            "bundle_kind": "fixture",
            "file": "fixture-pseudo",
            "row_count": 3,
            "sha256": "f" * 64,
        }
        review_binding = {
            "file": "fixture-review",
            "row_count": 3,
            "sha256": "1" * 64,
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            with (
                mock.patch.object(
                    REFINE,
                    "_load_pseudo_input",
                    return_value=(rows, ACTIVE, pseudo_binding),
                ),
                mock.patch.object(
                    REFINE,
                    "_load_pass_review",
                    return_value=(evidence, review_binding),
                ),
            ):
                result = REFINE.build_refinement(
                    pseudo_targets=root / "source" / "next-pseudo-targets.jsonl",
                    pass_review=root / "pass" / "review-predictions.jsonl",
                    output_dir=output,
                    expected_pseudo_rows=3,
                    expected_review_rows=3,
                )
            self.assertEqual(3, result["loader_compatible_rows"])
            self.assertEqual(2, result["changed_rows"])
            self.assertEqual(
                REFINE.OUTPUT_FILES, {path.name for path in output.iterdir()}
            )
            report = json.loads(
                (output / REFINE.REPORT_FILE).read_text(encoding="utf-8")
            )
            report["authority"]["human_gold_promotions"] = 1
            (output / REFINE.REPORT_FILE).write_text(
                json.dumps(report), encoding="utf-8"
            )
            with self.assertRaises(REFINE.PseudoRefinementError):
                REFINE.validate_output(output)

            unowned = root / "unowned"
            unowned.mkdir()
            with (
                mock.patch.object(
                    REFINE,
                    "_load_pseudo_input",
                    return_value=(rows, ACTIVE, pseudo_binding),
                ),
                mock.patch.object(
                    REFINE,
                    "_load_pass_review",
                    return_value=(evidence, review_binding),
                ),
            ):
                with self.assertRaisesRegex(
                    REFINE.PseudoRefinementError, "unowned output"
                ):
                    REFINE.build_refinement(
                        pseudo_targets=root / "source" / "next-pseudo-targets.jsonl",
                        pass_review=root / "pass" / "review-predictions.jsonl",
                        output_dir=unowned,
                        expected_pseudo_rows=3,
                        expected_review_rows=3,
                        replace_owned_output=True,
                    )


if __name__ == "__main__":
    unittest.main()
