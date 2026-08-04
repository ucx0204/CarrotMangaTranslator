from __future__ import annotations

import copy
import csv
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "promote_manga_font_contact_corrections_incremental.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "promote_manga_font_contact_corrections_incremental_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


PROMOTER = load_script()
CONTACTS = PROMOTER.contacts


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_bytes(
        b"".join(
            (CONTACTS.canonical_json(row) + "\n").encode("utf-8") for row in rows
        )
    )


def base_record(
    sample_id: str,
    *,
    index: int,
    split: str = "train",
    predicted_font_id: str = "dohyeon",
) -> dict:
    family = CONTACTS.FONT_FAMILY_BY_ID[predicted_font_id]
    return CONTACTS.seal_record(
        {
            "audit": {
                "confidence": 0.4,
                "direct_reference_font_id": "jua",
                "font_outlier_score": 0.5,
                "prediction_disagreement": True,
                "pseudo_record_sha256": f"{index + 20:064x}",
                "relative_margin": 0.02,
                "review_priority_score": 0.9 - index * 0.01,
                "role": "dialogue",
                "role_confidence": 0.8,
                "top1_margin": 0.01,
                "top1_probability": 0.45,
            },
            "chapter": {"id": f"chapter-{index}", "title": f"{index}화"},
            "correction": {
                "corrected_family": "",
                "corrected_font_id": "",
                "notes": "",
                "verdict": "",
            },
            "font_review_order": index,
            "label_authority": "pseudo_not_gold",
            "page": {"id": f"page-{index}", "name": f"page-{index}.png"},
            "prediction": {
                "family": family,
                "font_id": predicted_font_id,
                "retired_font": predicted_font_id == "gugi",
            },
            "review_order": index,
            "sample_id": sample_id,
            "schema_version": CONTACTS.INDEX_SCHEMA_VERSION,
            "sheet": {"cell": index, "file": "sheets/display/dohyeon/sheet-0001.png"},
            "source": {
                "category": "ordinary",
                "pseudo_row_index": index - 1,
                "split": split,
                "view_name": "glyph_224",
            },
            "training_eligible": False,
            "work": {"id": f"work-{index}", "title": f"work {index}"},
        }
    )


def build_contact_bundle(root: Path, rows: list[dict]) -> Path:
    bundle = root / "contact"
    sheet = bundle / "sheets" / "display" / "dohyeon" / "sheet-0001.png"
    sheet.parent.mkdir(parents=True)
    sheet.write_bytes(b"fixture-sheet")
    index_jsonl = bundle / CONTACTS.INDEX_JSONL_FILE
    write_jsonl(index_jsonl, rows)
    index_csv = bundle / CONTACTS.INDEX_CSV_FILE
    with index_csv.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CONTACTS.CSV_FIELDS)
        writer.writeheader()
        writer.writerows(CONTACTS._csv_record(row) for row in rows)
    readme = bundle / CONTACTS.README_FILE
    readme.write_text("fixture\n", encoding="utf-8")
    report = CONTACTS.seal_record(
        {
            "artifacts": {
                "correction_csv": {
                    "file": index_csv.name,
                    "sha256": CONTACTS.sha256_file(index_csv),
                },
                "correction_jsonl": {
                    "file": index_jsonl.name,
                    "record_count": len(rows),
                    "sha256": CONTACTS.sha256_file(index_jsonl),
                },
                "readme": {
                    "file": readme.name,
                    "sha256": CONTACTS.sha256_file(readme),
                },
                "sheets": [
                    {
                        "family": "display",
                        "file": "sheets/display/dohyeon/sheet-0001.png",
                        "font_id": "dohyeon",
                        "height": 1,
                        "row_count": len(rows),
                        "sha256": CONTACTS.sha256_file(sheet),
                        "width": 1,
                    }
                ],
            },
            "boundary": {
                "label_authority": "pseudo_not_gold",
                "model_suggestions_visible": True,
                "training_eligible_rows": 0,
            },
            "configuration": {},
            "inputs": {"master_manifest_sha256": "1" * 64},
            "record_type": "font_pseudolabel_contact_sheet_report",
            "schema_version": CONTACTS.SCHEMA_VERSION,
            "stats": {
                "record_count": len(rows),
                "sheet_count": 1,
            },
        }
    )
    report_path = bundle / CONTACTS.REPORT_FILE
    report_path.write_bytes(CONTACTS.json_bytes(report, pretty=True))
    marker = {
        "owner": CONTACTS.OWNER,
        "report_sha256": CONTACTS.sha256_file(report_path),
        "safe_replace": True,
        "schema_version": CONTACTS.SCHEMA_VERSION,
    }
    (bundle / CONTACTS.MARKER_FILE).write_bytes(CONTACTS.json_bytes(marker, pretty=True))
    CONTACTS.validate_bundle(bundle)
    return bundle


