from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_calibration_intake_v5.py"
SPEC = importlib.util.spec_from_file_location(
    "build_font_matching_calibration_intake_v5_tested", SCRIPT
)
assert SPEC and SPEC.loader
INTAKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INTAKE)


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class FakeAuthoritativeInputs:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.inputs_root = root / "inputs"
        self.inputs_root.mkdir()
        self.master_root = self.inputs_root / "master"
        self.rescue_root = self.inputs_root / "rescue"
        self.audit_root = self.inputs_root / "audit"
        self.library_root = self.inputs_root / "library"
        self.catalog_root = self.inputs_root / "base-catalog"
        for path in (
            self.master_root,
            self.rescue_root,
            self.audit_root,
            self.library_root,
            self.catalog_root,
        ):
            path.mkdir()
        self.master_manifest = self.master_root / "manifest.jsonl"
        self.master_report = self.master_root / "report.json"
        self.master_split_map = self.master_root / "split_map.json"
        self.catalog_registry = self.inputs_root / "catalog-registry.json"
        self.parent_manifest = self.inputs_root / "parent-master.jsonl"
        for path in (
            self.master_manifest,
            self.master_report,
            self.master_split_map,
            self.catalog_registry,
            self.parent_manifest,
        ):
            path.write_text("{}\n", encoding="utf-8")
        self.prior_paths: list[Path] = []
        for index in range(3):
            path = self.inputs_root / f"prior-{index + 1}.json"
            path.write_text(f'{{"round":{index + 1}}}\n', encoding="utf-8")
            self.prior_paths.append(path)

        self.master: dict[str, dict[str, object]] = {}
        self.master_hashes: dict[str, str] = {}
        self.parent_master: dict[str, dict[str, object]] = {}
        self.parent_hashes: dict[str, str] = {}
        self.assignments: dict[str, str] = {}
        self.strata: dict[str, str] = {}
        self.selection: dict[str, dict[str, object]] = {}

        for index in range(8):
            stratum = "sfx_ambient" if index < 5 else "sfx_comic"
            sample_id = f"existing-{index}"
            row = self._existing_row(sample_id, index)
            self.master[sample_id] = row
            self.master_hashes[sample_id] = INTAKE._record_hash(row)
            self.assignments[f"work-{index}"] = "train"
            self.strata[sample_id] = stratum
            self.selection[sample_id] = {
                "sample_id": sample_id,
                "work_id": f"work-{index}",
            }

        for index in range(2):
            sample_id = f"parent-{index}"
            row = self._parent_row(sample_id, index)
            self.master[sample_id] = row
            self.master_hashes[sample_id] = INTAKE._record_hash(row)
            self.parent_master[sample_id] = copy.deepcopy(row)
            self.parent_hashes[sample_id] = INTAKE._record_hash(row)
            self.assignments[f"recrop-work-{index}"] = "train"

        self.split_document = {
            "schema_version": 1,
            "algorithm": {
                "frozen_source": {"sha256": _sha("frozen-source")},
                "components": [{"id": "component-a", "sample_count": 10}],
            },
            "work_assignments": dict(self.assignments),
        }
        self.registry_document = {
            "catalogs": [
                {
                    "catalog_id": "basecat",
                    "source_kind": "hard",
                    "root": str(self.catalog_root),
                }
            ],
            "exclusion_ledgers": [],
            "parent_master": {
                "manifest": str(self.parent_manifest),
                "manifest_sha256": INTAKE.sha256_file(self.parent_manifest),
            },
            "frozen_split_map": {
                "path": str(self.master_split_map),
                "sha256": INTAKE.sha256_file(self.master_split_map),
            },
        }
        self.bindings = {
            "master_manifest": INTAKE._file_binding(self.master_manifest),
            "master_report": INTAKE._file_binding(self.master_report),
            "master_split_map": INTAKE._file_binding(self.master_split_map),
            "catalog_registry": INTAKE._file_binding(self.catalog_registry),
            "rescue_report_record_sha256": _sha("rescue-report"),
            "font_signal_audit_report_record_sha256": _sha("audit-report"),
            "prior_subset_bindings": [
                INTAKE._file_binding(path) for path in self.prior_paths
            ],
        }
        predecessor = None
        history_rounds = []
        for sequence, round_id in enumerate(INTAKE.EXPECTED_PRIOR_ROUND_IDS, 1):
            history_round = INTAKE.seal(
                {
                    "schema_version": INTAKE.SCHEMA_VERSION,
                    "record_type": "font_matching_prior_calibration_history_round",
                    "sequence": sequence,
                    "round_id": round_id,
                    "predecessor_record_sha256": predecessor,
                }
            )
            predecessor = history_round["record_sha256"]
            history_rounds.append(history_round)
        self.prior_history = INTAKE.seal(
            {
                "schema_version": INTAKE.SCHEMA_VERSION,
                "record_type": "font_matching_prior_calibration_history_registry",
                "required_round_ids": list(INTAKE.EXPECTED_PRIOR_ROUND_IDS),
                "round_count": 3,
                "rounds": history_rounds,
                "head_record_sha256": predecessor,
            }
        )
        self.value = {
            "source": {
                "master": {
                    sample_id: self.master[sample_id] for sample_id in self.selection
                },
                "selection": self.selection,
            },
            "prior": {"excluded_sample_ids": [], "bindings": []},
            "master": self.master,
            "master_hashes": self.master_hashes,
            "parent_master": self.parent_master,
            "parent_master_hashes": self.parent_hashes,
            "parent_master_path": self.parent_manifest,
            "assignments": self.assignments,
            "split_document": self.split_document,
            "work_assignments_sha256": INTAKE.sha256_bytes(
                INTAKE.canonical_json_bytes(self.assignments)
            ),
            "frozen_source_sha256": _sha("frozen-source"),
            "prior_conflict_keys": set(),
            "nontrain_conflict_keys": set(),
            "catalog_roots": {"basecat": self.catalog_root},
            "registry_document": self.registry_document,
            "registry_configuration": None,
            "stratum_by_sample": self.strata,
            "paths": {
                "master_root": self.master_root,
                "master_manifest": self.master_manifest,
                "master_report": self.master_report,
                "master_split_map": self.master_split_map,
                "catalog_registry": self.catalog_registry,
                "base_rescue_inputs": self.rescue_root,
                "font_signal_audit": self.audit_root,
                "library_root": self.library_root,
                "prior_calibration_subsets": self.prior_paths,
            },
            "bindings": self.bindings,
            "authority_successor_bridge": None,
            "prior_history": self.prior_history,
        }

    def _write_image(
        self, relative: str, color: tuple[int, int, int]
    ) -> dict[str, object]:
        path = self.catalog_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (224, 224), color).save(path)
        return {
            "status": "available",
            "catalog_id": "basecat",
            "path": relative,
            "file_sha256": INTAKE.sha256_file(path),
            "expected_size_px": [224, 224],
        }

    def _base_row(self, sample_id: str, index: int, work_id: str) -> dict[str, object]:
        page_sha = _sha(f"page-{sample_id}")
        return {
            "id": sample_id,
            "sample_crop_sha256": _sha(f"crop-{sample_id}"),
            "work": {"id": work_id, "title": f"Work {index}"},
            "chapter": {"id": f"chapter-{sample_id}", "title": "Chapter"},
            "page": {
                "id": f"page-{sample_id}",
                "name": f"{index:03d}.png",
                "source_page_sha256": page_sha,
            },
            "groups": {
                "root": f"root-{sample_id}",
                "variant": f"variant-{sample_id}",
                "normalized_glyph": f"glyph-white-sha256:{_sha(f'glyph-{sample_id}')}",
            },
            "provenance": {
                "source_catalog_id": "basecat",
                "source_id": f"source-{sample_id}",
                "source_line_number": index + 1,
                "source_line_sha256": _sha(f"source-line-{sample_id}"),
                "source_lineage": [{"id": f"lineage-{sample_id}"}],
                "synthetic": False,
                "qa_overlay": False,
            },
            "metadata": {"orientation": "horizontal"},
            "geometry": {"crop_bbox_px": [10, 10, 40, 40]},
        }

    def _existing_row(self, sample_id: str, index: int) -> dict[str, object]:
        row = self._base_row(sample_id, index, f"work-{index}")
        color = (30 + index * 10, 70 + index * 5, 120 + index * 3)
        row["views"] = {
            "raw_224": self._write_image(f"{sample_id}/raw.png", color),
            "context_224": self._write_image(
                f"{sample_id}/context.png",
                tuple(min(255, value + 20) for value in color),
            ),
            "glyph_224": self._write_image(
                f"{sample_id}/glyph.png", tuple(min(255, value + 40) for value in color)
            ),
        }
        return row

    def _parent_row(self, sample_id: str, index: int) -> dict[str, object]:
        relative = f"pages/{sample_id}.png"
        page_path = self.library_root / relative
        page_path.parent.mkdir(parents=True, exist_ok=True)
        if index == 1:
            image = Image.new("RGB", (600, 800), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            # Representative, separated text strokes inside the audited extents.
            draw.rectangle([259, 698, 311, 721], fill=(15, 15, 15))
            draw.rectangle([268, 732, 292, 751], fill=(15, 15, 15))
            draw.rectangle([315, 704, 340, 723], fill=(15, 15, 15))
            draw.rectangle([341, 716, 419, 729], fill=(15, 15, 15))
            draw.rectangle([430, 698, 492, 746], fill=(15, 15, 15))
            # Two distinct hair-art components intersect the exact seeds and
            # touch crop-bottom absolute y=759.  They do not touch the glyphs.
            draw.rectangle([330, 754, 350, 759], fill=(25, 25, 25))
            draw.rectangle([400, 755, 406, 759], fill=(25, 25, 25))
        else:
            image = Image.new("RGB", (128, 128), (245, 245, 245))
            for x in range(16, 96):
                for y in range(28, 72):
                    if (x + y) % 5 < 2:
                        image.putpixel((x, y), (20, 20, 20))
        image.save(page_path)
        row = self._base_row(sample_id, index + 20, f"recrop-work-{index}")
        page_sha = INTAKE.sha256_file(page_path)
        row["page"] = {
            "id": f"page-{sample_id}",
            "name": f"{sample_id}.png",
            "source_page_sha256": page_sha,
            "source_locator": {
                "path": relative,
                "file_sha256": page_sha,
                "size_px": [image.width, image.height],
                "storage_root": "library_root",
                "provenance": "real_preserved",
            },
        }
        return row

    def existing_proposals(self) -> list[dict[str, object]]:
        return [
            {
                "kind": "existing_master",
                "sample_id": f"existing-{index}",
                "expected_stratum": "sfx_ambient" if index < 5 else "sfx_comic",
            }
            for index in range(8)
        ]

    def recrop_proposals(self) -> list[dict[str, object]]:
        rows = self.existing_proposals()[:4] + self.existing_proposals()[5:7]
        rows.extend(
            [
                {
                    "kind": "manual_recrop",
                    "parent_sample_id": "parent-0",
                    "expected_stratum": "sfx_ambient",
                    "crop_bbox_px": [18, 24, 92, 78],
                    "context_bbox_px": [8, 12, 108, 94],
                    "mask": {
                        "coordinate_space": "source_page_pixels_xyxy",
                        "keep": [{"shape": "rect", "bbox_px": [20, 26, 90, 76]}],
                        "exclude": [
                            {
                                "shape": "polygon",
                                "points_px": [[20, 26], [30, 26], [25, 36]],
                            }
                        ],
                    },
                    "orientation": "horizontal",
                },
                {
                    "kind": "manual_recrop",
                    "parent_sample_id": "parent-1",
                    "expected_stratum": "sfx_comic",
                    "crop_bbox_px": [247, 684, 506, 760],
                    "context_bbox_px": [230, 670, 520, 780],
                    "mask": {
                        "coordinate_space": "source_page_pixels_xyxy",
                        "keep": [],
                        "exclude": [],
                        "exclude_components_touching_edges": [
                            {
                                "operation": "exclude_components_touching_edges",
                                "edges": ["bottom"],
                                "seed_regions": [
                                    {
                                        "shape": "rect",
                                        "bbox_px": [298, 749, 371, 760],
                                    },
                                    {
                                        "shape": "rect",
                                        "bbox_px": [370, 751, 472, 760],
                                    },
                                ],
                                "connectivity": 8,
                                "foreground_algorithm": "bt601_integer_luma_v1",
                                "foreground_luma_max": 96,
                                "alpha_policy": "convert_to_rgb_before_segmentation",
                                "antialias_policy": "inclusive_luma_threshold_no_dilation",
                            }
                        ],
                    },
                    "orientation": "vertical",
                },
            ]
        )
        return rows


class CalibrationIntakeV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fake = FakeAuthoritativeInputs(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_jsonl(self, path: Path, rows: list[dict[str, object]]) -> None:
        path.write_bytes(INTAKE.jsonl_bytes(rows))

    def _fresh_fixture(
        self, name: str = "valid"
    ) -> tuple[
        dict[str, object],
        Path,
        Path,
        Path,
        dict[str, object],
        dict[str, object],
    ]:
        work_id = f"fresh-work-{name}"
        chapter_id = f"fresh-chapter-{name}"
        page_id = f"fresh-page-{name}"
        work_root = self.fake.library_root / "works" / work_id
        chapter_root = work_root / "chapters" / chapter_id
        page_path = chapter_root / "pages" / f"001-{page_id}.png"
        page_path.parent.mkdir(parents=True)
        image = Image.new("RGB", (64, 48), (255, 255, 255))
        ImageDraw.Draw(image).rectangle([10, 10, 29, 29], fill=(20, 20, 20))
        image.save(page_path)

        work_document: dict[str, object] = {
            "id": work_id,
            "title": f"Fresh Work {name}",
        }
        chapter_document: dict[str, object] = {
            "id": chapter_id,
            "workId": work_id,
            "title": f"Fresh Chapter {name}",
            "pages": [
                {
                    "id": page_id,
                    "name": page_path.name,
                    "imagePath": str(page_path.resolve()),
                    "width": 64,
                    "height": 48,
                }
            ],
        }
        work_path = work_root / "work.json"
        chapter_path = chapter_root / "chapter.json"
        work_path.write_bytes(INTAKE.canonical_json_bytes(work_document, pretty=True))
        chapter_path.write_bytes(
            INTAKE.canonical_json_bytes(chapter_document, pretty=True)
        )
        self.fake.value["assignments"][work_id] = "train"
        proposal: dict[str, object] = {
            "kind": "manual_fresh_page_crop",
            "work_id": work_id,
            "chapter_id": chapter_id,
            "page_id": page_id,
            "source_page_relative_path": page_path.relative_to(
                self.fake.library_root
            ).as_posix(),
            "source_page_sha256": INTAKE.sha256_file(page_path),
            "expected_stratum": "ordinary_body",
            "crop_bbox_px": [10, 10, 30, 30],
            "context_bbox_px": [5, 5, 40, 40],
            "mask": {
                "coordinate_space": "source_page_pixels_xyxy",
                "keep": [],
                "exclude": [],
                "exclude_components_touching_edges": [],
            },
            "orientation": "horizontal",
        }
        return (
            proposal,
            page_path,
            work_path,
            chapter_path,
            work_document,
            chapter_document,
        )

    def _prepare_fresh(
        self, proposal: dict[str, object], name: str
    ) -> dict[str, object]:
        return INTAKE._prepare_fresh_page_crop(
            self.fake.value,
            proposal,
            index=0,
            prepared_root=self.root / f"prepared-{name}",
            catalog_id="fresh-test",
            materialize=True,
            expected_strata={"ordinary_body": 1},
        )

    def _init(self, proposals: list[dict[str, object]], name: str = "intake") -> Path:
        proposal_path = self.root / f"{name}-proposals.jsonl"
        self._write_jsonl(proposal_path, proposals)
        workspace = self.root / name
        INTAKE.initialize_workspace(
            workspace=workspace,
            master_root=self.fake.master_root,
            catalog_registry=self.fake.catalog_registry,
            master_split_map=self.fake.master_split_map,
            base_rescue_inputs=self.fake.rescue_root,
            font_signal_audit=self.fake.audit_root,
            prior_calibration_subsets=self.fake.prior_paths,
            library_root=self.fake.library_root,
            proposals=proposal_path,
            round_id=f"round-{name}",
            selection_seed="seed-v5",
        )
        return workspace

    def _decisions(self, workspace: Path, stage: str) -> Path:
        private = INTAKE.read_jsonl(workspace / INTAKE.PRIVATE_FILE)
        rows = [
            {
                "task_id": row["task_ids"][stage],
                "checks": {check: True for check in INTAKE.CHECK_IDS},
                "role": row["expected_stratum"],
                "stratum": row["expected_stratum"],
                "notes": None,
            }
            for row in private
        ]
        path = self.root / f"{workspace.name}-{stage}-decisions.jsonl"
        self._write_jsonl(path, rows)
        return path

    def _review_and_seal(self, workspace: Path) -> dict[str, object]:
        for stage, reviewer in (("reviewer-a", "alice"), ("reviewer-b", "bob")):
            INTAKE.submit_review(
                workspace=workspace,
                reviewer_stage=stage,
                reviewer_id=reviewer,
                decisions=self._decisions(workspace, stage),
            )
        INTAKE.seal_source(workspace=workspace)
        return INTAKE.validate_sealed_intake(workspace)

    def test_existing_source_only_round_is_write_once_and_has_no_font_identity(
        self,
    ) -> None:
        with mock.patch.object(
            INTAKE, "_load_authoritative_inputs", return_value=self.fake.value
        ):
            workspace = self._init(self.fake.existing_proposals())
            for stage in INTAKE.REVIEWER_STAGES:
                tasks = INTAKE.read_jsonl(workspace / "tasks" / f"{stage}.jsonl")
                self.assertEqual(len(tasks), 8)
                serialized = json.dumps(tasks).casefold()
                self.assertNotIn('"sample_id":', serialized)
                self.assertNotIn("font_name", serialized)
                self.assertNotIn("candidate_only", serialized)
            decisions = self._decisions(workspace, "reviewer-a")
            INTAKE.submit_review(
                workspace=workspace,
                reviewer_stage="reviewer-a",
                reviewer_id="alice",
                decisions=decisions,
            )
            with self.assertRaisesRegex(INTAKE.IntakeError, "append-only"):
                INTAKE.submit_review(
                    workspace=workspace,
                    reviewer_stage="reviewer-a",
                    reviewer_id="charlie",
                    decisions=decisions,
                )
            with self.assertRaisesRegex(INTAKE.IntakeError, "must be different"):
                INTAKE.submit_review(
                    workspace=workspace,
                    reviewer_stage="reviewer-b",
                    reviewer_id="alice",
                    decisions=self._decisions(workspace, "reviewer-b"),
                )
            INTAKE.submit_review(
                workspace=workspace,
                reviewer_stage="reviewer-b",
                reviewer_id="bob",
                decisions=self._decisions(workspace, "reviewer-b"),
            )
            INTAKE.seal_source(workspace=workspace)
            verified = INTAKE.validate_sealed_intake(workspace)
            self.assertEqual(len(verified["rows"]), 8)
            self.assertEqual(
                Counter(row["stratum"] for row in verified["rows"]),
                Counter({"sfx_ambient": 5, "sfx_comic": 3}),
            )
            self.assertEqual(verified["report"]["candidate_b_count"], 0)
            self.assertEqual(verified["report"]["font_identity_count"], 0)

    def test_two_manual_recrops_materialize_bind_masks_and_exclude_parents(
        self,
    ) -> None:
        with mock.patch.object(
            INTAKE, "_load_authoritative_inputs", return_value=self.fake.value
        ):
            workspace = self._init(self.fake.recrop_proposals(), "recrops")
            verified = self._review_and_seal(workspace)
            self.assertEqual(verified["report"]["manual_recrop_count"], 2)
            exclusions = INTAKE.read_jsonl(
                workspace / "sealed" / "catalog" / "parent-exclusions.jsonl"
            )
            self.assertEqual(
                {row["parent_master_id"] for row in exclusions},
                {"parent-0", "parent-1"},
            )
            recrops = [
                row for row in verified["rows"] if row["kind"] == "manual_recrop"
            ]
            self.assertEqual(len(recrops), 2)
            self.assertTrue(all(row["parent_sample_id"] for row in recrops))
            self.assertTrue(
                all(row["mask_contract"]["mask_contract_sha256"] for row in recrops)
            )
            comic = next(row for row in recrops if row["stratum"] == "sfx_comic")
            operation = comic["mask_execution"]["operation_results"][0]
            self.assertEqual(2, operation["selected_component_count"])
            self.assertEqual(161, operation["excluded_pixel_count"])
            self.assertEqual([True, True], operation["seed_regions_hit"])
            glyph_path = (
                workspace
                / "sealed"
                / "catalog"
                / comic["source_views"]["glyph_native"]["path"]
            )
            with Image.open(glyph_path) as glyph:
                # Hair at absolute (340,759) is white; lower ゴ at
                # absolute (280,740) remains dark.
                self.assertEqual(
                    (255, 255, 255), glyph.getpixel((340 - 247, 759 - 684))
                )
                self.assertEqual((15, 15, 15), glyph.getpixel((280 - 247, 740 - 684)))
            for relative in verified["report"]["managed_files"]:
                self.assertNotIn("candidate", relative.casefold())

    def test_source_seal_blocks_one_failed_check_or_role_disagreement(self) -> None:
        with mock.patch.object(
            INTAKE, "_load_authoritative_inputs", return_value=self.fake.value
        ):
            workspace = self._init(self.fake.existing_proposals(), "disagree")
            a_path = self._decisions(workspace, "reviewer-a")
            b_path = self._decisions(workspace, "reviewer-b")
            b_rows = INTAKE.read_jsonl(b_path)
            b_rows[0]["checks"]["single_skeleton"] = False
            self._write_jsonl(b_path, b_rows)
            INTAKE.submit_review(
                workspace=workspace,
                reviewer_stage="reviewer-a",
                reviewer_id="alice",
                decisions=a_path,
            )
            INTAKE.submit_review(
                workspace=workspace,
                reviewer_stage="reviewer-b",
                reviewer_id="bob",
                decisions=b_path,
            )
            with self.assertRaisesRegex(INTAKE.IntakeError, "blocked"):
                INTAKE.seal_source(workspace=workspace)

    def test_split_identity_ignores_component_sample_counts_only(self) -> None:
        base = copy.deepcopy(self.fake.split_document)
        successor = copy.deepcopy(base)
        successor["algorithm"]["components"][0]["sample_count"] = 12
        self.assertEqual(
            INTAKE.validate_successor_split_identity(
                base, successor, intake_work_ids=["work-0", "recrop-work-0"]
            ),
            INTAKE.split_identity(base),
        )
        successor["work_assignments"]["work-0"] = "val"
        with self.assertRaisesRegex(INTAKE.IntakeError, "changed"):
            INTAKE.validate_successor_split_identity(
                base, successor, intake_work_ids=["work-0"]
            )

    def test_successor_bridge_master_delta_accepts_exact_chain_and_rejects_common_row_tamper(
        self,
    ) -> None:
        common = {
            "id": "common",
            "work": {"id": "work-a"},
            "geometry": {"crop_bbox_px": [1, 2, 3, 4]},
            "groups": {"root": "root-common", "split_component": "component-a"},
            "split": "train",
            "work_balance_weight": 0.5,
        }
        parent = {
            "id": "parent",
            "work": {"id": "work-a"},
            "groups": {"root": "root-parent"},
            "split": "train",
        }
        catalog_successor = {
            "id": "successor",
            "work": {"id": "work-a"},
            "geometry": {"crop_bbox_px": [5, 6, 7, 8]},
            "groups": {"root": "root-successor", "split_component": None},
            "split": None,
            "work_balance_weight": 1.0,
        }
        current_successor = copy.deepcopy(catalog_successor)
        current_successor["groups"]["split_component"] = "component-a"
        current_successor["split"] = "train"
        base = {"common": common, "parent": parent}
        current = {
            "common": {**copy.deepcopy(common), "work_balance_weight": 0.25},
            "successor": current_successor,
        }
        kwargs = {
            "base_master": base,
            "current_master": current,
            "excluded_parent_ids": ["parent"],
            "successor_ids": ["successor"],
            "expected_successors": {"successor": catalog_successor},
            "successor_split_document": {"work_assignments": {"work-a": "train"}},
        }
        INTAKE.validate_successor_master_delta(**kwargs)
        current["common"]["geometry"]["crop_bbox_px"] = [9, 9, 9, 9]
        with self.assertRaisesRegex(INTAKE.IntakeError, "changed common row"):
            INTAKE.validate_successor_master_delta(**kwargs)

    def test_successor_bridge_registry_contract_rejects_tamper(self) -> None:
        catalog_root = self.root / "registry-catalog"
        catalog_root.mkdir()
        ledger = self.root / "registry-exclusions.jsonl"
        parent = self.root / "registry-parent.jsonl"
        frozen = self.root / "registry-split.json"
        for path, payload in (
            (ledger, b"ledger\n"),
            (parent, b"parent\n"),
            (frozen, b"split\n"),
        ):
            path.write_bytes(payload)
        catalog_sha = _sha("catalog")
        expected = {
            "catalogs": [
                {
                    "catalog_id": "catalog-a",
                    "source_kind": "hard",
                    "root": str(catalog_root),
                    "manifest_sha256": catalog_sha,
                }
            ],
            "exclusion_ledgers": [
                {"path": str(ledger), "sha256": INTAKE.sha256_file(ledger)}
            ],
            "parent_master_manifest": str(parent),
            "parent_master_manifest_sha256": INTAKE.sha256_file(parent),
            "frozen_split_map": str(frozen),
            "frozen_split_map_sha256": INTAKE.sha256_file(frozen),
        }
        current = {
            "catalogs": copy.deepcopy(expected["catalogs"]),
            "exclusion_ledgers": copy.deepcopy(expected["exclusion_ledgers"]),
            "parent_master": {
                "manifest": str(parent),
                "manifest_sha256": INTAKE.sha256_file(parent),
            },
            "frozen_split_map": {
                "path": str(frozen),
                "sha256": INTAKE.sha256_file(frozen),
            },
        }
        INTAKE.validate_registry_successor_contract(expected, current)
        current["catalogs"][0]["manifest_sha256"] = _sha("tampered")
        with self.assertRaisesRegex(INTAKE.IntakeError, "successor registry differs"):
            INTAKE.validate_registry_successor_contract(expected, current)

    @unittest.skipUnless(
        (ROOT / "datasets" / "font-matching-font-signal-recrop-promotion-v1").is_dir()
        and (ROOT / "datasets" / "font-matching-master-v3").is_dir(),
        "production authority chain is not present",
    )
    def test_successor_bridge_validates_production_v2_to_v3_chain(self) -> None:
        promotion_root = (
            ROOT / "datasets" / "font-matching-font-signal-recrop-promotion-v1"
        )
        promotion_rows = INTAKE.read_jsonl(promotion_root / "manifest.jsonl")
        self.assertTrue(promotion_rows)
        sealed_runtimes: set[bytes] = set()
        for row in promotion_rows:
            normalization = row["glyph_normalization"]
            self.assertEqual(
                INTAKE.promotion.GLYPH_NORMALIZATION_CONTRACT_SHA256,
                normalization["contract_sha256"],
            )
            sealed_runtimes.add(
                INTAKE.canonical_json_bytes(normalization["transform"]["runtime"])
            )
            glyph = row["assets"]["glyph_224"]
            glyph_path = promotion_root / glyph["path"]
            self.assertTrue(glyph_path.is_file())
            self.assertEqual(glyph["file_sha256"], INTAKE.sha256_file(glyph_path))
        self.assertEqual(1, len(sealed_runtimes))
        sealed_runtime = json.loads(next(iter(sealed_runtimes)))
        current_runtime = INTAKE.promotion._normalization_runtime()
        if sealed_runtime != current_runtime:
            self.skipTest(
                "production promotion is sealed to a different deterministic "
                f"glyph runtime: sealed={sealed_runtime}, current={current_runtime}"
            )
        bridge = INTAKE.validate_authority_successor_bridge(
            promotion_root,
            base_master_manifest_sha256=(
                "f76ba7b25964a972c46a7350d9e7022e9c5e309136ec8ef96adf1bb77d78f036"
            ),
            base_master_split_map_sha256=(
                "e19f116e10fbe2171c997b537dc6245042df972f34f9ae8adec6fa2d90f91f5e"
            ),
            base_catalog_registry_sha256=(
                "bc1c179729682f3b88563a484835e5fdae94a11c0119686b7a31b28357c0bc05"
            ),
            base_catalog_registry_record_sha256=(
                "15e1a066d278ba0618ce8af7416f92c3cc59b87d63b4de3760210f8ed15ec660"
            ),
            successor_master_root=ROOT / "datasets" / "font-matching-master-v3",
            successor_catalog_registry=(
                ROOT / "datasets" / "font-matching-catalog-registry-v3.json"
            ),
            successor_split_map=(
                ROOT / "datasets" / "font-matching-master-v3" / "split_map.json"
            ),
        )
        self.assertEqual(20, bridge["excluded_parent_count"])
        self.assertEqual(18, bridge["successor_count"])
        self.assertFalse(bridge["source_pool_policy"]["successors_auto_inherited"])

    def test_prior_history_requires_exact_ordered_v1_v2_v3_chain(self) -> None:
        paths = []
        source_master = {}
        assignments = {}
        for index, round_id in enumerate(INTAKE.EXPECTED_PRIOR_ROUND_IDS):
            sample_id = f"prior-sample-{index}"
            work_id = f"prior-work-{index}"
            source_master[sample_id] = {"work": {"id": work_id}}
            assignments[work_id] = "train"
            document = INTAKE.seal(
                {
                    "schema_version": "fixture",
                    "record_type": "font_catalog_delta_calibration_subset",
                    "round_id": round_id,
                    "sample_ids": [sample_id],
                    "training_quarantine_sample_ids": [sample_id],
                }
            )
            path = self.root / f"history-{index}.json"
            path.write_bytes(INTAKE.canonical_json_bytes(document, pretty=True))
            paths.append(path)
        identity = {
            "frozen_source_sha256": _sha("history-frozen"),
            "work_assignments_sha256": INTAKE.sha256_bytes(
                INTAKE.canonical_json_bytes(assignments)
            ),
        }
        with mock.patch.object(
            INTAKE.delta,
            "_calibration_leakage_closure",
            side_effect=lambda _source, selected: set(selected),
        ):
            history = INTAKE._build_prior_calibration_history(
                paths=paths,
                source={"master": source_master},
                authoritative_master=source_master,
                assignments=assignments,
                authoritative_split_identity=identity,
            )
            self.assertEqual(
                history["head_record_sha256"],
                history["rounds"][-1]["record_sha256"],
            )
            self.assertEqual(
                history["rounds"][1]["predecessor_record_sha256"],
                history["rounds"][0]["record_sha256"],
            )
            with self.assertRaisesRegex(INTAKE.IntakeError, "reordered"):
                INTAKE._build_prior_calibration_history(
                    paths=[paths[1], paths[0], paths[2]],
                    source={"master": source_master},
                    authoritative_master=source_master,
                    assignments=assignments,
                    authoritative_split_identity=identity,
                )
            with self.assertRaisesRegex(INTAKE.IntakeError, "exact v1-v3"):
                INTAKE._build_prior_calibration_history(
                    paths=paths[:2],
                    source={"master": source_master},
                    authoritative_master=source_master,
                    assignments=assignments,
                    authoritative_split_identity=identity,
                )

    def test_fresh_page_crop_binds_real_authority_without_parent(self) -> None:
        proposal, page_path, work_path, chapter_path, _, _ = self._fresh_fixture()
        item = self._prepare_fresh(proposal, "valid")

        self.assertEqual("manual_fresh_page_crop", item["kind"])
        self.assertIsNone(item["parent_sample_id"])
        self.assertIsNone(item["parent_exclusion"])
        authority = item["fresh_page_source_authority"]
        self.assertEqual(INTAKE.sha256_file(page_path), authority["source_page_sha256"])
        self.assertEqual(INTAKE.sha256_file(work_path), authority["work_json"]["sha256"])
        self.assertEqual(
            INTAKE.sha256_file(chapter_path), authority["chapter_json"]["sha256"]
        )
        self.assertNotIn("parent_master_link", item["catalog_row"])
        for descriptor in item["source_views"].values():
            asset = Path(descriptor["prepared_root"]) / descriptor["path"]
            self.assertTrue(asset.is_file())
            self.assertEqual(descriptor["file_sha256"], INTAKE.sha256_file(asset))
        self.assertEqual(
            item["source_views"]["raw_224"]["pixel_sha256"],
            item["source_views"]["glyph_224"]["pixel_sha256"],
        )

    def test_fresh_page_crop_rejects_wrong_split_path_sha_and_dimensions(self) -> None:
        proposal, _, _, _, _, _ = self._fresh_fixture("wrong-split")
        self.fake.value["assignments"][proposal["work_id"]] = "val"
        with self.assertRaisesRegex(INTAKE.IntakeError, "not canonical train"):
            self._prepare_fresh(proposal, "wrong-split")

        proposal, _, _, _, _, _ = self._fresh_fixture("wrong-path")
        proposal["source_page_relative_path"] = proposal[
            "source_page_relative_path"
        ].replace(str(proposal["chapter_id"]), "different-chapter")
        with self.assertRaisesRegex(INTAKE.IntakeError, "does not bind"):
            self._prepare_fresh(proposal, "wrong-path")

        proposal, _, _, _, _, _ = self._fresh_fixture("wrong-sha")
        proposal["source_page_sha256"] = _sha("wrong-source-page")
        with self.assertRaisesRegex(INTAKE.IntakeError, "image bytes changed"):
            self._prepare_fresh(proposal, "wrong-sha")

        proposal, _, _, chapter_path, _, chapter = self._fresh_fixture("wrong-dims")
        chapter["pages"][0]["width"] = 63
        chapter_path.write_bytes(INTAKE.canonical_json_bytes(chapter, pretty=True))
        with self.assertRaisesRegex(INTAKE.IntakeError, "dimensions differ"):
            self._prepare_fresh(proposal, "wrong-dims")

    def test_fresh_page_crop_rejects_prior_page_closure(self) -> None:
        proposal, _, _, _, _, _ = self._fresh_fixture("prior-page")
        self.fake.value["prior_conflict_keys"].add(
            "page.source_page_sha256\0" + str(proposal["source_page_sha256"])
        )
        proposal_path = self.root / "fresh-prior-proposal.jsonl"
        self._write_jsonl(proposal_path, [proposal])
        with self.assertRaisesRegex(
            INTAKE.IntakeError, "intersects prior calibration closure"
        ):
            INTAKE._prepare_proposals(
                self.fake.value,
                proposal_path=proposal_path,
                prepared_root=self.root / "prepared-prior-page",
                catalog_id="fresh-test",
                materialize=True,
                expected_strata={"ordinary_body": 1},
            )

    def test_fresh_page_crop_rejects_duplicate_chapter_page(self) -> None:
        proposal, _, _, chapter_path, _, chapter = self._fresh_fixture(
            "duplicate-page"
        )
        chapter["pages"].append(copy.deepcopy(chapter["pages"][0]))
        chapter_path.write_bytes(INTAKE.canonical_json_bytes(chapter, pretty=True))
        with self.assertRaisesRegex(INTAKE.IntakeError, "absent/duplicated"):
            self._prepare_fresh(proposal, "duplicate-page")

    def test_fresh_page_crop_rejects_tampered_work_and_chapter_authority(self) -> None:
        proposal, _, work_path, _, work, _ = self._fresh_fixture("tampered-work")
        work["id"] = "different-work"
        work_path.write_bytes(INTAKE.canonical_json_bytes(work, pretty=True))
        with self.assertRaisesRegex(INTAKE.IntakeError, "identity changed"):
            self._prepare_fresh(proposal, "tampered-work")

        proposal, _, _, chapter_path, _, chapter = self._fresh_fixture(
            "tampered-chapter"
        )
        chapter["workId"] = "different-work"
        chapter_path.write_bytes(INTAKE.canonical_json_bytes(chapter, pretty=True))
        with self.assertRaisesRegex(INTAKE.IntakeError, "identity changed"):
            self._prepare_fresh(proposal, "tampered-chapter")

    def test_fresh_page_crop_rejects_out_of_bounds_bbox_and_mask(self) -> None:
        proposal, _, _, _, _, _ = self._fresh_fixture("bad-bbox")
        proposal["crop_bbox_px"] = [10, 10, 65, 30]
        with self.assertRaisesRegex(INTAKE.IntakeError, "bbox escapes"):
            self._prepare_fresh(proposal, "bad-bbox")

        proposal, _, _, _, _, _ = self._fresh_fixture("bad-mask")
        proposal["mask"]["exclude"] = [
            {"shape": "rect", "bbox_px": [9, 9, 15, 15]}
        ]
        with self.assertRaisesRegex(INTAKE.IntakeError, "inside crop bbox"):
            self._prepare_fresh(proposal, "bad-mask")


if __name__ == "__main__":
    unittest.main()
