from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "finalize_manga_font_fast_review_overlay_v1.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "finalize_manga_font_fast_review_overlay_v1_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


FINALIZER = load_script()
REVIEW = FINALIZER.review


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"".join(
            (REVIEW.canonical_json(row) + "\n").encode("utf-8") for row in rows
        )
    )


def make_review_item(sample_id: str, split: str, index: int) -> dict:
    page_sha = f"{index + 100:064x}"
    return REVIEW.seal_record(
        {
            "batch_number": 1,
            "batch_position": index,
            "candidates": [
                {"candidate_id": "mongtori"},
                {"candidate_id": "dohyeon"},
                {"candidate_id": "gugi"},
            ],
            "chapter": {"id": f"chapter-{index}", "title": f"{index}화"},
            "chapter_consistency": None,
            "label_authority": "pseudo_not_gold",
            "model_suggestions_visible": True,
            "page": {
                "id": f"page-{index}",
                "name": f"page-{index}.png",
                "source_locator": {"file_sha256": page_sha},
                "source_page_sha256": page_sha,
            },
            "pass_summaries": [],
            "priority": {},
            "promotion_allowed": False,
            "queue_id": f"queue-{index}",
            "queue_rank": index,
            "queue_record_sha256": f"{index:064x}",
            "record_type": REVIEW.RECORD_TYPE,
            "review_mode": "named_non_blind_three_pass",
            "role_probe": {
                "probe_id": "dialogue-body",
                "role": "dialogue",
                "writing_mode": "horizontal",
            },
            "sample_id": sample_id,
            "schema_version": REVIEW.SCHEMA_VERSION,
            "sheet": None,
            "source": {
                "geometry": {"bbox_px": [1, 2, 30, 40]},
                "source_category": "ordinary",
                "views": {name: {} for name in REVIEW.VIEW_NAMES},
            },
            "split": split,
            "test_split_training_promotion_forbidden": split == "test",
            "training_eligible": False,
            "work": {"id": f"work-{index}", "title": f"work {index}"},
        }
    )


def build_review_bundle(root: Path, items: list[dict]) -> Path:
    bundle = root / "review"
    batch = bundle / "batches" / "batch-001"
    batch.mkdir(parents=True)
    items_path = batch / "review-items.jsonl"
    write_jsonl(items_path, items)
    pass_descriptors = {}
    for pass_number, purpose in REVIEW.REVIEW_PASSES:
        name = f"review-pass-{pass_number}-{purpose}.template.jsonl"
        path = batch / name
        write_jsonl(
            path,
            [REVIEW._decision_template(item, pass_number, purpose) for item in items],
        )
        pass_descriptors[name] = {"file": name, "sha256": REVIEW.sha256_file(path)}
    readme = bundle / REVIEW.README_FILE
    readme.write_text("fixture review bundle\n", encoding="utf-8")
    report = REVIEW.seal_record(
        {
            "artifacts": {
                "readme": {
                    "file": REVIEW.README_FILE,
                    "sha256": REVIEW.sha256_file(readme),
                }
            },
            "batches": [
                {
                    "artifacts": {
                        "review_items": {
                            "file": items_path.name,
                            "sha256": REVIEW.sha256_file(items_path),
                        },
                        "review_pass_templates": pass_descriptors,
                    },
                    "batch": "batch-001",
                    "batch_number": 1,
                    "cards_rendered": False,
                    "sheets": [],
                    "stats": {"rows": len(items), "variant_rows": 0},
                }
            ],
            "boundary": {
                "direct_gold_promotion_allowed": False,
                "label_authority": "pseudo_not_gold",
                "model_suggestions_visible": True,
                "review_passes": 3,
                "test_split_training_promotion_forbidden": True,
                "training_eligible_rows": 0,
            },
            "candidate_ids": list(FINALIZER.FULL_CANDIDATE_IDS),
            "inputs": {},
            "record_type": REVIEW.REPORT_TYPE,
            "schema_version": REVIEW.SCHEMA_VERSION,
            "stats": {"rows": len(items)},
        }
    )
    report_path = bundle / REVIEW.REPORT_FILE
    report_path.write_bytes(REVIEW.json_bytes(report, pretty=True))
    marker = {
        "owner": REVIEW.OWNER,
        "report_sha256": REVIEW.sha256_file(report_path),
        "safe_replace": True,
        "schema_version": REVIEW.SCHEMA_VERSION,
    }
    (bundle / REVIEW.MARKER_FILE).write_bytes(REVIEW.json_bytes(marker, pretty=True))
    REVIEW.validate_review_bundle(bundle, verify_items=True)
    return bundle


