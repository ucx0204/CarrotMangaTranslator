from __future__ import annotations

import hashlib
import importlib.util
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
    def __init__(self, root: Path) -> None:
        self.root = root
        self.master_dir = root / "master-input"
        self.inventory_dir = root / "inventory-input"
        self.assignment_dir = root / "assignment-input"
        self.bank = root / "render-bank-input"
        self.base = root / "base-catalog"
        self.hard = root / "hard-catalog"
        self.library = root / "library-input"
        self.output = root / "review-cards-output"
        self.reveal = root / "reveal-output"
        self.master = self.master_dir / "manifest.jsonl"
        self.inventory = self.inventory_dir / "inventory.jsonl"
        self.assignments = self.assignment_dir / "assignments.jsonl"
        self.bank_manifest = self.bank / "manifest.json"
        self.work_references = root / "work-reference-input" / "manifest.json"
        self.master_rows: list[dict] = []
        self.page_hashes: dict[str, str] = {}
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

    def _build_sources(self) -> None:
        specs = (
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
                if sample_id == "sample-hard" and view_name == "raw_224":
                    native_relative = "images/raw/sample-hard.png"
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
                for probe_id in CARDS.PROBE_IDS:
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
                            "candidate_display_id": display_id,
                            "fallback_detection": {"status": "passed"},
                            "probe_id": probe_id,
                            "readiness": {"document_fonts_ready": True},
                            "render_id": render_id,
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
                for line in fixture.assignments.read_text(
                    encoding="utf-8"
                ).splitlines()
            ]
            for assignment in assignments:
                assignment["candidate_order"] = CARDS.expected_candidate_order(
                    subset, assignment["candidate_order_seed"]
                )
                assignment["assignment_id"] = CARDS.expected_assignment_id(
                    assignment
                )
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


if __name__ == "__main__":
    unittest.main()
