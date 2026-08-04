from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from scripts import build_font_matching_successor_authority_intake_v5 as INTAKE
from scripts import font_matching_redacted_source_precheck_v5 as REDACTED


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(REDACTED.canonical_json_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(REDACTED.jsonl_bytes(rows))


class RedactedFixture:
    def __init__(
        self,
        root: Path,
        *,
        sample_prefix: str = "fm_private",
        sample_count: int = 8,
    ) -> None:
        if sample_count < 2 or sample_count % 2:
            raise ValueError("fixture sample_count must be even and at least two")
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.original_project_root = REDACTED.PROJECT_ROOT
        REDACTED.PROJECT_ROOT = root
        self.surface = root / "private-source-name-with-sample-id.png"
        Image.new("RGB", (12, 8), (20, 30, 40)).save(self.surface)
        surface_sha = REDACTED.sha256_file(self.surface)
        catalog_root = root / "datasets" / "fixture-source"
        library_root = root / "library"
        catalog_manifest = catalog_root / "manifest.jsonl"
        catalog_manifest.parent.mkdir(parents=True, exist_ok=True)
        catalog_manifest.write_text("{}\n", encoding="utf-8")
        registry_path = root / "catalog-registry.json"
        write_json(
            registry_path,
            REDACTED.seal(
                {
                    "catalogs": [
                        {
                            "catalog_id": "fixture-source",
                            "root": str(catalog_root.resolve()),
                            "manifest_name": "manifest.jsonl",
                            "manifest_sha256": REDACTED.sha256_file(catalog_manifest),
                        }
                    ]
                }
            ),
        )
        source_page = library_root / "works" / "private-page.png"
        source_page.parent.mkdir(parents=True, exist_ok=True)
        source_page.write_bytes(self.surface.read_bytes())
        master_rows: list[dict[str, object]] = []
        self.sample_ids = [
            f"{sample_prefix}_{index:03d}" for index in range(sample_count)
        ]
        for sample_index, sample_id in enumerate(self.sample_ids):
            sample_paths = {
                "raw_native": catalog_root / "images" / "raw" / f"{sample_id}.png",
                "context_224": catalog_root
                / "images"
                / "context_224"
                / f"{sample_id}.png",
                "glyph_224": catalog_root
                / "images"
                / "glyph_224"
                / f"{sample_id}.png",
            }
            sample_shas: dict[str, str] = {}
            for kind_index, (kind, path) in enumerate(sample_paths.items()):
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.new(
                    "RGB",
                    (12, 8),
                    (
                        (sample_index * 31 + kind_index * 7) % 256,
                        (sample_index * 47 + kind_index * 11) % 256,
                        (sample_index * 59 + kind_index * 13) % 256,
                    ),
                ).save(path)
                sample_shas[kind] = REDACTED.sha256_file(path)
            master_rows.append(
                {
                    "id": sample_id,
                    "split": "train",
                    "provenance": {
                        "synthetic": False,
                        "qa_overlay": False,
                        "source_catalog_id": "fixture-source",
                    },
                    "page": {
                        "source_locator": {
                            "path": "works/private-page.png",
                            "file_sha256": surface_sha,
                            "size_px": [12, 8],
                            "provenance": "real_preserved",
                            "storage_root": "library_root",
                        }
                    },
                    "views": {
                        "raw_224": {
                            "source_native": {
                                "status": "available",
                                "path": f"images/raw/{sample_id}.png",
                                "file_sha256": sample_shas["raw_native"],
                                "declared_size_px": [12, 8],
                            }
                        },
                        "context_224": {
                            "status": "available",
                            "path": f"images/context_224/{sample_id}.png",
                            "file_sha256": sample_shas["context_224"],
                            "expected_size_px": [12, 8],
                        },
                        "glyph_224": {
                            "status": "available",
                            "path": f"images/glyph_224/{sample_id}.png",
                            "file_sha256": sample_shas["glyph_224"],
                            "expected_size_px": [12, 8],
                        },
                    },
                }
            )
        self.master_path = root / "successor-master.jsonl"
        write_jsonl(self.master_path, master_rows)
        master_by_id = {str(row["id"]): row for row in master_rows}
        shards: dict[str, dict[str, object]] = {}
        shard_size = sample_count // 2
        for shard_index, shard in enumerate(("a", "b")):
            rows: list[dict[str, object]] = []
            for local_index in range(shard_size):
                global_index = shard_index * shard_size + local_index
                sample_id = self.sample_ids[global_index]
                rows.append(
                    REDACTED.seal(
                        {
                            "schema_version": REDACTED.QUEUE_SCHEMA,
                            "record_type": REDACTED.QUEUE_ITEM_RECORD_TYPE,
                            "queue_id": "private-queue",
                            "shard": shard,
                            "sample_id": sample_id,
                            "review_order": local_index + 1,
                            "canonical_split": "train",
                            "work_id": f"private-work-{global_index % 15:02d}",
                            "proposed_role": "must-stay-private",
                            "proposed_stratum": "ordinary_body",
                            "ocr_hint_private": "must-stay-private",
                            "work_title": "must-stay-private",
                            "related_hashes": {
                                "successor_master_row_canonical_sha256": (
                                    REDACTED.sha256_bytes(
                                        REDACTED.canonical_json_bytes(
                                            master_by_id[sample_id]
                                        )
                                    )
                                )
                            },
                            "source_evidence": {
                                "surface_kind": "existing_source_only_card",
                                "source_only_card": {
                                    "path": str(self.surface.resolve()),
                                    "sha256": surface_sha,
                                    "size_px": [12, 8],
                                },
                            },
                        }
                    )
                )
            queue_path = root / f"queue-{shard}.jsonl"
            write_jsonl(queue_path, rows)
            shards[shard] = {
                "path": str(queue_path.resolve()),
                "sha256": REDACTED.sha256_file(queue_path),
                    "row_count": len(rows),
            }
        self.queue_manifest_path = root / "source-queue-manifest.json"
        write_json(
            self.queue_manifest_path,
            REDACTED.seal(
                {
                    "schema_version": REDACTED.QUEUE_SCHEMA,
                    "record_type": "font_replacement_reservoir_source_queue_manifest",
                    "candidate_count": sample_count,
                    "shards": shards,
                    "selection_contract": {
                        "authority_master_manifest": {
                            "path": str(self.master_path.resolve()),
                            "sha256": REDACTED.sha256_file(self.master_path),
                        },
                        "catalog_registry": {
                            "path": str(registry_path.resolve()),
                            "sha256": REDACTED.sha256_file(registry_path),
                            "record_sha256": REDACTED.read_json(registry_path)[
                                "record_sha256"
                            ],
                        },
                    },
                }
            ),
        )
        self.pack_a_root = root / "pack-a"
        self.pack_b_root = root / "pack-b"
        REDACTED.build_pack(
            source_queue_manifest=self.queue_manifest_path,
            output_root=self.pack_a_root,
            pack_id="redacted-a",
            intended_reviewer_id="reviewer-a",
        )
        REDACTED.build_pack(
            source_queue_manifest=self.queue_manifest_path,
            output_root=self.pack_b_root,
            pack_id="redacted-b",
            intended_reviewer_id="reviewer-b",
        )
        self.pack_a = self.pack_a_root / "reviewer-pack" / "manifest.json"
        self.pack_b = self.pack_b_root / "reviewer-pack" / "manifest.json"

    def close(self) -> None:
        REDACTED.PROJECT_ROOT = self.original_project_root

    def response_path(self, pack: Path, name: str) -> Path:
        _, tasks = REDACTED.load_pack(pack)
        path = self.root / name
        write_jsonl(
            path,
            [
                {
                    "public_precheck_task_id": task["public_precheck_task_id"],
                    "review_order": task["review_order"],
                    "eligibility_axes": {axis: True for axis in REDACTED.AXES},
                    "defect_code": "none",
                }
                for task in tasks
            ],
        )
        return path

    def seal_reviews(self) -> tuple[Path, Path]:
        out_a = self.root / "review-a"
        out_b = self.root / "review-b"
        REDACTED.seal_review(
            pack_manifest=self.pack_a,
            responses_path=self.response_path(self.pack_a, "responses-a.jsonl"),
            reviewer_id="reviewer-a",
            output_root=out_a,
        )
        REDACTED.seal_review(
            pack_manifest=self.pack_b,
            responses_path=self.response_path(self.pack_b, "responses-b.jsonl"),
            reviewer_id="reviewer-b",
            output_root=out_b,
        )
        return out_a / "summary.json", out_b / "summary.json"


class RedactedSourcePrecheckV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = RedactedFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.fixture.close()
        self.temp.cleanup()

    def test_public_packs_are_opaque_and_reviewer_specific(self) -> None:
        public_ids: list[set[str]] = []
        public_surface_sequences: list[list[tuple[tuple[str, str], ...]]] = []
        private_source_sets: list[set[str]] = []
        for root, manifest_path in (
            (self.fixture.pack_a_root, self.fixture.pack_a),
            (self.fixture.pack_b_root, self.fixture.pack_b),
        ):
            manifest, tasks = REDACTED.load_pack(manifest_path)
            self.assertEqual(
                manifest["cross_reviewer_order_contract"],
                "independent_cryptographic_shuffle_private_authority_sealed",
            )
            public_ids.append(
                {str(task["public_precheck_task_id"]) for task in tasks}
            )
            public_surface_sequences.append(
                [
                    tuple(
                        (str(surface["file_sha256"]), str(surface["pixel_sha256"]))
                        for surface in task["source_surfaces"]
                    )
                    for task in tasks
                ]
            )
            private, _ = REDACTED.load_private_authority(manifest_path)
            private_source_sets.append(
                {str(row["sample_id"]) for row in private["task_bindings"]}
            )
            public_text = "\n".join(
                path.read_text(encoding="utf-8-sig")
                for path in (
                    root / "reviewer-pack" / "manifest.json",
                    root / "reviewer-pack" / "tasks.jsonl",
                    root / "reviewer-pack" / "response-template.jsonl",
                )
            )
            for forbidden in (
                '"sample_id"',
                '"work_id"',
                '"chapter_id"',
                '"page_id"',
                "proposed_role",
                "proposed_stratum",
                "ocr_hint",
                "work_title",
                "selection_priority",
            ):
                self.assertNotIn(forbidden, public_text)
            for task in tasks:
                for surface in task["source_surfaces"]:
                    self.assertFalse(Path(surface["path"]).is_absolute())
                    self.assertNotIn("fm_private", surface["path"])
        self.assertFalse(public_ids[0].intersection(public_ids[1]))
        self.assertNotEqual(public_surface_sequences[0], public_surface_sequences[1])
        self.assertEqual(private_source_sets[0], private_source_sets[1])

    def test_two_distinct_sealed_reviews_restore_private_sample_authority(self) -> None:
        summary_a, summary_b = self.fixture.seal_reviews()
        evidence, bindings, queue = INTAKE._load_prechecks(
            [summary_a, summary_b]
        )
        self.assertEqual(set(evidence), set(self.fixture.sample_ids))
        self.assertEqual(set(queue), set(self.fixture.sample_ids))
        self.assertEqual(len(bindings), 2)
        self.assertTrue(
            all(
                len(rows) == 2
                and len({row["reviewer_id"] for row in rows}) == 2
                for rows in evidence.values()
            )
        )

    def test_same_reviewer_or_same_summary_is_rejected(self) -> None:
        summary_a, _ = self.fixture.seal_reviews()
        with self.assertRaisesRegex(
            INTAKE.IntakeError, "duplicated|distinct reviewers"
        ):
            INTAKE._load_prechecks([summary_a, summary_a])

    def test_multiple_disjoint_batches_merge_without_rechecking_first_batch(self) -> None:
        first_a, first_b = self.fixture.seal_reviews()
        supplement = RedactedFixture(
            self.fixture.root / "supplement-fixture",
            sample_prefix="fm_supplement_private",
        )
        try:
            second_a, second_b = supplement.seal_reviews()
            evidence, bindings, queue = INTAKE._load_prechecks(
                [first_a, second_b, first_b, second_a]
            )
            expected = set(self.fixture.sample_ids) | set(supplement.sample_ids)
            self.assertEqual(set(evidence), expected)
            self.assertEqual(set(queue), expected)
            self.assertEqual(len(bindings), 4)
            self.assertTrue(
                all(
                    len(rows) == 2
                    and {row["reviewer_id"] for row in rows}
                    == {"reviewer-a", "reviewer-b"}
                    for rows in evidence.values()
                )
            )
        finally:
            supplement.close()

    def test_incomplete_additional_batch_is_rejected(self) -> None:
        first_a, first_b = self.fixture.seal_reviews()
        supplement = RedactedFixture(
            self.fixture.root / "partial-supplement-fixture",
            sample_prefix="fm_partial_supplement_private",
        )
        try:
            second_a, _ = supplement.seal_reviews()
            with self.assertRaisesRegex(
                INTAKE.IntakeError, "complete reviewer pairs|exactly two"
            ):
                INTAKE._load_prechecks([first_a, first_b, second_a])
        finally:
            supplement.close()

    def test_response_leak_field_is_rejected(self) -> None:
        response_path = self.fixture.response_path(
            self.fixture.pack_a, "leaky-responses.jsonl"
        )
        rows = REDACTED.read_jsonl(response_path)
        rows[0]["role"] = "dialogue"
        write_jsonl(response_path, rows)
        with self.assertRaisesRegex(REDACTED.RedactedPrecheckError, "forbidden fields"):
            REDACTED.seal_review(
                pack_manifest=self.fixture.pack_a,
                responses_path=response_path,
                reviewer_id="reviewer-a",
                output_root=self.fixture.root / "leaky-review",
            )

    def test_missing_response_is_rejected(self) -> None:
        response_path = self.fixture.response_path(
            self.fixture.pack_a, "partial-responses.jsonl"
        )
        rows = REDACTED.read_jsonl(response_path)
        write_jsonl(response_path, rows[:-1])
        with self.assertRaisesRegex(REDACTED.RedactedPrecheckError, "coverage"):
            REDACTED.seal_review(
                pack_manifest=self.fixture.pack_a,
                responses_path=response_path,
                reviewer_id="reviewer-a",
                output_root=self.fixture.root / "partial-review",
            )

    def test_tampered_pack_asset_is_rejected(self) -> None:
        _, tasks = REDACTED.load_pack(self.fixture.pack_a)
        asset = (
            self.fixture.pack_a.parent
            / str(tasks[0]["source_surfaces"][0]["path"])
        )
        asset.write_bytes(asset.read_bytes() + b"tamper")
        with self.assertRaisesRegex(REDACTED.RedactedPrecheckError, "surface bytes"):
            REDACTED.load_pack(self.fixture.pack_a)

    def test_tampered_private_mapping_is_rejected(self) -> None:
        private_path = self.fixture.pack_a_root / "private-authority.json"
        value = REDACTED.read_json(private_path)
        value["task_bindings"][0]["sample_id"] = "fm_other"
        write_json(private_path, value)
        with self.assertRaises(REDACTED.RedactedPrecheckError):
            REDACTED.load_private_authority(self.fixture.pack_a)

    def test_reviewer_cannot_submit_another_reviewers_pack(self) -> None:
        with self.assertRaisesRegex(REDACTED.RedactedPrecheckError, "does not own"):
            REDACTED.seal_review(
                pack_manifest=self.fixture.pack_a,
                responses_path=self.fixture.response_path(
                    self.fixture.pack_a, "wrong-reviewer.jsonl"
                ),
                reviewer_id="reviewer-b",
                output_root=self.fixture.root / "wrong-review",
            )


if __name__ == "__main__":
    unittest.main()
