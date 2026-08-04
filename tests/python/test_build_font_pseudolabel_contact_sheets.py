from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_pseudolabel_contact_sheets.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "build_font_pseudolabel_contact_sheets_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


CONTACTS = load_script()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(CONTACTS.canonical_json(row) + "\n")


def pseudo_row(
    sample_id: str,
    *,
    font_id: str = "dohyeon",
    top1: float = 0.45,
    top2: float = 0.40,
    direct_font_id: str | None = None,
    style_weight: float = 0.5,
    role: str = "dialogue_body",
    source_row_index: int = 0,
) -> dict:
    second_font = "jua" if font_id != "jua" else "dohyeon"
    return {
        "direct_reference": {
            "selected_font_id": direct_font_id or font_id,
        },
        "ranker": {
            "top5": [
                {
                    "font_id": font_id,
                    "probability": top1,
                    "rank": 1,
                    "score": 1.0,
                },
                {
                    "font_id": second_font,
                    "probability": top2,
                    "rank": 2,
                    "score": 0.9,
                },
            ]
        },
        "record_sha256": hashlib.sha256(sample_id.encode("utf-8")).hexdigest(),
        "role": {"top3": [{"confidence": 0.8, "role": role}]},
        "sample_id": sample_id,
        "selected_font_id": font_id,
        "source_category": "ordinary" if role == "dialogue_body" else "page_sound",
        "source_row_index": source_row_index,
        "split": "train",
        "style": {
            field: style_weight if field == "weight" else 0.5
            for field in CONTACTS.STYLE_FIELDS
        },
    }


def master_row(sample_id: str) -> dict:
    return {
        "chapter": {"id": "chapter-1", "title": "1화"},
        "id": sample_id,
        "page": {"id": f"page-{sample_id}", "name": f"{sample_id}.png"},
        "views": {view: {"fixture": sample_id} for view in CONTACTS.VIEW_NAMES},
        "work": {"id": "work-1", "title": "작품 하나"},
    }


class FakeResolver:
    @contextmanager
    def resolve_sample_view(self, sample: dict, view_name: str):
        color_seed = sum(ord(character) for character in sample["sample_id"]) % 170
        image = Image.new("RGB", (224, 224), (70 + color_seed, 245, 255 - color_seed))
        try:
            yield SimpleNamespace(image=image)
        finally:
            image.close()