def master_row(base: dict) -> dict:
    page_sha = f"{int(base['review_order']) + 300:064x}"
    return {
        "catalog_version": 1,
        "chapter": copy.deepcopy(base["chapter"]),
        "id": base["sample_id"],
        "page": {
            **copy.deepcopy(base["page"]),
            "source_locator": {"file_sha256": page_sha},
            "source_page_sha256": page_sha,
        },
        "provenance": {
            "approval": "exhaustive_manual_visual_review",
            "qa_overlay": False,
            "synthetic": False,
        },
        "schema_version": 1,
        "split": base["source"]["split"],
        "work": copy.deepcopy(base["work"]),
        "work_balance_weight": 0.25,
    }


def build_master(root: Path, rows: list[dict]) -> Path:
    master = root / "master"
    master.mkdir()
    manifest = master / "manifest.jsonl"
    write_jsonl(manifest, rows)
    split_map = master / "split_map.json"
    split_map.write_text("{}\n", encoding="utf-8")
    report = {
        "outputs": {
            "master_manifest": manifest.name,
            "master_manifest_sha256": CONTACTS.sha256_file(manifest),
            "split_map": split_map.name,
            "split_map_sha256": CONTACTS.sha256_file(split_map),
        },
        "report_schema_version": 1,
        "tool": "manga-translator-font-matching-master-builder",
    }
    (master / "report.json").write_text(json.dumps(report), encoding="utf-8")
    return manifest


def edit_csv(bundle: Path, root: Path, changes: dict[str, dict]) -> Path:
    with (bundle / CONTACTS.INDEX_CSV_FILE).open(
        "r", encoding="utf-8-sig", newline=""
    ) as handle:
        rows = list(csv.DictReader(handle))
    extension_fields = sorted(
        {
            field
            for values in changes.values()
            for field in values
            if field not in CONTACTS.CSV_FIELDS
        }
    )
    fields = [*CONTACTS.CSV_FIELDS, *extension_fields]
    for row in rows:
        row.update({field: "" for field in extension_fields})
        row.update(changes.get(row["sample_id"], {}))
    path = root / "edited.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return path