def make_master_row(item: dict) -> dict:
    return {
        "catalog_version": 1,
        "chapter": copy.deepcopy(item["chapter"]),
        "id": item["sample_id"],
        "page": copy.deepcopy(item["page"]),
        "provenance": {
            "approval": "exhaustive_manual_visual_review",
            "qa_overlay": False,
            "synthetic": False,
        },
        "schema_version": 1,
        "split": item["split"],
        "work": copy.deepcopy(item["work"]),
        "work_balance_weight": 0.25,
    }


def build_master(root: Path, rows: list[dict]) -> Path:
    master = root / "master-v3"
    master.mkdir()
    manifest = master / "manifest.jsonl"
    write_jsonl(manifest, rows)
    split_map = master / "split_map.json"
    split_map.write_text("{}\n", encoding="utf-8")
    report = {
        "outputs": {
            "master_manifest": manifest.name,
            "master_manifest_sha256": REVIEW.sha256_file(manifest),
            "split_map": split_map.name,
            "split_map_sha256": REVIEW.sha256_file(split_map),
        },
        "report_schema_version": 1,
        "tool": "manga-translator-font-matching-master-builder",
    }
    (master / "report.json").write_text(
        json.dumps(report, ensure_ascii=False), encoding="utf-8"
    )
    return manifest


def build_decisions(
    root: Path,
    items: list[dict],
    *,
    full_mask: bool = False,
) -> list[Path]:
    output = []
    for pass_number, purpose in REVIEW.REVIEW_PASSES:
        rows = []
        for item in items:
            row = REVIEW._decision_template(item, pass_number, purpose)
            row.update(
                {
                    "confidence": 0.8 + pass_number * 0.01,
                    "decision_status": "completed",
                    "none_acceptable": False,
                    "notes": "corrected after recheck" if pass_number == 2 else "",
                    "reviewed_at": f"2026-08-0{pass_number}T01:02:03+09:00",
                    "reviewer": f"reviewer-{pass_number}",
                    "selected_font_id": "mongtori" if pass_number == 1 else "dohyeon",
                }
            )
            if full_mask:
                row["reviewed_font_ids"] = list(FINALIZER.ACTIVE_CANDIDATE_IDS)
            rows.append(row)
        path = root / "decisions" / f"pass-{pass_number}.jsonl"
        write_jsonl(path, rows)
        output.append(path)
    return output


