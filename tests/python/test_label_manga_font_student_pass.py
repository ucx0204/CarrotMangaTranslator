from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "label_manga_font_student_pass.py"
SPEC = importlib.util.spec_from_file_location(
    "label_manga_font_student_pass_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
PASS2 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PASS2
SPEC.loader.exec_module(PASS2)

QUEUE_SCRIPT = ROOT / "scripts" / "build_font_matching_multistage_review_queue.py"
QUEUE_SPEC = importlib.util.spec_from_file_location(
    "build_font_matching_multistage_review_queue_for_pass2_test", QUEUE_SCRIPT
)
assert QUEUE_SPEC is not None and QUEUE_SPEC.loader is not None
QUEUE = importlib.util.module_from_spec(QUEUE_SPEC)
sys.modules[QUEUE_SPEC.name] = QUEUE
QUEUE_SPEC.loader.exec_module(QUEUE)


def master_row(*, split: str = "train") -> PASS2.MasterRow:
    return PASS2.MasterRow(
        row_index=7,
        row_sha256="a" * 64,
        sample_id="fm-sample",
        split=split,
        work_id="work-a",
        work_title="작품",
        chapter_id="chapter-a",
        chapter_title="3화",
        page_id="page-a",
        page_name="003.png",
        source_category="page_sound",
        source_kind="hard",
        resolver_sample={"sample_id": "fm-sample", "source": {"views": {}}},
    )


def model_outputs() -> dict[str, np.ndarray]:
    candidate = np.linspace(-1.0, 1.0, 22, dtype=np.float32)[None, :]
    candidate[0, 3] = 4.0
    direct = np.linspace(1.0, -1.0, 22, dtype=np.float32)[None, :]
    direct[0, 4] = 4.0
    role = np.zeros((1, len(PASS2.ROLE_VALUES)), dtype=np.float32)
    role[0, PASS2.ROLE_VALUES.index("sfx_impact")] = 4.0
    outputs = {
        "candidate_scores": candidate,
        "direct_scores": direct,
        "none_logits": np.asarray([-2.0], dtype=np.float32),
        "role_logits": role,
        "style_logits": np.zeros((1, len(PASS2.STYLE_FIELDS)), dtype=np.float32),
        "view_gate_weights": np.asarray([[0.2, 0.3, 0.5]], dtype=np.float32),
    }
    for field, values in PASS2.TREATMENT_VALUES.items():
        logits = np.zeros((1, len(values)), dtype=np.float32)
        logits[0, 0] = 1.0
        outputs[f"treatment_{field}_logits"] = logits
    return outputs


class StudentPassTests(unittest.TestCase):
    def test_pass2_row_is_queue_compatible_and_never_training_authority(self) -> None:
        source = master_row(split="test")
        bindings = {
            "catalog_registry_sha256": "1" * 64,
            "checkpoint_sha256": "2" * 64,
            "model_contract_sha256": "3" * 64,
            "prototype_features_sha256": "4" * 64,
        }
        candidates = tuple(f"font-{index:02d}" for index in range(22))
        record = PASS2.build_pseudo_row(
            source,
            model_outputs(),
            0,
            candidate_ids=candidates,
            temperature=1.0,
            model_bindings=bindings,
        )
        PASS2.validate_record_seal(record, location="pass2 fixture")
        self.assertEqual(2, record["pass_number"])
        self.assertEqual("pseudo_not_gold", record["label_authority"])
        self.assertFalse(record["training_eligible"])
        self.assertFalse(record["promotion_allowed"])
        self.assertFalse(record["provenance"]["human_test_labels_read"])
        self.assertEqual(5, len(record["ranker"]["top5"]))
        self.assertEqual(
            round(
                record["ranker"]["top5"][0]["probability"]
                - record["ranker"]["top5"][1]["probability"],
                8,
            ),
            record["ranker"]["top1_margin"],
        )

        compact_master = {
            "chapter": {"id": source.chapter_id, "title": source.chapter_title},
            "geometry": {},
            "id": source.sample_id,
            "metadata": {"candidate_primary_category": source.source_category},
            "page": {"id": source.page_id, "name": source.page_name},
            "split": source.split,
            "views": {name: {} for name in PASS2.VIEW_NAMES},
            "work": {"id": source.work_id, "title": source.work_title},
        }
        normalized = QUEUE._normalize_pass_row(
            record,
            spec=QUEUE.PseudoPassSpec("student-pass2", Path("pass2.jsonl")),
            master=QUEUE.MasterSample(
                compact_master, source.row_index, source.row_sha256
            ),
            source_file_sha256="f" * 64,
            location="pass2 fixture",
        )
        self.assertEqual("font-03", normalized["selected_font_id"])
        self.assertEqual(2, normalized["pass_number"])
        self.assertFalse(normalized["training_eligible"])

    def test_checkpoint_inventory_is_exact_shape_dtype_sorted_and_finite(self) -> None:
        state = {
            "projection.bias": np.zeros((2,), dtype=np.float32),
            "projection.weight": np.ones((2, 3), dtype=np.float32),
        }
        contract = [
            {"dtype": "float32", "name": "projection.bias", "shape": [2]},
            {
                "dtype": "float32",
                "name": "projection.weight",
                "shape": [2, 3],
            },
        ]
        PASS2.validate_checkpoint_inventory(contract, state)
        with self.assertRaises(PASS2.StudentPassError):
            PASS2.validate_checkpoint_inventory(
                contract, {**state, "unexpected": np.ones((1,), dtype=np.float32)}
            )
        bad = dict(state)
        bad["projection.weight"] = np.full((2, 3), np.nan, dtype=np.float32)
        with self.assertRaises(PASS2.StudentPassError):
            PASS2.validate_checkpoint_inventory(contract, bad)

    def test_shard_resume_requires_seals_hashes_order_and_no_promotion(self) -> None:
        row = master_row()
        candidates = tuple(f"font-{index:02d}" for index in range(22))
        record = PASS2.build_pseudo_row(
            row,
            model_outputs(),
            0,
            candidate_ids=candidates,
            temperature=1.0,
            model_bindings={"checkpoint_sha256": "2" * 64},
        )
        core = PASS2._shard_core(
            shard_index=0,
            rows=[row],
            master_manifest_sha256="a" * 64,
            bindings={"checkpoint_sha256": "2" * 64},
            temperature=1.0,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "pass2-00000.jsonl"
            metadata = root / "pass2-00000.json"
            PASS2.write_shard(data, metadata, [record], core)
            self.assertTrue(
                PASS2.existing_shard_is_valid(
                    data_path=data,
                    metadata_path=metadata,
                    expected_core=core,
                    expected_rows=[row],
                )
            )
            tampered = dict(record)
            tampered["training_eligible"] = True
            tampered = PASS2.seal_record(tampered)
            data.write_text(PASS2.canonical_json(tampered) + "\n", encoding="utf-8")
            self.assertFalse(
                PASS2.existing_shard_is_valid(
                    data_path=data,
                    metadata_path=metadata,
                    expected_core=core,
                    expected_rows=[row],
                )
            )

    def test_master_font_label_is_not_carried_into_inference_metadata(self) -> None:
        raw = {
            "id": "fm-test",
            "split": "test",
            "font_label": "sentinel-human-test-label",
            "work": {"id": "work", "title": "작품"},
            "chapter": {"id": "chapter", "title": "1화"},
            "page": {"id": "page", "name": "001.png"},
            "views": {name: {} for name in PASS2.VIEW_NAMES},
            "metadata": {"candidate_primary_category": "ordinary"},
            "provenance": {"source_kind": "base"},
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "master.jsonl"
            path.write_text(
                json.dumps(raw, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            rows, _digest = PASS2.load_master_rows(path, frozenset({"test"}))
        self.assertEqual(1, len(rows))
        self.assertNotIn("sentinel", repr(rows[0]))
        parser = PASS2.build_parser()
        self.assertNotIn("human-export", parser.format_help())

    def test_temperature_softmax_is_stable(self) -> None:
        probabilities = PASS2.softmax(
            np.asarray([10000.0, 9999.0, -10000.0], dtype=np.float32),
            temperature=0.5,
        )
        self.assertAlmostEqual(1.0, float(probabilities.sum()), places=6)
        self.assertGreater(probabilities[0], probabilities[1])
        with self.assertRaises(PASS2.StudentPassError):
            PASS2.softmax(np.asarray([1.0]), temperature=0.0)


if __name__ == "__main__":
    unittest.main()
