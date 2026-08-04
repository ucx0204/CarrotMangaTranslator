from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_manga_font_fast_review_batches.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "build_manga_font_fast_review_batches_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


REVIEW = load_script()


def queue_row(
    sample_id: str,
    *,
    rank: int,
    work: str,
    chapter: str,
    variant: bool,
    split: str = "train",
) -> dict:
    return {
        "chapter": {"id": chapter, "title": f"{chapter}화"},
        "chapter_consistency": None,
        "geometry": {"bbox_px": [1, 2, 30, 40]},
        "label_authority": "pseudo_not_gold",
        "page": {"id": f"page-{sample_id}", "name": f"{sample_id}.png"},
        "passes": [
            {
                "candidate_count": 22,
                "direct_reference": {
                    "selected_font_id": "mongtori",
                    "top5": [
                        {
                            "font_id": "mongtori",
                            "probability": 0.51,
                            "rank": 1,
                            "score": 1.2,
                        }
                    ],
                },
                "label_authority": "pseudo_not_gold",
                "label_status": "pseudo_fixture",
                "none_probability": 0.01,
                "pass_id": "pass1",
                "pass_number": 1,
                "ranker_top5": [
                    {
                        "font_id": "mongtori",
                        "probability": 0.52,
                        "rank": 1,
                        "score": 1.3,
                    },
                    {
                        "font_id": "dohyeon",
                        "probability": 0.31,
                        "rank": 2,
                        "score": 0.8,
                    },
                ],
                "role": {
                    "top3": [{"confidence": 0.9, "role": "sfx_impact"}],
                    "variant_probability": 0.9,
                },
                "selected_font_id": "mongtori",
                "style": {"weight": 0.7},
                "top1_margin": 0.21,
                "training_eligible": False,
                "treatment": {
                    "orientation": {"confidence": 0.9, "value": "horizontal"}
                },
            },
            {
                "candidate_count": 22,
                "direct_reference": {
                    "selected_font_id": "dohyeon",
                    "top5": [
                        {
                            "font_id": "dohyeon",
                            "probability": 0.47,
                            "rank": 1,
                            "score": 1.0,
                        }
                    ],
                },
                "label_authority": "pseudo_not_gold",
                "label_status": "pseudo_fixture",
                "none_probability": 0.02,
                "pass_id": "pass2",
                "pass_number": 2,
                "ranker_top5": [
                    {
                        "font_id": "dohyeon",
                        "probability": 0.48,
                        "rank": 1,
                        "score": 1.1,
                    },
                    {
                        "font_id": "mongtori",
                        "probability": 0.39,
                        "rank": 2,
                        "score": 0.9,
                    },
                ],
                "role": {
                    "top3": [{"confidence": 0.91, "role": "sfx_impact"}],
                    "variant_probability": 0.92,
                },
                "selected_font_id": "dohyeon",
                "style": {"weight": 0.8},
                "top1_margin": 0.09,
                "training_eligible": False,
                "treatment": {
                    "orientation": {"confidence": 0.95, "value": "horizontal"}
                },
            },
        ],
        "priority": {
            "reasons": ["variant_role"] if variant else ["routine_consensus_review"],
            "score": 900 if variant else 1,
            "signals": {
                "cross_pass_top1_disagreement": True,
                "ordinary_chapter_font_switch": False,
                "small_top1_margin": True,
                "variant_category": variant,
                "variant_role": variant,
            },
            "tier": 0 if variant else 4,
        },
        "promotion_policy": {"training_promotion_allowed": False},
        "queue_id": f"queue-{sample_id}",
        "queue_rank": rank,
        "recommended_top_candidates": [
            {"font_id": "mongtori", "best_rank": 1, "mean_probability": 0.455},
            {"font_id": "dohyeon", "best_rank": 1, "mean_probability": 0.395},
        ],
        "record_sha256": f"{rank:064x}",
        "sample_id": sample_id,
        "source_category": "page_sound" if variant else "ordinary",
        "split": split,
        "training_eligible": False,
        "views": {
            name: {
                "catalog_id": "fixture",
                "expected_size_px": [224, 224],
                "file_sha256": f"{rank + index + 10:064x}",
                "path": f"images/{name}/{sample_id}.png",
                "status": "available",
            }
            for index, name in enumerate(REVIEW.VIEW_NAMES)
        },
        "work": {"id": work, "title": f"작품 {work}"},
    }