class FastReviewFinalizerTests(unittest.TestCase):
    def fixture(self, root: Path):
        items = [
            make_review_item("sample-train", "train", 1),
            make_review_item("sample-val", "val", 2),
            make_review_item("sample-test", "test", 3),
        ]
        bundle = build_review_bundle(root, items)
        manifest = build_master(root, [make_master_row(item) for item in items])
        decisions = build_decisions(root, items)
        return items, bundle, manifest, decisions

    def test_builds_active21_partial_overlay_and_omits_test(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, bundle, manifest, decisions = self.fixture(root)
            output = root / "output"
            result = FINALIZER.build_overlay(
                review_dir=bundle,
                master_manifest=manifest,
                decision_paths=decisions,
                output_dir=output,
            )

            self.assertEqual(2, result["record_count"])
            self.assertEqual(1, result["training_eligible_rows"])
            self.assertEqual(1, result["validation_rows"])
            self.assertEqual(2, result["partial_candidate_mask_rows"])
            rows = [
                json.loads(line)
                for line in (output / FINALIZER.OVERLAY_FILE)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual({"train", "val"}, {row["split"] for row in rows})
            train = next(row for row in rows if row["split"] == "train")
            self.assertEqual(["dohyeon"], train["font_judgment"]["preferred"])
            self.assertEqual(2, sum(train["candidate_mask"]))
            self.assertNotIn("gugi", train["candidate_ids"])
            self.assertEqual(1, len(train["review_provenance"]["corrections"]))
            self.assertFalse(train["review_provenance"]["agreement"]["unanimous"])

    def test_full_reviewed_font_list_emits_full_mask(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            items = [make_review_item("sample-train", "train", 1)]
            bundle = build_review_bundle(root, items)
            manifest = build_master(root, [make_master_row(items[0])])
            decisions = build_decisions(root, items, full_mask=True)
            prepared = FINALIZER.prepare_overlay(
                review_dir=bundle,
                master_manifest=manifest,
                decision_paths=decisions,
            )
            self.assertEqual(1, prepared.stats["full_candidate_mask_rows"])
            self.assertFalse(prepared.rows[0]["partial_candidate_mask"])
            self.assertTrue(all(prepared.rows[0]["candidate_mask"]))

    def test_missing_pass_row_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, bundle, manifest, decisions = self.fixture(root)
            rows = (decisions[2]).read_text(encoding="utf-8").splitlines()
            decisions[2].write_text("\n".join(rows[:-1]) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(
                FINALIZER.FastReviewFinalizationError, "incomplete"
            ):
                FINALIZER.prepare_overlay(
                    review_dir=bundle,
                    master_manifest=manifest,
                    decision_paths=decisions,
                )

    def test_retired_or_unknown_positive_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            items = [make_review_item("sample-train", "train", 1)]
            bundle = build_review_bundle(root, items)
            manifest = build_master(root, [make_master_row(items[0])])
            decisions = build_decisions(root, items)
            rows = [json.loads(line) for line in decisions[2].read_text().splitlines()]
            rows[0]["selected_font_id"] = "gugi"
            write_jsonl(decisions[2], rows)
            with self.assertRaisesRegex(
                FINALIZER.FastReviewFinalizationError, "retired or unknown"
            ):
                FINALIZER.prepare_overlay(
                    review_dir=bundle,
                    master_manifest=manifest,
                    decision_paths=decisions,
                )

    def test_none_and_positive_conflict_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            items = [make_review_item("sample-train", "train", 1)]
            bundle = build_review_bundle(root, items)
            manifest = build_master(root, [make_master_row(items[0])])
            decisions = build_decisions(root, items)
            rows = [json.loads(line) for line in decisions[2].read_text().splitlines()]
            rows[0]["none_acceptable"] = True
            write_jsonl(decisions[2], rows)
            with self.assertRaisesRegex(
                FINALIZER.FastReviewFinalizationError, "conflicts"
            ):
                FINALIZER.prepare_overlay(
                    review_dir=bundle,
                    master_manifest=manifest,
                    decision_paths=decisions,
                )

    def test_master_page_identity_drift_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            items = [make_review_item("sample-train", "train", 1)]
            bundle = build_review_bundle(root, items)
            master_row = make_master_row(items[0])
            master_row["page"]["id"] = "wrong-page"
            manifest = build_master(root, [master_row])
            decisions = build_decisions(root, items)
            with self.assertRaisesRegex(
                FINALIZER.FastReviewFinalizationError, "identity mismatch"
            ):
                FINALIZER.prepare_overlay(
                    review_dir=bundle,
                    master_manifest=manifest,
                    decision_paths=decisions,
                )


if __name__ == "__main__":
    unittest.main()
