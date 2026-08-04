from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_review_cards.py"
SPEC = importlib.util.spec_from_file_location(
    "build_font_matching_review_cards", SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load review-card builder: {SCRIPT}")
CARDS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CARDS
SPEC.loader.exec_module(CARDS)


FONT_IDS = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
)
FIXTURE_UNRENDERABLE_FONT_ID = FONT_IDS[0]
PROBE_SPECS = {
    "aside-whisper": ("저기, 잠깐만.", 36, 0.04),
    "dialogue-body": ("지금 가는 거야?", 44, 0.0),
    "emphasis-shout": ("포기 안 해!", 52, 0.02),
    "narration": ("그날 밤의 기록.", 40, 0.02),
    "sfx-ambient": ("스산...", 48, 0.08),
    "sfx-comic-reaction": ("삐질...", 54, 0.0),
    "sfx-emotion": ("두근 두근", 48, 0.03),
    "sfx-impact": ("쾅!!", 64, -0.03),
    "sfx-motion": ("휘익-", 58, 0.04),
    "thought-monologue": ("설마, 기다릴까?", 42, 0.01),
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stable_hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def write_image(
    path: Path,
    size: tuple[int, int],
    color: tuple[int, int, int],
    *,
    mark: str = "",
) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(image)
    draw.rectangle(
        (size[0] // 4, size[1] // 3, size[0] * 3 // 4, size[1] * 2 // 3),
        outline=(10, 15, 20),
        width=5,
    )
    if mark:
        draw.text((12, 12), mark, fill=(10, 15, 20))
    image.save(path, format="PNG", optimize=False)
    return sha(path)


class Fixture:
    def __init__(self, root: Path, *, include_delta: bool = False) -> None:
        self.root = root
        self.master_dir = root / "master-input"
        self.inventory_dir = root / "inventory-input"
        self.assignment_dir = root / "assignment-input"
        self.bank = root / "render-bank-input"
        self.base = root / "base-catalog"
        self.hard = root / "hard-catalog"
        self.delta = root / "delta-hard-catalog"
        self.library = root / "library-input"
        self.output = root / "review-cards-output"
        self.reveal = root / "reveal-output"
        self.master = self.master_dir / "manifest.jsonl"
        self.inventory = self.inventory_dir / "inventory.jsonl"
        self.assignments = self.assignment_dir / "assignments.jsonl"
        self.bank_manifest = self.bank / "manifest.json"
        self.work_references = root / "work-reference-input" / "manifest.json"
        self.catalog_registry = root / "catalog-registry-input" / "registry.json"
        self.frozen_split_map = self.catalog_registry.parent / "frozen-split-map.json"
        self.source_seal = root / "source-seal-input" / "manifest.json"
        self.master_rows: list[dict] = []
        self.page_hashes: dict[str, str] = {}
        self.include_delta = include_delta
        self._build_sources()
        self._build_bank()
        self._write_master_inventory_assignments()

    def write_work_reference_manifest(self) -> Path:
        targets = []
        for sample in self.master_rows:
            references = []
            for index in range(3):
                source = self.master_rows[(index + 1) % len(self.master_rows)]
                references.append(
                    {
                        "blind_alias": f"same-work-dialogue-{index + 1:02d}",
                        "source_sample_id": f"reference-source-{sample['id']}-{index}",
                        "source_final_sha256": stable_hash(
                            "final", sample["id"], str(index)
                        ),
                        "role": "dialogue",
                        "role_confidence": 0.95,
                        "resolution_confidence": 0.9,
                        "orientation": sample["metadata"]["orientation"],
                        "chapter_id": f"reference-chapter-{index}",
                        "page_id": f"reference-page-{index}",
                        "sample_crop_sha256": stable_hash(
                            "crop", sample["id"], str(index)
                        ),
                        "source_catalog_id": source["provenance"]["source_catalog_id"],
                        "views": source["views"],
                    }
                )
            core = {
                "schema_version": "font-matching-work-references-v1",
                "record_type": "font_matching_work_reference_target",
                "target_sample_id": sample["id"],
                "target_work_id": sample["work"]["id"],
                "target_orientation": sample["metadata"]["orientation"],
                "references": references,
            }
            targets.append({**core, "record_sha256": CARDS.sha256_json(core)})
        manifest_core = {
            "schema_version": "font-matching-work-references-v1",
            "record_type": "font_matching_work_reference_manifest",
            "seed": "fixture",
            "references_per_target": 3,
            "input_hashes": {},
            "targets": targets,
            "safety": {
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "work_titles_visible": False,
                "qa_overlay": True,
                "training_asset": False,
                "images_copied_or_modified": 0,
            },
        }
        write_json(
            self.work_references,
            {
                **manifest_core,
                "record_sha256": CARDS.sha256_json(manifest_core),
            },
        )
        return self.work_references

    def write_catalog_registry(self) -> Path:
        catalogs = [
            ("fontclip-accepted-v1", "base", self.base),
            ("fontclip-hard-accepted-v2", "hard", self.hard),
        ]
        if self.include_delta:
            catalogs.append(("fontclip-recrop-accepted-v1", "hard", self.delta))
        registry_catalogs = []
        for catalog_id, source_kind, catalog_root in catalogs:
            source = next(
                row
                for row in self.master_rows
                if row["provenance"]["source_catalog_id"] == catalog_id
            )
            manifest = catalog_root / "manifest.jsonl"
            write_jsonl(manifest, [{"id": source["id"]}])
            registry_catalogs.append(
                {
                    "catalog_id": catalog_id,
                    "source_kind": source_kind,
                    "root": str(catalog_root),
                    "manifest_name": manifest.name,
                    "manifest_sha256": sha(manifest),
                    "expected_physical_rows": 1,
                    "expected_included_rows": 1,
                }
            )
        write_json(
            self.frozen_split_map,
            {
                "schema_version": 1,
                "work_assignments": {
                    row["work"]["id"]: row["split"] for row in self.master_rows
                },
            },
        )
        core = {
            "schema_version": "font-matching-catalog-registry-v1",
            "record_type": "font_matching_catalog_registry",
            "catalogs": registry_catalogs,
            "exclusion_ledgers": [],
            "frozen_split_map": {
                "path": str(self.frozen_split_map),
                "sha256": sha(self.frozen_split_map),
            },
        }
        write_json(
            self.catalog_registry,
            {**core, "record_sha256": CARDS.sha256_json(core)},
        )
        return self.catalog_registry

    def write_v4_source_seal(self) -> Path:
        roles = ("sfx_motion", "other", "sign_ui_title", "aside_balloon_edge")
        rows = []
        for index, sample in enumerate(
            sorted(self.master_rows, key=lambda row: row["id"])
        ):
            core = {
                "prior_final_record_sha256": stable_hash("prior-final", sample["id"]),
                "sample_id": sample["id"],
                "sealed_role": roles[index % len(roles)],
                "treatment": {
                    "distortion": False,
                    "inverse": index % 2 == 1,
                    "outline": True,
                    "shadow": index % 2 == 0,
                    "texture": False,
                },
            }
            rows.append({**core, "record_sha256": CARDS.sha256_json(core)})
        core = {
            "development_only": True,
            "inputs": {
                "inventory_sha256": sha(self.inventory),
                "master_manifest_sha256": sha(self.master),
                "rubric_sha256": stable_hash("v4-rubric"),
            },
            "record_type": CARDS.V4_SOURCE_SEAL_RECORD_TYPE,
            "samples": rows,
            "schema_version": CARDS.V4_SOURCE_SEAL_SCHEMA_VERSION,
        }
        write_json(
            self.source_seal,
            {**core, "record_sha256": CARDS.sha256_json(core)},
        )
        return self.source_seal

    def use_seven_candidate_subset(self) -> tuple[str, ...]:
        subset = (FONT_IDS[0], *FONT_IDS[-(CARDS.V4_CANDIDATE_COUNT - 1) :])
        assignments = [
            json.loads(line)
            for line in self.assignments.read_text(encoding="utf-8").splitlines()
        ]
        for assignment in assignments:
            assignment["candidate_order"] = CARDS.expected_candidate_order(
                subset, assignment["candidate_order_seed"]
            )
            assignment["assignment_id"] = CARDS.expected_assignment_id(assignment)
        write_jsonl(self.assignments, assignments)
        return subset

    def _build_sources(self) -> None:
        specs = [
            (
                "sample-base",
                "work-base",
                "horizontal",
                "fontclip-accepted-v1",
                self.base,
            ),
            (
                "sample-hard",
                "work-hard",
                "vertical",
                "fontclip-hard-accepted-v2",
                self.hard,
            ),
        ]
        if self.include_delta:
            specs.append(
                (
                    "sample-delta",
                    "work-delta",
                    "horizontal",
                    "fontclip-recrop-accepted-v1",
                    self.delta,
                )
            )
        for serial, (
            sample_id,
            work_id,
            orientation,
            catalog_id,
            catalog_root,
        ) in enumerate(specs):
            page_relative = f"works/{work_id}/pages/page-{serial}.png"
            page_path = self.library / Path(*Path(page_relative).parts)
            page_sha = write_image(
                page_path,
                (600, 900),
                (218 - serial * 20, 222, 226),
                mark=f"PAGE {serial}",
            )
            self.page_hashes[sample_id] = page_sha
            views: dict[str, dict] = {}
            for view_index, view_name in enumerate(
                ("raw_224", "context_224", "glyph_224")
            ):
                if catalog_id != "fontclip-accepted-v1" and view_name == "raw_224":
                    native_relative = f"images/raw/{sample_id}.png"
                    native_path = catalog_root / Path(*Path(native_relative).parts)
                    native_sha = write_image(
                        native_path, (180, 96), (170, 175, 180), mark="RAW"
                    )
                    views[view_name] = {
                        "catalog_id": catalog_id,
                        "expected_size_px": [224, 224],
                        "file_sha256": None,
                        "materialization_recipe": {
                            "algorithm": "fontclip-letterbox-rgb-v1",
                            "canvas_color_rgb": [255, 255, 255],
                            "convert_mode": "RGB",
                            "operation": "aspect_preserving_letterbox",
                            "placement": "center_floor",
                            "resize_filter": "lanczos",
                            "rounding": "python_round_then_minimum_1px",
                            "target_size_px": [224, 224],
                        },
                        "path": None,
                        "reason": "raw_224_not_materialized_in_source_catalog",
                        "source_native": {
                            "catalog_id": catalog_id,
                            "file_sha256": native_sha,
                            "hash_scope": "file_bytes",
                            "path": native_relative,
                            "provenance": "real_preserved",
                            "status": "available",
                        },
                        "status": "derivable",
                    }
                    continue
                relative = f"images/{view_name}/{sample_id}.png"
                path = catalog_root / Path(*Path(relative).parts)
                file_sha = write_image(
                    path,
                    (224, 224),
                    (
                        245 - view_index * 60,
                        245 - view_index * 55,
                        245 - view_index * 50,
                    ),
                    mark=view_name[:3].upper(),
                )
                views[view_name] = {
                    "catalog_id": catalog_id,
                    "expected_size_px": [224, 224],
                    "file_sha256": file_sha,
                    "hash_scope": "file_bytes",
                    "path": relative,
                    "reason": None,
                    "status": "available",
                }
            self.master_rows.append(
                {
                    "catalog_version": 1,
                    "chapter": {"id": f"chapter-{serial}", "title": None},
                    "font_label": None,
                    "geometry": {
                        "bbox_px": [210, 330, 390, 510],
                        "crop_bbox_px": [190, 310, 410, 530],
                        "final_bbox_px": [205, 325, 395, 515],
                        "mask_tight_bbox_px": [220, 340, 380, 500],
                        "page_size_px": [600, 900],
                    },
                    "groups": {},
                    "id": sample_id,
                    "label_status": "unlabeled",
                    "metadata": {"orientation": orientation},
                    "page": {
                        "id": f"page-{serial}",
                        "name": f"page-{serial}.png",
                        "source_locator": {
                            "file_sha256": page_sha,
                            "path": page_relative,
                            "provenance": "real_preserved",
                            "resolution_contract": "resolve against caller-supplied library_root",
                            "size_bytes": page_path.stat().st_size,
                            "size_px": [600, 900],
                            "storage_root": "library_root",
                        },
                        "source_page_sha256": page_sha,
                    },
                    "provenance": {
                        "approval": "exhaustive_manual_visual_review",
                        "qa_overlay": False,
                        "source_catalog_id": catalog_id,
                        "source_id": sample_id,
                        "synthetic": False,
                    },
                    "sample_crop_sha256": stable_hash("crop", sample_id),
                    "schema_version": 1,
                    "split": "train",
                    "views": views,
                    "work": {"id": work_id, "title": None},
                    "work_balance_weight": 1.0,
                }
            )

    def _build_bank(self) -> None:
        candidates: list[dict] = []
        renders: list[dict] = []
        for index, font_id in enumerate(FONT_IDS):
            alias = f"ko-candidate-{stable_hash('alias', font_id)[:16]}"
            display_id = f"secret-display-{index:02d}"
            # Exercise the explicit failure path without encoding any current
            # production-family outage into the fixture.
            compatible = font_id != FIXTURE_UNRENDERABLE_FONT_ID
            candidates.append(
                {
                    "allowed_writing_modes": ["horizontal", "vertical"],
                    "blind_alias": alias,
                    "css_family": f"Secret CSS {index:02d}",
                    "display_id": display_id,
                    "face_id": f"secret-face-{index:02d}",
                    "font_id": font_id,
                    "font_label": f"Secret Family {index:02d}",
                    "format": "truetype",
                    "missing_probe_codepoints": [],
                    "probe_coverage_complete": True,
                    "production_400_normal_canonical": True,
                    "production_asset_status": {
                        "chromium_ots_compatible": compatible,
                        "code": "passed" if compatible else "fixture-unrenderable",
                        "evidence": None,
                        "zero_length_tables": [] if compatible else ["TEST"],
                    },
                    "production_request_bindings": [
                        {
                            "requested_style": "normal",
                            "requested_weight": 400,
                            "synthetic_style": False,
                        }
                    ],
                    "render_style": "normal",
                    "render_weight": 400,
                    "source_css_style": "normal",
                    "source_css_weight": {"max": 400, "min": 400, "raw": "400"},
                    "source_file": f"private/{font_id}.ttf",
                    "source_sha256": stable_hash("font", font_id),
                }
            )
            if not compatible:
                continue
            for mode in ("horizontal", "vertical"):
                for probe_id in sorted(
                    set(CARDS.PROBE_IDS) | set(CARDS.V4_REQUIRED_PROBE_IDS)
                ):
                    text, font_size, tracking = PROBE_SPECS[probe_id]
                    suffix = "h" if mode == "horizontal" else "v"
                    relative = f"images/{alias}/{probe_id}-{suffix}.png"
                    path = self.bank / Path(*Path(relative).parts)
                    size = (448, 224) if mode == "horizontal" else (224, 448)
                    artifact_sha = write_image(
                        path,
                        size,
                        (245 - index * 4, 238 - index * 3, 232 - index * 2),
                        mark=f"P{index:02d}",
                    )
                    render_id = f"render-{stable_hash(display_id, probe_id, mode)[:20]}"
                    renders.append(
                        {
                            "artifact": {
                                "byte_size": path.stat().st_size,
                                "file": relative,
                                "height": size[1],
                                "qa_overlay": False,
                                "sha256": artifact_sha,
                                "width": size[0],
                            },
                            "blind_alias": alias,
                            "canvas": {"height": size[1], "width": size[0]},
                            "candidate_display_id": display_id,
                            "fallback_detection": {"status": "passed"},
                            "font_size_px": font_size,
                            "letter_spacing_em": tracking,
                            "letter_spacing_px": 0,
                            "probe_id": probe_id,
                            "readiness": {
                                "content_fits": True,
                                "document_fonts_ready": True,
                            },
                            "render_id": render_id,
                            "text": text,
                            "writing_mode": mode,
                        }
                    )
        write_json(
            self.bank_manifest,
            {
                "candidate_count": len(candidates),
                "candidates": candidates,
                "family_count": 15,
                "render_spec": {"qa_overlay": False},
                "renderer": {"engine": "fixture-renderer", "version": "1"},
                "renders": renders,
                "schema_version": "font-render-bank-v1",
                "source_contract": {
                    "manifest_sha256": stable_hash("face-manifest"),
                    "schema_version": "font-face-manifest-v1",
                },
                "specification_sha256": stable_hash("render-spec"),
            },
        )

    def _assignment(self, sample: dict, stage: str) -> dict:
        seed = stable_hash(
            "manga-font-candidate-order-v1",
            "unit-allocation",
            "font-face-manifest-v1",
            sample["id"],
            stage,
        )
        order = CARDS.expected_candidate_order(FONT_IDS, seed)
        row = {
            "assignment_id": "pending",
            "blind_first_pass": True,
            "candidate_order": order,
            "candidate_order_seed": seed,
            "catalog_version": "font-face-manifest-v1",
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "record_type": "manga_font_label_assignment",
            "sample_id": sample["id"],
            "schema_version": 1,
            "source_page_sha256": sample["page"]["source_page_sha256"],
            "stage": stage,
            "work_id": sample["work"]["id"],
        }
        row["assignment_id"] = CARDS.expected_assignment_id(row)
        return row

    def _write_master_inventory_assignments(self) -> None:
        write_jsonl(self.master, self.master_rows)
        master_sha = sha(self.master)
        inventory_rows = []
        for index, sample in enumerate(self.master_rows, 1):
            inventory_rows.append(
                {
                    "batches": {
                        "calibration": {
                            "review_order": 3 - index,
                            "selection_reasons": ["fixture"],
                        },
                        "pilot": {
                            "review_order": index,
                            "selection_reasons": ["fixture"],
                        },
                    },
                    "master_manifest_sha256": master_sha,
                    "provenance": {"qa_overlay": False, "synthetic": False},
                    "sample_id": sample["id"],
                }
            )
        write_jsonl(self.inventory, inventory_rows)
        assignments = [
            self._assignment(sample, "primary") for sample in self.master_rows
        ]
        assignments.append(self._assignment(self.master_rows[0], "secondary"))
        write_jsonl(self.assignments, assignments)

    def kwargs(self, output: Path | None = None) -> dict:
        return {
            "assignments": self.assignments,
            "base_root": self.base,
            "hard_root": self.hard,
            "inventory": self.inventory,
            "library_root": self.library,
            "master_manifest": self.master,
            "output_dir": output or self.output,
            "render_bank_manifest": self.bank_manifest,
        }


class ReviewCardBuilderTest(unittest.TestCase):
    def test_builds_high_resolution_blind_cards_without_touching_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            protected = {
                path: sha(path)
                for root in (fixture.base, fixture.hard, fixture.library)
                for path in root.rglob("*.png")
            }
            report = CARDS.build_output(
                **fixture.kwargs(), config=CARDS.RunConfig(stage="primary")
            )
            self.assertEqual(2, report["summary"]["card_count"])
            manifest_path = fixture.output / CARDS.MANIFEST_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(2, len(manifest["cards"]))
            self.assertTrue(manifest["qa_overlay"])
            self.assertFalse(manifest["training_asset"])
            public_text = manifest_path.read_text(encoding="utf-8")
            for font_id in FONT_IDS:
                self.assertNotIn(font_id, public_text)
            self.assertNotIn("Secret Family", public_text)
            self.assertNotIn("Secret CSS", public_text)
            for card in manifest["cards"]:
                self.assertEqual(15, len(card["candidates"]))
                self.assertEqual(
                    card["assignment"]["blind_candidate_order"],
                    [candidate["blind_alias"] for candidate in card["candidates"]],
                )
                unavailable = [
                    candidate
                    for candidate in card["candidates"]
                    if candidate["status"] == "production_asset_unrenderable"
                ]
                self.assertEqual(1, len(unavailable))
                self.assertEqual([], unavailable[0]["probes"])
                card_path = fixture.output / Path(*Path(card["artifact"]["file"]).parts)
                with Image.open(card_path) as image:
                    self.assertEqual((CARDS.CARD_WIDTH, CARDS.CARD_HEIGHT), image.size)
                    self.assertEqual(CARDS.CYAN, image.convert("RGB").getpixel((2, 2)))
            self.assertEqual(protected, {path: sha(path) for path in protected})
            self.assertEqual(
                set(),
                {
                    path.suffix
                    for root in (fixture.base, fixture.hard, fixture.library)
                    for path in root.rglob("*")
                    if path.is_file()
                }
                - {".png"},
            )

    def test_output_is_byte_deterministic_checkable_and_tamper_evident(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            config = CARDS.RunConfig(stage="primary", batch="pilot", limit=1)
            CARDS.build_output(**fixture.kwargs(), config=config)
            card_path = next((fixture.output / "cards").glob("*.png"))
            first = card_path.read_bytes()
            first_manifest = (fixture.output / CARDS.MANIFEST_FILE).read_bytes()
            CARDS.build_output(**fixture.kwargs(), config=config)
            self.assertEqual(first, card_path.read_bytes())
            self.assertEqual(
                first_manifest, (fixture.output / CARDS.MANIFEST_FILE).read_bytes()
            )
            result = CARDS.validate_output(**fixture.kwargs(), expected_config=config)
            self.assertEqual("valid", result["status"])
            card_path.write_bytes(card_path.read_bytes() + b"tamper")
            with self.assertRaisesRegex(CARDS.ReviewCardError, "not deterministic"):
                CARDS.validate_output(**fixture.kwargs(), expected_config=config)

    def test_primary_secondary_and_batch_orders_remain_independent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            secondary_output = fixture.root / "secondary-output"
            CARDS.build_output(
                **fixture.kwargs(secondary_output),
                config=CARDS.RunConfig(stage="secondary"),
            )
            secondary = json.loads(
                (secondary_output / CARDS.MANIFEST_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(1, secondary["card_count"])
            self.assertEqual("secondary", secondary["cards"][0]["assignment"]["stage"])

            calibration_output = fixture.root / "calibration-output"
            CARDS.build_output(
                **fixture.kwargs(calibration_output),
                config=CARDS.RunConfig(stage="primary", batch="calibration", limit=1),
            )
            calibration = json.loads(
                (calibration_output / CARDS.MANIFEST_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(
                "sample-hard", calibration["cards"][0]["assignment"]["sample_id"]
            )

    def test_refuses_unsafe_source_path_and_unowned_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.output.mkdir()
            (fixture.output / "user-file.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(CARDS.ReviewCardError, "unowned"):
                CARDS.build_output(
                    **fixture.kwargs(), config=CARDS.RunConfig(stage="primary", limit=1)
                )
            self.assertEqual(
                "keep", (fixture.output / "user-file.txt").read_text(encoding="utf-8")
            )

            unsafe_output = fixture.root / "unsafe-output"
            fixture.master_rows[0]["views"]["glyph_224"]["path"] = "../escape.png"
            write_jsonl(fixture.master, fixture.master_rows)
            inventory_rows = [
                json.loads(line)
                for line in fixture.inventory.read_text(encoding="utf-8").splitlines()
            ]
            for row in inventory_rows:
                row["master_manifest_sha256"] = sha(fixture.master)
            write_jsonl(fixture.inventory, inventory_rows)
            with self.assertRaisesRegex(CARDS.ReviewCardError, "unsafe relative path"):
                CARDS.build_output(
                    **fixture.kwargs(unsafe_output),
                    config=CARDS.RunConfig(stage="primary", limit=1),
                )

    def test_reveal_is_explicit_and_written_outside_blind_cards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            CARDS.build_output(
                **fixture.kwargs(), config=CARDS.RunConfig(stage="primary", limit=1)
            )
            with self.assertRaisesRegex(CARDS.ReviewCardError, "acknowledge"):
                CARDS.build_reveal_map(
                    render_bank_manifest=fixture.bank_manifest,
                    review_cards_dir=fixture.output,
                    output_dir=fixture.reveal,
                    acknowledgement="NO",
                )
            result = CARDS.build_reveal_map(
                render_bank_manifest=fixture.bank_manifest,
                review_cards_dir=fixture.output,
                output_dir=fixture.reveal,
                acknowledgement=CARDS.UNBLIND_ACKNOWLEDGEMENT,
            )
            self.assertEqual(15, result["mapping_count"])
            reveal = json.loads(
                (fixture.reveal / CARDS.REVEAL_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(
                set(FONT_IDS), {row["font_id"] for row in reveal["mappings"]}
            )
            self.assertFalse((fixture.output / CARDS.REVEAL_FILE).exists())

    def test_builds_and_reveals_a_blind_subset_from_a_larger_bank(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            subset = FONT_IDS[-7:]
            assignments = [
                json.loads(line)
                for line in fixture.assignments.read_text(encoding="utf-8").splitlines()
            ]
            for assignment in assignments:
                assignment["candidate_order"] = CARDS.expected_candidate_order(
                    subset, assignment["candidate_order_seed"]
                )
                assignment["assignment_id"] = CARDS.expected_assignment_id(assignment)
            write_jsonl(fixture.assignments, assignments)

            CARDS.build_output(
                **fixture.kwargs(), config=CARDS.RunConfig(stage="primary")
            )
            manifest = json.loads(
                (fixture.output / CARDS.MANIFEST_FILE).read_text(encoding="utf-8")
            )
            self.assertTrue(
                all(len(card["candidates"]) == 7 for card in manifest["cards"])
            )

            result = CARDS.build_reveal_map(
                render_bank_manifest=fixture.bank_manifest,
                review_cards_dir=fixture.output,
                output_dir=fixture.reveal,
                acknowledgement=CARDS.UNBLIND_ACKNOWLEDGEMENT,
            )
            self.assertEqual(7, result["mapping_count"])
            reveal = json.loads(
                (fixture.reveal / CARDS.REVEAL_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(
                set(subset), {row["font_id"] for row in reveal["mappings"]}
            )

    def test_v4_builds_sealed_two_stage_uniform_role_conditioned_cards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            subset = fixture.use_seven_candidate_subset()
            source_seal = fixture.write_v4_source_seal()
            bank = json.loads(fixture.bank_manifest.read_text(encoding="utf-8"))
            rendered_ids = [font_id for font_id in subset if font_id != FONT_IDS[0]]
            displays = {
                candidate["font_id"]: candidate["display_id"]
                for candidate in bank["candidates"]
            }
            fallback_display = displays[rendered_ids[0]]
            clipped_display = displays[rendered_ids[1]]
            for render in bank["renders"]:
                key = (
                    render["candidate_display_id"],
                    render["probe_id"],
                    render["writing_mode"],
                )
                if key == (fallback_display, "dialogue-body", "horizontal"):
                    render["fallback_detection"]["status"] = "failed"
                if key == (clipped_display, "sfx-motion", "horizontal"):
                    render["readiness"]["content_fits"] = False
            write_json(fixture.bank_manifest, bank)

            config = CARDS.RunConfig(
                stage="primary", limit=1, probe_profile=CARDS.V4_PROBE_PROFILE
            )
            report = CARDS.build_output(
                **fixture.kwargs(),
                config=config,
                source_seal_manifest=source_seal,
            )
            self.assertEqual(1, report["summary"]["card_count"])
            manifest_path = fixture.output / CARDS.MANIFEST_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual("v4", manifest["configuration"]["probe_profile"])
            self.assertEqual(
                [CARDS.CARD_WIDTH, CARDS.V4_CARD_HEIGHT],
                manifest["card_render_contract"]["canvas_px"],
            )
            self.assertTrue(
                manifest["card_render_contract"]["source_stage_visually_separated"]
            )
            self.assertFalse(manifest["blindness_contract"]["prior_role_visible"])
            self.assertFalse(manifest["blindness_contract"]["prior_tiers_visible"])
            self.assertFalse(manifest["blindness_contract"]["split_visible"])
            card = manifest["cards"][0]
            self.assertEqual(7, len(card["candidates"]))
            self.assertTrue(card["probe_contract"]["source_stage_visually_separated"])
            self.assertFalse(
                card["probe_contract"]["candidate_specific_phrase_or_tracking"]
            )
            self.assertEqual(
                [1.0, 0.5], card["probe_contract"]["native_small_scale_factors"]
            )
            self.assertEqual(
                "skeleton_only", card["probe_contract"]["treatment_ab"]["a"]
            )
            self.assertFalse(
                card["probe_contract"]["role_conditioned"][
                    "private_sealed_role_visible"
                ]
            )
            failures = {
                candidate["status_code"]
                for candidate in card["candidates"]
                if candidate["status"] == "mandatory_unrenderable"
            }
            self.assertEqual(
                {
                    "fixture-unrenderable",
                    "font-fallback-detected",
                    "content-clipping-or-fit-failure",
                },
                failures,
            )
            rendered = [
                candidate
                for candidate in card["candidates"]
                if candidate["status"] == "rendered"
            ]
            self.assertTrue(rendered)
            self.assertTrue(
                all(len(candidate["probes"]) == 3 for candidate in rendered)
            )
            for probe_index in range(3):
                self.assertEqual(
                    1,
                    len(
                        {
                            candidate["probes"][probe_index]["contract_sha256"]
                            for candidate in rendered
                        }
                    ),
                )
            public_text = manifest_path.read_text(encoding="utf-8")
            self.assertNotIn("sfx_motion", public_text)
            self.assertNotIn('"split"', public_text)
            self.assertNotIn('"model_score"', public_text)
            self.assertNotIn('"model_proposals"', public_text)
            for font_id in FONT_IDS:
                self.assertNotIn(font_id, public_text)
            card_path = fixture.output / card["artifact"]["file"]
            with Image.open(card_path) as image:
                self.assertEqual((CARDS.CARD_WIDTH, CARDS.V4_CARD_HEIGHT), image.size)
                rgb = image.convert("RGB")
                self.assertEqual(CARDS.CYAN, rgb.getpixel((2, 2)))
                self.assertEqual(CARDS.DARK, rgb.getpixel((2, 1420)))
            result = CARDS.validate_output(
                **fixture.kwargs(),
                expected_config=config,
                source_seal_manifest=source_seal,
            )
            self.assertEqual("valid", result["status"])

    def test_v4_rejects_candidate_specific_phrase_or_tracking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            subset = fixture.use_seven_candidate_subset()
            source_seal = fixture.write_v4_source_seal()
            bank = json.loads(fixture.bank_manifest.read_text(encoding="utf-8"))
            candidate = next(
                value for value in bank["candidates"] if value["font_id"] == subset[1]
            )
            render = next(
                value
                for value in bank["renders"]
                if value["candidate_display_id"] == candidate["display_id"]
                and value["probe_id"] == "sfx-motion"
                and value["writing_mode"] == "horizontal"
            )
            render["letter_spacing_em"] = 0.125
            write_json(fixture.bank_manifest, bank)
            with self.assertRaisesRegex(
                CARDS.ReviewCardError, "candidate-specific phrase/tracking"
            ):
                CARDS.build_output(
                    **fixture.kwargs(),
                    config=CARDS.RunConfig(
                        stage="primary",
                        limit=1,
                        probe_profile=CARDS.V4_PROBE_PROFILE,
                    ),
                    source_seal_manifest=source_seal,
                )

    def test_v4_source_seal_is_explicit_and_profile_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.use_seven_candidate_subset()
            source_seal = fixture.write_v4_source_seal()
            with self.assertRaisesRegex(CARDS.ReviewCardError, "requires"):
                CARDS.build_output(
                    **fixture.kwargs(),
                    config=CARDS.RunConfig(
                        stage="primary",
                        limit=1,
                        probe_profile=CARDS.V4_PROBE_PROFILE,
                    ),
                )
            with self.assertRaisesRegex(CARDS.ReviewCardError, "only valid"):
                CARDS.build_output(
                    **fixture.kwargs(),
                    config=CARDS.RunConfig(stage="primary", limit=1),
                    source_seal_manifest=source_seal,
                )
            seal_value = json.loads(source_seal.read_text(encoding="utf-8"))
            seal_value["inputs"]["inventory_sha256"] = stable_hash("stale-inventory")
            seal_core = {
                key: value
                for key, value in seal_value.items()
                if key != "record_sha256"
            }
            seal_value["record_sha256"] = CARDS.sha256_json(seal_core)
            write_json(source_seal, seal_value)
            with self.assertRaisesRegex(CARDS.ReviewCardError, "binding is stale"):
                CARDS.build_output(
                    **fixture.kwargs(),
                    config=CARDS.RunConfig(
                        stage="primary",
                        limit=1,
                        probe_profile=CARDS.V4_PROBE_PROFILE,
                    ),
                    source_seal_manifest=source_seal,
                )

    def test_calibration_source_seal_uses_fresh_authority_without_prior_answer(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            rows = []
            for sample in sorted(fixture.master_rows, key=lambda row: row["id"]):
                core = {
                    "fresh_source_observation_record_sha256": stable_hash(
                        "fresh-source", sample["id"]
                    ),
                    "sample_id": sample["id"],
                    "sealed_role": "sfx_motion",
                    "treatment": {
                        "distortion": False,
                        "inverse": False,
                        "outline": True,
                        "shadow": False,
                        "texture": True,
                    },
                }
                rows.append({**core, "record_sha256": CARDS.sha256_json(core)})
            core = {
                "baseline_label_fields_present": False,
                "candidate_score_or_rank_fields_present": False,
                "development_only": True,
                "inputs": {
                    "fresh_source_observations_sha256": stable_hash(
                        "fresh-source-observations"
                    ),
                    "inventory_sha256": sha(fixture.inventory),
                    "master_manifest_sha256": sha(fixture.master),
                    "rubric_sha256": stable_hash("v5-rubric"),
                },
                "record_type": CARDS.CALIBRATION_ONLY_SOURCE_SEAL_RECORD_TYPE,
                "samples": rows,
                "schema_version": CARDS.CALIBRATION_ONLY_SOURCE_SEAL_SCHEMA_VERSION,
                "training_disposition": CARDS.CALIBRATION_ONLY_TRAINING_DISPOSITION,
            }
            value = {**core, "record_sha256": CARDS.sha256_json(core)}
            write_json(fixture.source_seal, value)
            loaded = CARDS._load_v4_source_seals(
                fixture.source_seal,
                inventory_ids={row["id"] for row in fixture.master_rows},
                master_manifest_sha256=sha(fixture.master),
                inventory_sha256=sha(fixture.inventory),
            )
            self.assertTrue(loaded)
            self.assertEqual(
                {"fresh_calibration_source_observation"},
                {row["source_authority"] for row in loaded.values()},
            )
            self.assertTrue(
                all("prior_final_record_sha256" not in row for row in loaded.values())
            )

            value["samples"][0]["prior_final_record_sha256"] = stable_hash(
                "forbidden-prior"
            )
            row_core = {
                key: item
                for key, item in value["samples"][0].items()
                if key != "record_sha256"
            }
            value["samples"][0]["record_sha256"] = CARDS.sha256_json(row_core)
            manifest_core = {
                key: item for key, item in value.items() if key != "record_sha256"
            }
            value["record_sha256"] = CARDS.sha256_json(manifest_core)
            write_json(fixture.source_seal, value)
            with self.assertRaisesRegex(CARDS.ReviewCardError, "unexpected fields"):
                CARDS._load_v4_source_seals(
                    fixture.source_seal,
                    inventory_ids={row["id"] for row in fixture.master_rows},
                    master_manifest_sha256=sha(fixture.master),
                    inventory_sha256=sha(fixture.inventory),
                )

    def test_embeds_three_anonymous_same_work_dialogue_references(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            references = fixture.write_work_reference_manifest()
            report = CARDS.build_output(
                **fixture.kwargs(),
                config=CARDS.RunConfig(stage="primary", limit=1),
                work_reference_manifest=references,
            )

            self.assertEqual(3, report["summary"]["work_reference_count"])
            manifest = json.loads(
                (fixture.output / CARDS.MANIFEST_FILE).read_text(encoding="utf-8")
            )
            card = manifest["cards"][0]
            self.assertEqual(3, card["work_references"]["count"])
            self.assertTrue(card["work_references"]["anonymous"])
            public_text = json.dumps(manifest, sort_keys=True)
            self.assertNotIn("reference-source", public_text)
            self.assertNotIn("target_work_id", public_text)
            self.assertNotIn("chapter_id", public_text)
            CARDS.validate_output(
                **fixture.kwargs(),
                work_reference_manifest=references,
            )

    def test_registry_resolves_third_hard_catalog_views_and_work_references(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary), include_delta=True)
            registry = fixture.write_catalog_registry()
            references = fixture.write_work_reference_manifest()
            kwargs = fixture.kwargs()
            del kwargs["base_root"]
            del kwargs["hard_root"]
            kwargs["catalog_registry"] = registry
            config = CARDS.RunConfig(stage="primary")

            report = CARDS.build_output(
                **kwargs,
                config=config,
                work_reference_manifest=references,
            )
            self.assertEqual(3, report["summary"]["card_count"])
            self.assertEqual(9, report["summary"]["work_reference_count"])
            manifest = json.loads(
                (fixture.output / CARDS.MANIFEST_FILE).read_text(encoding="utf-8")
            )
            delta_card = next(
                card
                for card in manifest["cards"]
                if card["assignment"]["sample_id"] == "sample-delta"
            )
            self.assertEqual(
                "derived_for_review",
                delta_card["source"]["views"]["raw_224"]["status"],
            )
            self.assertTrue((fixture.output / delta_card["artifact"]["file"]).is_file())

            delta_source = next(
                row for row in fixture.master_rows if row["id"] == "sample-delta"
            )
            delta_glyph_sha = delta_source["views"]["glyph_224"]["file_sha256"]
            base_card = next(
                card
                for card in manifest["cards"]
                if card["assignment"]["sample_id"] == "sample-base"
            )
            reference_glyph_hashes = {
                reference["views"]["glyph_224"]["source_sha256"]
                for reference in base_card["work_references"]["items"]
            }
            self.assertIn(delta_glyph_sha, reference_glyph_hashes)
            result = CARDS.validate_output(
                **kwargs,
                expected_config=config,
                work_reference_manifest=references,
            )
            self.assertEqual("valid", result["status"])

            cli_args = [
                "validate",
                "--output-dir",
                str(fixture.output),
                "--master-manifest",
                str(fixture.master),
                "--inventory",
                str(fixture.inventory),
                "--assignments",
                str(fixture.assignments),
                "--render-bank-manifest",
                str(fixture.bank_manifest),
                "--catalog-registry",
                str(registry),
                "--library-root",
                str(fixture.library),
                "--work-reference-manifest",
                str(references),
            ]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, CARDS.main(cli_args))
            stderr = io.StringIO()
            with (
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(stderr),
            ):
                self.assertEqual(
                    2,
                    CARDS.main(
                        [
                            *cli_args,
                            "--base-root",
                            str(fixture.base),
                            "--hard-root",
                            str(fixture.hard),
                        ]
                    ),
                )
            self.assertIn("cannot be mixed", stderr.getvalue())

            registry_bytes = registry.read_bytes()
            registry_value = json.loads(registry_bytes)
            registry_value["catalogs"][2]["root"] = str(fixture.base)
            write_json(registry, registry_value)
            with self.assertRaisesRegex(CARDS.ReviewCardError, "record seal mismatch"):
                CARDS.resolve_catalog_roots(catalog_registry=registry)
            registry.write_bytes(registry_bytes)

            delta_manifest = fixture.delta / "manifest.jsonl"
            delta_manifest.write_bytes(delta_manifest.read_bytes() + b"{}\n")
            with self.assertRaisesRegex(
                CARDS.ReviewCardError, "catalog manifest changed"
            ):
                CARDS.resolve_catalog_roots(catalog_registry=registry)


if __name__ == "__main__":
    unittest.main()