def edit_jsonl(bundle: Path, root: Path, changes: dict[str, dict], name: str = "edited.jsonl") -> Path:
    rows = [
        json.loads(line)
        for line in (bundle / CONTACTS.INDEX_JSONL_FILE)
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    for row in rows:
        row["correction"].update(changes.get(row["sample_id"], {}))
    path = root / name
    write_jsonl(path, rows)
    return path


class IncrementalContactCorrectionTests(unittest.TestCase):
    reviewer = "fixture-reviewer"
    reviewed_at = "2026-08-03T12:00:00+09:00"

    def fixture(self, root: Path, rows: list[dict]):
        bundle = build_contact_bundle(root, rows)
        manifest = build_master(root, [master_row(row) for row in rows])
        return bundle, manifest

    def test_blank_full_index_promotes_zero_and_keeps_train_val_remaining(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [
                base_record("train", index=1, split="train"),
                base_record("val", index=2, split="val"),
                base_record("test", index=3, split="test"),
            ]
            bundle, manifest = self.fixture(root, rows)
            output = root / "output"
            result = PROMOTER.build_incremental(
                contact_bundle=bundle,
                corrections_path=bundle / CONTACTS.INDEX_JSONL_FILE,
                master_manifest=manifest,
                output_dir=output,
            )
            self.assertEqual(0, result["record_count"])
            self.assertEqual(2, result["remaining_record_count"])
            self.assertEqual("", (output / PROMOTER.OVERLAY_FILE).read_text())

    def test_partial_csv_promotes_accept_correct_and_none_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [
                base_record("accept", index=1),
                base_record("correct", index=2),
                base_record("none", index=3, predicted_font_id="gugi"),
                base_record("pending", index=4),
            ]
            bundle, manifest = self.fixture(root, rows)
            corrections = edit_csv(
                bundle,
                root,
                {
                    "accept": {"verdict": "accept"},
                    "correct": {
                        "verdict": "correct",
                        "corrected_font_id": "jua",
                        "corrected_family": "display",
                    },
                    "none": {"verdict": "reject"},
                },
            )
            output = root / "output"
            result = PROMOTER.build_incremental(
                contact_bundle=bundle,
                corrections_path=corrections,
                master_manifest=manifest,
                output_dir=output,
                default_reviewer=self.reviewer,
                default_reviewed_at=self.reviewed_at,
            )
            self.assertEqual(3, result["record_count"])
            self.assertEqual(1, result["remaining_record_count"])
            promoted = {
                row["sample_id"]: row
                for row in (
                    json.loads(line)
                    for line in (output / PROMOTER.OVERLAY_FILE)
                    .read_text(encoding="utf-8")
                    .splitlines()
                )
            }
            self.assertEqual(["dohyeon"], promoted["accept"]["font_judgment"]["preferred"])
            self.assertEqual(["jua"], promoted["correct"]["font_judgment"]["preferred"])
            self.assertEqual(2, sum(promoted["correct"]["candidate_mask"]))
            self.assertTrue(promoted["none"]["font_judgment"]["none_acceptable"])
            self.assertEqual(0, sum(promoted["none"]["candidate_mask"]))

    def test_jsonl_supports_acceptable_and_explicit_partial_mask(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [base_record("sample", index=1)]
            bundle, manifest = self.fixture(root, rows)
            corrections = edit_jsonl(
                bundle,
                root,
                {
                    "sample": {
                        "verdict": "accept",
                        "acceptable_font_ids": ["jua"],
                        "reviewed_font_ids": ["dohyeon", "jua", "mongtori"],
                    }
                },
            )
            prepared = PROMOTER.prepare_incremental(
                contact_bundle=bundle,
                corrections_path=corrections,
                master_manifest=manifest,
                default_reviewer=self.reviewer,
                default_reviewed_at=self.reviewed_at,
            )
            judgment = prepared.overlay_rows[0]["font_judgment"]
            self.assertEqual(["jua"], judgment["acceptable"])
            self.assertIn("mongtori", judgment["unacceptable"])
            self.assertEqual(3, sum(prepared.overlay_rows[0]["candidate_mask"]))

    def test_gugi_accept_and_unknown_correction_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [base_record("sample", index=1, predicted_font_id="gugi")]
            bundle, manifest = self.fixture(root, rows)
            gugi = edit_csv(bundle, root, {"sample": {"verdict": "accept"}})
            with self.assertRaisesRegex(
                PROMOTER.IncrementalContactCorrectionError, "Gugi|unknown positive"
            ):
                PROMOTER.prepare_incremental(
                    contact_bundle=bundle,
                    corrections_path=gugi,
                    master_manifest=manifest,
                    default_reviewer=self.reviewer,
                    default_reviewed_at=self.reviewed_at,
                )

            unknown = edit_csv(
                bundle,
                root,
                {
                    "sample": {
                        "verdict": "correct",
                        "corrected_font_id": "not-a-font",
                        "corrected_family": "display",
                    }
                },
            )
            with self.assertRaisesRegex(
                PROMOTER.IncrementalContactCorrectionError, "family|unknown positive"
            ):
                PROMOTER.prepare_incremental(
                    contact_bundle=bundle,
                    corrections_path=unknown,
                    master_manifest=manifest,
                    default_reviewer=self.reviewer,
                    default_reviewed_at=self.reviewed_at,
                )

    def test_test_verdict_and_duplicate_rows_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [base_record("test", index=1, split="test")]
            bundle, manifest = self.fixture(root, rows)
            correction = edit_jsonl(
                bundle, root, {"test": {"verdict": "accept"}}
            )
            with self.assertRaisesRegex(
                PROMOTER.IncrementalContactCorrectionError, "test verdict"
            ):
                PROMOTER.prepare_incremental(
                    contact_bundle=bundle,
                    corrections_path=correction,
                    master_manifest=manifest,
                    default_reviewer=self.reviewer,
                    default_reviewed_at=self.reviewed_at,
                )
            duplicated = root / "duplicate.jsonl"
            lines = correction.read_text(encoding="utf-8").splitlines()
            duplicated.write_text("\n".join([*lines, lines[0]]) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(
                PROMOTER.IncrementalContactCorrectionError, "duplicate"
            ):
                PROMOTER.prepare_incremental(
                    contact_bundle=bundle,
                    corrections_path=duplicated,
                    master_manifest=manifest,
                    default_reviewer=self.reviewer,
                    default_reviewed_at=self.reviewed_at,
                )

    def test_master_identity_drift_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [base_record("sample", index=1)]
            bundle = build_contact_bundle(root, rows)
            drifted = master_row(rows[0])
            drifted["page"]["id"] = "wrong-page"
            manifest = build_master(root, [drifted])
            with self.assertRaisesRegex(
                PROMOTER.IncrementalContactCorrectionError, "identity mismatch"
            ):
                PROMOTER.prepare_incremental(
                    contact_bundle=bundle,
                    corrections_path=bundle / CONTACTS.INDEX_JSONL_FILE,
                    master_manifest=manifest,
                )

    def test_previous_output_appends_changed_correction_history(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [base_record("sample", index=1)]
            bundle, manifest = self.fixture(root, rows)
            first_corrections = edit_jsonl(
                bundle, root, {"sample": {"verdict": "accept"}}, "first.jsonl"
            )
            first_output = root / "first-output"
            PROMOTER.build_incremental(
                contact_bundle=bundle,
                corrections_path=first_corrections,
                master_manifest=manifest,
                output_dir=first_output,
                default_reviewer=self.reviewer,
                default_reviewed_at=self.reviewed_at,
            )
            second_corrections = edit_jsonl(
                bundle,
                root,
                {
                    "sample": {
                        "verdict": "correct",
                        "corrected_font_id": "jua",
                        "corrected_family": "display",
                        "notes": "second look",
                    }
                },
                "second.jsonl",
            )
            second_output = root / "second-output"
            result = PROMOTER.build_incremental(
                contact_bundle=bundle,
                corrections_path=second_corrections,
                master_manifest=manifest,
                output_dir=second_output,
                default_reviewer=self.reviewer,
                default_reviewed_at="2026-08-03T13:00:00+09:00",
                previous_output_dir=first_output,
            )
            row = json.loads(
                (second_output / PROMOTER.OVERLAY_FILE).read_text().splitlines()[0]
            )
            self.assertEqual(1, result["record_count"])
            self.assertEqual(2, len(row["correction_history"]))
            self.assertEqual(["jua"], row["font_judgment"]["preferred"])


if __name__ == "__main__":
    unittest.main()