def canonical_candidates() -> dict:
    return {
        "mongtori": {"font_label": "그리운 몽토리체"},
        "dohyeon": {"font_label": "도현체"},
    }


def renders() -> dict:
    output = {}
    for candidate_id in canonical_candidates():
        output[(candidate_id, "sfx-impact", "horizontal")] = {
            "artifact": {
                "file": f"images/{candidate_id}.png",
                "height": 224,
                "sha256": "a" * 64,
                "width": 448,
            },
            "writing_mode": "horizontal",
        }
    return output


def v7_master_row(
    sample_id: str,
    *,
    source_index: int,
    chapter: str = "chapter-v7",
) -> dict:
    return {
        "chapter": {"id": chapter, "title": "7화"},
        "geometry": {"bbox_px": [1, 2, 30, 40]},
        "id": sample_id,
        "metadata": {
            "candidate_primary_category": "ordinary",
            "orientation": "horizontal",
        },
        "page": {"id": f"page-{sample_id}", "name": f"{sample_id}.png"},
        "provenance": {"source_kind": "base"},
        "split": "train",
        "views": {
            name: {
                "catalog_id": "fixture",
                "expected_size_px": [224, 224],
                "file_sha256": f"{source_index + index + 1:064x}",
                "path": f"images/{name}/{sample_id}.png",
                "status": "available",
            }
            for index, name in enumerate(REVIEW.VIEW_NAMES)
        },
        "work": {"id": "work-v7", "title": "작품 v7"},
    }