class FontPseudoLabelContactSheetTests(unittest.TestCase):
    def test_family_inventory_covers_all_22_and_marks_gugi_retired(self) -> None:
        self.assertEqual(22, len(CONTACTS.FONT_FAMILY_BY_ID))
        self.assertEqual("display", CONTACTS.FONT_FAMILY_BY_ID["gugi"])
        self.assertEqual({"gugi"}, set(CONTACTS.RETIRED_FONT_IDS))

    def test_low_margin_disagreement_and_outlier_sort_first(self) -> None:
        suspicious = CONTACTS.compact_prediction(
            pseudo_row(
                "sample-suspicious",
                top1=0.451,
                top2=0.449,
                direct_font_id="jua",
            ),
            source_line_number=1,
        )
        routine = CONTACTS.compact_prediction(
            pseudo_row("sample-routine", top1=0.8, top2=0.1),
            source_line_number=2,
        )
        CONTACTS.attach_review_priority(
            [suspicious, routine],
            {"sample-suspicious": 0.9, "sample-routine": 0.0},
        )

        ordered = sorted([routine, suspicious], key=CONTACTS.review_sort_key)

        self.assertEqual("sample-suspicious", ordered[0]["sample_id"])
        self.assertTrue(ordered[0]["prediction_disagreement"])
        self.assertGreater(
            ordered[0]["review_priority_score"], ordered[1]["review_priority_score"]
        )

    def test_v7_dense_review_confidence_and_view_disagreement_are_preserved(self) -> None:
        row = pseudo_row("v7-dense", top1=0.3, top2=0.29)
        row.pop("role")
        row["confidence"] = 0.73
        row["view_disagreement"] = {"top1_disagreement": 1.0 / 3.0}

        compact = CONTACTS.compact_prediction(row, source_line_number=1)

        self.assertAlmostEqual(0.73, compact["confidence"])
        self.assertTrue(compact["prediction_disagreement"])
        self.assertAlmostEqual(1.0 / 3.0, compact["view_disagreement_score"])
        self.assertEqual("unknown", compact["role"])

    def test_feature_outlier_marks_far_member_of_same_predicted_font(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feature_path = root / "features.npy"
            index_path = root / "index.jsonl"
            # Each crop has three views. Two are near [1,0], one is orthogonal.
            features = np.asarray(
                [
                    [[1.0, 0.0], [1.0, 0.0], [1.0, 0.0]],
                    [[0.99, 0.01], [1.0, 0.0], [0.99, 0.01]],
                    [[0.0, 1.0], [0.0, 1.0], [0.0, 1.0]],
                ],
                dtype=np.float32,
            )
            np.save(feature_path, features, allow_pickle=False)
            write_jsonl(
                index_path,
                [{"sample_id": sample_id} for sample_id in ("near-a", "near-b", "far")],
            )
            manifest_path = root / "feature-manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "shards": [
                            {
                                "feature_file": feature_path.name,
                                "feature_sha256": CONTACTS.sha256_file(feature_path),
                                "index_file": index_path.name,
                                "index_sha256": CONTACTS.sha256_file(index_path),
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            rows = [
                {"predicted_font_id": "dohyeon", "sample_id": sample_id}
                for sample_id in ("near-a", "near-b", "far")
            ]

            outliers = CONTACTS.compute_feature_outliers(rows, manifest_path)

            self.assertGreater(outliers["far"], outliers["near-a"])
            self.assertGreater(outliers["far"], 0.5)

    def test_builds_grouped_sheets_and_editable_sealed_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            master_path = root / "master.jsonl"
            pseudo_path = root / "pseudo.jsonl"
            registry_path = root / "registry.json"
            output_path = root / "review-output"
            pseudo_rows = [
                pseudo_row(
                    "dohyeon-low",
                    top1=0.451,
                    top2=0.449,
                    direct_font_id="jua",
                    source_row_index=0,
                ),
                pseudo_row(
                    "dohyeon-high",
                    top1=0.8,
                    top2=0.1,
                    source_row_index=1,
                ),
                pseudo_row(
                    "gugi-retired",
                    font_id="gugi",
                    top1=0.5,
                    top2=0.3,
                    role="sfx_impact",
                    source_row_index=2,
                ),
                pseudo_row(
                    "body-serif",
                    font_id="ridi-batang",
                    top1=0.55,
                    top2=0.3,
                    source_row_index=3,
                ),
            ]
            write_jsonl(pseudo_path, pseudo_rows)
            write_jsonl(master_path, [master_row(row["sample_id"]) for row in pseudo_rows])
            registry_path.write_text("{}\n", encoding="utf-8")

            result = CONTACTS.build_bundle(
                catalog_registry_path=registry_path,
                columns=2,
                items_per_sheet=4,
                master_manifest_path=master_path,
                output_dir=output_path,
                project_root=ROOT,
                pseudo_labels_path=pseudo_path,
                resolver=FakeResolver(),
            )

            self.assertEqual(4, result["record_count"])
            self.assertEqual(3, result["sheet_count"])
            self.assertTrue(
                (output_path / "sheets" / "display" / "dohyeon" / "sheet-0001.png").is_file()
            )
            self.assertTrue(
                (output_path / "sheets" / "body-serif" / "ridi-batang" / "sheet-0001.png").is_file()
            )
            records = [
                json.loads(line)
                for line in (output_path / CONTACTS.INDEX_JSONL_FILE)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            dohyeon = [
                record
                for record in records
                if record["prediction"]["font_id"] == "dohyeon"
            ]
            self.assertEqual("dohyeon-low", dohyeon[0]["sample_id"])
            self.assertEqual("pseudo_not_gold", dohyeon[0]["label_authority"])
            self.assertFalse(dohyeon[0]["training_eligible"])
            self.assertEqual("", dohyeon[0]["correction"]["verdict"])
            CONTACTS.validate_record_seal(dohyeon[0], location="test record")
            with (output_path / CONTACTS.INDEX_CSV_FILE).open(
                "r", encoding="utf-8-sig", newline=""
            ) as handle:
                csv_rows = list(csv.DictReader(handle))
            self.assertEqual(4, len(csv_rows))
            self.assertIn("corrected_font_id", csv_rows[0])
            self.assertEqual(result, CONTACTS.validate_bundle(output_path))


if __name__ == "__main__":
    unittest.main()