def v7_prediction(
    master_row: dict,
    *,
    source_index: int,
    selected: str,
    entropy: float,
    margin: float,
    disagreement: float,
) -> dict:
    candidate_ids = list(REVIEW.ACTIVE21_CANDIDATE_IDS)
    ordered = [selected] + [value for value in candidate_ids if value != selected]
    probabilities = [1.0 / len(candidate_ids)] * len(candidate_ids)
    top5 = [
        {
            "font_id": candidate_id,
            "probability": 0.4 / rank,
            "rank": rank,
            "score": -float(rank),
        }
        for rank, candidate_id in enumerate(ordered[:5], 1)
    ]
    row = {
        "candidate_count": len(candidate_ids),
        "candidate_ids": candidate_ids,
        "chapter_id": master_row["chapter"]["id"],
        "chapter_title": master_row["chapter"]["title"],
        "confidence": 0.5,
        "direct_reference": {
            "selected_font_id": selected,
            "source": "glyph_view_visual_query_top1",
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
        "label_status": "pseudo_visual_mass21_round_2",
        "master_row_sha256": REVIEW.sha256_bytes(
            REVIEW.canonical_json(master_row).encode("utf-8")
        ),
        "model_source_kind": "v7",
        "page_id": master_row["page"]["id"],
        "page_name": master_row["page"]["name"],
        "probabilities": probabilities,
        "promotion_allowed": False,
        "ranker": {
            "selected_font_id": selected,
            "top1_margin": margin,
            "top5": top5,
        },
        "role": {"top3": [{"confidence": 0.0, "role": "unknown"}]},
        "round": 2,
        "sample_id": master_row["id"],
        "schema_version": REVIEW.V7_SOURCE_SCHEMA,
        "selected_font_id": selected,
        "source_category": "ordinary",
        "source_kind": "base",
        "source_row_index": source_index,
        "split": "train",
        "style": {"weight": 0.5},
        "top5": top5,
        "training_eligible": False,
        "view_disagreement": {
            "js_divergence": disagreement / 2.0,
            "top1_candidate_ids": [selected, selected, selected],
            "top1_disagreement": disagreement,
        },
        "weight": 0.5,
        "work_id": master_row["work"]["id"],
        "work_title": master_row["work"]["title"],
    }
    return REVIEW.seal_record(row)


def write_v7_fixture(root: Path) -> tuple[Path, Path, str]:
    masters = [v7_master_row(f"v7-{index}", source_index=index) for index in range(4)]
    predictions = [
        v7_prediction(
            masters[0],
            source_index=0,
            selected="mongtori",
            entropy=0.15,
            margin=0.5,
            disagreement=0.0,
        ),
        v7_prediction(
            masters[1],
            source_index=1,
            selected="mongtori",
            entropy=0.2,
            margin=0.45,
            disagreement=0.0,
        ),
        v7_prediction(
            masters[2],
            source_index=2,
            selected="dohyeon",
            entropy=0.8,
            margin=0.03,
            disagreement=2.0 / 3.0,
        ),
        v7_prediction(
            masters[3],
            source_index=3,
            selected="nanum-gothic",
            entropy=0.4,
            margin=0.2,
            disagreement=0.0,
        ),
    ]
    master_path = root / "master.jsonl"
    review_path = root / "v7-review.jsonl"
    master_path.write_text(
        "".join(REVIEW.canonical_json(row) + "\n" for row in masters),
        encoding="utf-8",
    )
    review_path.write_text(
        "".join(REVIEW.canonical_json(row) + "\n" for row in predictions),
        encoding="utf-8",
    )
    return master_path, review_path, masters[3]["id"]


class FastNamedReviewTests(unittest.TestCase):
    @staticmethod
    def _fake_contact_sheets(records, *, batch_dir, rows_per_sheet, **_kwargs):
        sheets_dir = batch_dir / "contact-sheets"
        sheets_dir.mkdir(parents=True)
        sheets = []
        for sheet_number, start in enumerate(
            range(0, len(records), rows_per_sheet), 1
        ):
            chunk = records[start : start + rows_per_sheet]
            relative = f"contact-sheets/sheet-{sheet_number:04d}.png"
            path = batch_dir / relative
            path.write_bytes(
                f"fixture:{batch_dir.name}:{sheet_number}:{len(chunk)}".encode()
            )
            descriptor = {
                "file": relative,
                "height": 100 + len(chunk),
                "row_count": len(chunk),
                "sha256": REVIEW.sha256_file(path),
                "width": 200,
            }
            sheets.append(descriptor)
            for row_index, record in enumerate(chunk):
                record["sheet"] = {
                    "file": relative,
                    "row_index": row_index,
                    "sha256": descriptor["sha256"],
                }
        return sheets

    def test_v7_queue_prioritizes_uncertainty_and_chapter_outlier(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            master_path, review_path, gold_id = write_v7_fixture(root)
            rows, gold_rows, bindings = REVIEW.load_v7_review_queue(
                v7_review_path=review_path,
                master_manifest_path=master_path,
                human_gold_ids=frozenset({gold_id}),
            )

        self.assertEqual(3, len(rows))
        self.assertEqual("v7-2", rows[0]["sample_id"])
        self.assertIn(
            "same_chapter_majority_outlier", rows[0]["priority"]["reasons"]
        )
        self.assertIn("view_top1_disagreement", rows[0]["priority"]["reasons"])
        self.assertTrue(rows[0]["chapter_consistency"]["outlier"])
        self.assertEqual("mongtori", rows[0]["chapter_consistency"]["majority_font_id"])
        self.assertEqual([1, 2, 3], [row["queue_rank"] for row in rows])
        self.assertEqual({"v7-3"}, {row["sample_id"] for row in gold_rows})
        self.assertTrue(gold_rows[0]["excluded_from_re_review"])
        self.assertEqual(1, bindings["human_gold_matched_v7_rows"])
        for row in rows:
            candidate_ids = [
                value["font_id"] for value in row["recommended_top_candidates"]
            ]
            self.assertEqual(5, len(candidate_ids))
            self.assertNotIn("gugi", candidate_ids)

    def test_v7_bundle_is_active21_and_keeps_gold_out_of_review(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            master_path, review_path, gold_id = write_v7_fixture(root)
            registry = root / "registry.json"
            render_manifest = root / "render.json"
            registry.write_text("{}\n", encoding="utf-8")
            render_manifest.write_text("{}\n", encoding="utf-8")
            selected_ids = REVIEW.ACTIVE21_CANDIDATE_IDS
            fake_candidates = {
                candidate_id: {"font_label": f"label-{candidate_id}"}
                for candidate_id in selected_ids
            }
            fake_renders = {
                (candidate_id, "dialogue-body", "horizontal"): {
                    "artifact": {
                        "file": f"images/{candidate_id}.png",
                        "height": 224,
                        "sha256": "a" * 64,
                        "width": 448,
                    },
                    "writing_mode": "horizontal",
                }
                for candidate_id in selected_ids
            }
            output = root / "v7-bundle"
            with mock.patch.object(
                REVIEW,
                "_load_active21_render_bank",
                return_value=(fake_candidates, fake_renders),
            ):
                result = REVIEW.build_v7_review_bundle(
                    master_manifest_path=master_path,
                    v7_review_path=review_path,
                    human_gold_ids=frozenset({gold_id}),
                    catalog_registry_path=registry,
                    render_bank_manifest_path=render_manifest,
                    output_dir=output,
                    project_root=ROOT,
                    batch_size=3,
                    candidate_limit=5,
                    render_batch_count=0,
                    expected_human_gold_count=1,
                )

            report = json.loads((output / REVIEW.REPORT_FILE).read_text(encoding="utf-8"))
            review_rows = [
                json.loads(line)
                for line in (
                    output / "batches" / "batch-001" / "review-items.jsonl"
                ).read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(21, report["candidate_count"])
            self.assertNotIn("gugi", report["candidate_ids"])
            self.assertEqual(1, result["human_gold_separated_rows"])
            self.assertNotIn(gold_id, {row["sample_id"] for row in review_rows})
            self.assertTrue(
                all(
                    candidate["candidate_id"] != "gugi"
                    for row in review_rows
                    for candidate in row["candidates"]
                )
            )

    def test_incremental_v7_render_adds_only_next_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            master_path, review_path, gold_id = write_v7_fixture(root)
            registry = root / "registry.json"
            render_manifest = root / "render.json"
            registry.write_text("{}\n", encoding="utf-8")
            render_manifest.write_text("{}\n", encoding="utf-8")
            fake_candidates = {
                candidate_id: {"font_label": f"label-{candidate_id}"}
                for candidate_id in REVIEW.ACTIVE21_CANDIDATE_IDS
            }
            fake_renders = {
                (candidate_id, "dialogue-body", "horizontal"): {
                    "artifact": {
                        "file": f"images/{candidate_id}.png",
                        "height": 224,
                        "sha256": "a" * 64,
                        "width": 448,
                    },
                    "writing_mode": "horizontal",
                }
                for candidate_id in REVIEW.ACTIVE21_CANDIDATE_IDS
            }
            output = root / "incremental-v7"
            with (
                mock.patch.object(
                    REVIEW,
                    "_load_active21_render_bank",
                    return_value=(fake_candidates, fake_renders),
                ),
                mock.patch.object(
                    REVIEW,
                    "render_contact_sheets",
                    side_effect=self._fake_contact_sheets,
                ),
            ):
                REVIEW.build_v7_review_bundle(
                    master_manifest_path=master_path,
                    v7_review_path=review_path,
                    human_gold_ids=frozenset({gold_id}),
                    catalog_registry_path=registry,
                    render_bank_manifest_path=render_manifest,
                    output_dir=output,
                    project_root=ROOT,
                    batch_size=2,
                    candidate_limit=5,
                    rows_per_sheet=2,
                    render_batch_count=1,
                    expected_human_gold_count=1,
                )
                first_sheet = (
                    output
                    / "batches"
                    / "batch-001"
                    / "contact-sheets"
                    / "sheet-0001.png"
                )
                first_sha = REVIEW.sha256_file(first_sheet)
                first_mtime = first_sheet.stat().st_mtime_ns
                result = REVIEW.render_existing_v7_batch(
                    master_manifest_path=master_path,
                    v7_review_path=review_path,
                    catalog_registry_path=registry,
                    render_bank_manifest_path=render_manifest,
                    output_dir=output,
                    project_root=ROOT,
                    batch_number=2,
                    expected_human_gold_count=1,
                )

            report = json.loads(
                (output / REVIEW.REPORT_FILE).read_text(encoding="utf-8")
            )
            second_items = [
                json.loads(line)
                for line in (
                    output / "batches" / "batch-002" / "review-items.jsonl"
                ).read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(2, result["incrementally_rendered_batch"])
            self.assertEqual(1, result["new_sheet_count"])
            self.assertEqual(2, result["rendered_batch_count"])
            self.assertEqual(2, report["configuration"]["render_batch_count"])
            self.assertTrue(report["batches"][1]["cards_rendered"])
            self.assertTrue(all(row["sheet"] is not None for row in second_items))
            self.assertEqual(first_sha, REVIEW.sha256_file(first_sheet))
            self.assertEqual(first_mtime, first_sheet.stat().st_mtime_ns)
            validated = REVIEW.validate_review_bundle(output, verify_items=True)
            self.assertEqual(3, validated["record_count"])

    def test_incremental_v7_render_rejects_source_hash_drift_without_mutation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            master_path, review_path, gold_id = write_v7_fixture(root)
            registry = root / "registry.json"
            render_manifest = root / "render.json"
            registry.write_text("{}\n", encoding="utf-8")
            render_manifest.write_text("{}\n", encoding="utf-8")
            fake_candidates = {
                candidate_id: {"font_label": f"label-{candidate_id}"}
                for candidate_id in REVIEW.ACTIVE21_CANDIDATE_IDS
            }
            fake_renders = {
                (candidate_id, "dialogue-body", "horizontal"): {
                    "artifact": {
                        "file": f"images/{candidate_id}.png",
                        "height": 224,
                        "sha256": "a" * 64,
                        "width": 448,
                    },
                    "writing_mode": "horizontal",
                }
                for candidate_id in REVIEW.ACTIVE21_CANDIDATE_IDS
            }
            output = root / "incremental-v7-drift"
            with (
                mock.patch.object(
                    REVIEW,
                    "_load_active21_render_bank",
                    return_value=(fake_candidates, fake_renders),
                ),
                mock.patch.object(
                    REVIEW,
                    "render_contact_sheets",
                    side_effect=self._fake_contact_sheets,
                ),
            ):
                REVIEW.build_v7_review_bundle(
                    master_manifest_path=master_path,
                    v7_review_path=review_path,
                    human_gold_ids=frozenset({gold_id}),
                    catalog_registry_path=registry,
                    render_bank_manifest_path=render_manifest,
                    output_dir=output,
                    project_root=ROOT,
                    batch_size=2,
                    candidate_limit=5,
                    render_batch_count=1,
                    expected_human_gold_count=1,
                )
                report_sha = REVIEW.sha256_file(output / REVIEW.REPORT_FILE)
                review_path.write_text(
                    review_path.read_text(encoding="utf-8") + "\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    REVIEW.FastNamedReviewError, "source binding drifted"
                ):
                    REVIEW.render_existing_v7_batch(
                        master_manifest_path=master_path,
                        v7_review_path=review_path,
                        catalog_registry_path=registry,
                        render_bank_manifest_path=render_manifest,
                        output_dir=output,
                        project_root=ROOT,
                        batch_number=2,
                        expected_human_gold_count=1,
                    )

            self.assertEqual(report_sha, REVIEW.sha256_file(output / REVIEW.REPORT_FILE))
            self.assertFalse(
                (output / "batches" / "batch-002" / "contact-sheets").exists()
            )
            REVIEW.validate_review_bundle(output, verify_items=True)

    def test_first_batch_is_variant_only_and_respects_diversity_caps(self) -> None:
        rows = [
            queue_row(
                f"sample-{index:02d}",
                rank=index + 1,
                work=f"work-{index % 3}",
                chapter=f"chapter-{index % 6}",
                variant=index < 8,
            )
            for index in range(12)
        ]
        batches = REVIEW.assign_review_batches(
            rows,
            batch_size=4,
            first_batch_min_variants=4,
            per_work_cap=2,
            per_chapter_cap=1,
        )

        self.assertEqual(3, len(batches))
        self.assertTrue(all(REVIEW._is_variant(row) for row in batches[0]))
        for batch in batches:
            work_counts = Counter(row["work"]["id"] for row in batch)
            chapter_counts = Counter(row["chapter"]["id"] for row in batch)
            self.assertLessEqual(max(work_counts.values()), 2)
            self.assertLessEqual(max(chapter_counts.values()), 1)

    def test_named_item_exposes_both_predictions_but_never_promotes(self) -> None:
        row = queue_row(
            "test-sample", rank=1, work="work-a", chapter="chapter-a", variant=True, split="test"
        )
        item = REVIEW.prepare_review_item(
            row,
            batch_number=1,
            batch_position=1,
            candidate_limit=2,
            canonical_candidates=canonical_candidates(),
            renders=renders(),
        )
        sealed = REVIEW.seal_record(item)
        REVIEW.validate_review_item(sealed)

        self.assertEqual("그리운 몽토리체", sealed["candidates"][0]["font_label"])
        self.assertEqual(2, len(sealed["candidates"][0]["predictions"]))
        self.assertEqual(1, sealed["candidates"][0]["predictions"][0]["ranker"]["rank"])
        self.assertEqual(2, sealed["candidates"][0]["predictions"][1]["ranker"]["rank"])
        self.assertTrue(sealed["model_suggestions_visible"])
        self.assertFalse(sealed["promotion_allowed"])
        self.assertFalse(sealed["training_eligible"])
        self.assertTrue(sealed["test_split_training_promotion_forbidden"])

        for pass_number, purpose in REVIEW.REVIEW_PASSES:
            template = REVIEW._decision_template(sealed, pass_number, purpose)
            self.assertEqual("pseudo_not_gold", template["label_authority"])
            self.assertFalse(template["promotion_allowed"])
            self.assertFalse(template["training_eligible"])

    def test_bundle_writes_three_review_passes_and_exact_inventory(self) -> None:
        rows = [
            queue_row(
                f"sample-{index}",
                rank=index + 1,
                work=f"work-{index % 2}",
                chapter=f"chapter-{index}",
                variant=index < 3,
            )
            for index in range(5)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = {}
            for name in ("master", "pass1", "pass2", "queue", "registry", "render"):
                path = root / f"{name}.json"
                path.write_text("{}\n", encoding="utf-8")
                inputs[name] = path
            output = root / "review-output"
            fake_hashes = {
                "master_manifest": "1" * 64,
                "pass1": "2" * 64,
                "pass2": "3" * 64,
                "queue": "4" * 64,
            }
            with (
                mock.patch.object(REVIEW, "load_and_validate_queue", return_value=(rows, fake_hashes)),
                mock.patch.object(
                    REVIEW.named_review,
                    "load_render_bank",
                    return_value=(canonical_candidates(), renders()),
                ),
            ):
                result = REVIEW.build_review_bundle(
                    master_manifest_path=inputs["master"],
                    pass1_path=inputs["pass1"],
                    pass2_path=inputs["pass2"],
                    queue_path=inputs["queue"],
                    catalog_registry_path=inputs["registry"],
                    render_bank_manifest_path=inputs["render"],
                    output_dir=output,
                    project_root=ROOT,
                    batch_size=3,
                    first_batch_min_variants=3,
                    per_work_cap=2,
                    per_chapter_cap=1,
                    candidate_limit=2,
                    render_batch_count=0,
                )

            self.assertEqual(5, result["record_count"])
            self.assertEqual(2, result["batch_count"])
            self.assertEqual(3, result["first_batch_variant_rows"])
            self.assertEqual(0, result["rendered_batch_count"])
            self.assertEqual(
                REVIEW.REPORT_FILE,
                (output / REVIEW.REPORT_FILE).name,
            )
            batch = output / "batches" / "batch-001"
            templates = list(batch.glob("review-pass-*.template.jsonl"))
            self.assertEqual(3, len(templates))
            validated = REVIEW.validate_review_bundle(output, verify_items=True)
            self.assertEqual(5, validated["record_count"])


if __name__ == "__main__":
    unittest.main()
