from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "font_matching_catalog_delta_ledger.py"
SPEC = importlib.util.spec_from_file_location(
    "font_matching_catalog_delta_ledger", SCRIPT
)
assert SPEC and SPEC.loader
LEDGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEDGER)
LABEL_SPEC = importlib.util.spec_from_file_location(
    "font_matching_labels_for_delta_test", ROOT / "scripts" / "font_matching_labels.py"
)
assert LABEL_SPEC and LABEL_SPEC.loader
LABELS = importlib.util.module_from_spec(LABEL_SPEC)
sys.modules[LABEL_SPEC.name] = LABELS
LABEL_SPEC.loader.exec_module(LABELS)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(LEDGER.canonical_json_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(LEDGER.jsonl_bytes(rows))


def source_seal(value: dict) -> dict:
    output = json.loads(json.dumps(value))
    output.pop("record_sha256", None)
    output["record_sha256"] = LEDGER.sha256_bytes(
        LEDGER.canonical_json_bytes(output) + b"\n"
    )
    return output


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.rescue = root / "rescue"
        self.audit = root / "audit"
        self.primary_cards = root / "primary-cards"
        self.secondary_cards = root / "secondary-cards"
        self.primary_split = root / "primary-split"
        self.secondary_split = root / "secondary-split"
        self.master_split_map = root / "master-split-map.json"
        self.aliases = list(LEDGER.v5_deriver.FROZEN_ALIAS_ORDER)
        self.font_ids = [f"delta-font-{index}" for index in range(1, 8)]
        self.old_ids = [f"old-font-{index:02d}" for index in range(15)]
        self.sample_ids = ["fm_sample_a", "fm_sample_b"]
        self.work_ids = ["work-a", "work-b"]
        self.assignments: dict[tuple[str, str], dict] = {}
        self._build()

    def _prior(self, sample_id: str, work_id: str, page_sha: str) -> dict:
        return LEDGER.seal(
            {
                "schema_version": 1,
                "record_type": "manga_font_label_final",
                "final_id": f"old-final-{sample_id}",
                "sample_id": sample_id,
                "work_id": work_id,
                "source_page_sha256": page_sha,
                "role": {"primary": "dialogue", "confidence": 0.95},
                "source_style": {
                    "serifness": 0.0,
                    "weight": 0.5,
                    "width": 0.5,
                    "roundness": 0.5,
                    "stroke_contrast": 0.25,
                    "handwritten": 0.0,
                    "angularity": 0.25,
                    "irregularity": 0.0,
                    "slant": 0.0,
                    "energy": 0.25,
                    "unknown_fields": [],
                },
                "treatment": {
                    "orientation": "horizontal",
                    "outline": "none",
                    "shadow": "none",
                    "fill": "solid",
                    "distortion": "none",
                },
                "font_judgment": {
                    "preferred": self.old_ids[:1],
                    "acceptable": self.old_ids[1:3],
                    "marginal": self.old_ids[3:8],
                    "unacceptable": self.old_ids[8:],
                    "unrenderable": [],
                    "not_reviewed": [],
                    "none_acceptable": False,
                },
                "consistency": {
                    "policy": "inherit_work_anchor",
                    "reason_code": "ordinary_dialogue",
                },
                "resolution": {
                    "kind": "primary",
                    "resolver": "old-resolver",
                    "resolved_at": "2026-07-01T00:00:00Z",
                    "source_label_ids": [f"old-review-{sample_id}"],
                    "catalog_version": "font-face-manifest-v1",
                    "catalog_sha256": "1" * 64,
                    "renderer_hash": "2" * 64,
                    "confidence": 0.95,
                    "flags": [],
                    "notes": "sealed prior decision",
                    "adjudication_evidence": None,
                },
            }
        )

    def _selection(
        self, sample_id: str, work_id: str, page_sha: str, order: int
    ) -> dict:
        prior = self._prior(sample_id, work_id, page_sha)
        return source_seal(
            {
                "schema_version": LEDGER.SOURCE_SCHEMA_VERSION,
                "record_type": "font_catalog_delta_review_selection",
                "sample_id": sample_id,
                "work_id": work_id,
                "source_page_sha256": page_sha,
                "review_order": order,
                "master_manifest_sha256": "3" * 64,
                "batches": {},
                "font_signal_audit": {
                    "required": False,
                    "status": "not_required",
                    "reasons": [],
                    "automatic_absent_classification_allowed": False,
                },
                "priority": {
                    "rank": 2,
                    "code": "priority_2",
                    "reasons": ["ordinary"],
                    "work_interleaved": True,
                    "split_used_for_ordering": False,
                },
                "provenance": {
                    "active_training_export_authoritative": True,
                    "synthetic": False,
                    "qa_overlay": False,
                },
                "review_surface": {
                    "candidate_identity": "blind_alias_only",
                    "font_names_visible": False,
                    "model_suggestions_visible": False,
                    "prior_tiers_visible": False,
                    "split_visible": False,
                },
                "new_7_candidate_judgment": {
                    "preferred": [],
                    "acceptable": [],
                    "marginal": [],
                    "unacceptable": [],
                    "unrenderable": [],
                    "not_reviewed": list(self.font_ids),
                    "none_acceptable": None,
                    "human_review_required": True,
                    "automatic_tier_assignment_allowed": False,
                },
                "merge_provenance": {
                    "visibility": "merge_only_not_reviewer_surface",
                    "prior_catalog_candidate_count": 15,
                    "prior_catalog_sha256": "1" * 64,
                    "prior_final_record_sha256": prior["record_sha256"],
                    "source_master_line_number": order,
                    "source_master_record_sha256": "4" * 64,
                    "training_sample_record_sha256": "5" * 64,
                    "prior_final_record": prior,
                },
            }
        )

    def _assignment(
        self, sample_id: str, work_id: str, page_sha: str, order: int, stage: str
    ) -> dict:
        offset = 0 if stage == "primary" else 1
        ids = self.font_ids[offset:] + self.font_ids[:offset]
        aliases = self.aliases[offset:] + self.aliases[:offset]
        assignment = {
            "schema_version": 1,
            "record_type": "manga_font_label_assignment",
            "assignment_id": f"fmra-{sample_id}-{stage}",
            "sample_id": sample_id,
            "work_id": work_id,
            "source_page_sha256": page_sha,
            "stage": stage,
            "review_order": order,
            "priority_rank": 2,
            "catalog_version": "font-face-manifest-v1",
            "candidate_count": 7,
            "candidate_order": ids,
            "blind_alias_order": aliases,
            "candidate_order_seed": LEDGER.stable_hash(sample_id, stage),
            "candidate_initial_state": "not_reviewed",
            "blind_first_pass": True,
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "prior_tiers_visible": False,
            "split_visible": False,
            "release_state": "ready",
            "adjudication_if": list(LEDGER.EXPECTED_TRIGGER_NAMES),
            "reviewer_independence": {
                "required_for_secondary": stage == "secondary",
                "same_reviewer_as_primary_allowed": (
                    False if stage == "secondary" else None
                ),
            },
        }
        self.assignments[(sample_id, stage)] = assignment
        return assignment

    def _card(self, assignment: dict, root: Path) -> dict:
        artifact_path = root / "cards" / f"{assignment['assignment_id']}.png"
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (100, 200), (245, 245, 245))
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 99, 49), fill=(230, 240, 250))
        draw.rectangle((0, 50, 99, 199), fill=(250, 235, 225))
        draw.text((4, 4), assignment["stage"][:1], fill=(0, 0, 0))
        image.save(artifact_path, format="PNG")
        return {
            "schema_version": "font-matching-review-card-v1",
            "card_id": f"card-{assignment['assignment_id']}",
            "assignment": {
                "assignment_id": assignment["assignment_id"],
                "sample_id": assignment["sample_id"],
                "stage": assignment["stage"],
                "candidate_order_seed": assignment["candidate_order_seed"],
                "catalog_version": assignment["catalog_version"],
                "blind_candidate_order": assignment["blind_alias_order"],
            },
            "artifact": {
                "file": artifact_path.relative_to(root).as_posix(),
                "sha256": LEDGER.sha256_file(artifact_path),
                "qa_overlay": True,
                "watermark": "REVIEW-ONLY",
                "width": 100,
                "height": 200,
            },
            "candidates": [
                {
                    "blind_alias": alias,
                    "position": index + 1,
                    "status": "rendered",
                    "status_code": None,
                    "probes": [],
                }
                for index, alias in enumerate(assignment["blind_alias_order"])
            ],
            "source": {
                "source_page_sha256": assignment["source_page_sha256"],
                "sample_crop_sha256": "6" * 64,
                "orientation": "horizontal",
                "bbox_px": [1, 2, 30, 40],
                "views": {},
            },
        }

    def _build(self) -> None:
        selection: list[dict] = []
        assignments: list[dict] = []
        primary_cards: list[dict] = []
        secondary_cards: list[dict] = []
        for order, (sample_id, work_id) in enumerate(
            zip(self.sample_ids, self.work_ids), start=1
        ):
            page_sha = f"{order + 6:x}" * 64
            selection.append(self._selection(sample_id, work_id, page_sha, order))
            for stage in ("primary", "secondary"):
                assignment = self._assignment(
                    sample_id, work_id, page_sha, order, stage
                )
                assignments.append(assignment)
                card = self._card(
                    assignment,
                    self.primary_cards if stage == "primary" else self.secondary_cards,
                )
                (primary_cards if stage == "primary" else secondary_cards).append(card)

        render_manifest = {
            "schema_version": "font-render-bank-v1",
            "candidate_count": 7,
            "candidates": [
                {
                    "blind_alias": alias,
                    "font_id": font_id,
                    "font_label": f"Delta Family {index}",
                    "css_family": f"Fixture Delta {index}",
                    "face_id": f"{font_id}:face",
                    "display_id": f"{font_id}:display",
                }
                for index, (alias, font_id) in enumerate(
                    zip(self.aliases, self.font_ids), start=1
                )
            ],
            "renders": [],
        }
        write_jsonl(self.rescue / "selection.jsonl", selection)
        write_jsonl(self.rescue / "assignments.jsonl", assignments)
        write_jsonl(
            self.rescue / "master.jsonl",
            [
                {
                    "id": sample_id,
                    "sample_crop_sha256": f"{index + 10:x}" * 64,
                    "groups": {
                        "root": f"root-{sample_id}",
                        "variant": f"variant-{sample_id}",
                        "normalized_glyph": f"glyph-{sample_id}",
                    },
                    "page": {
                        "id": f"page-{sample_id}",
                        "source_page_sha256": f"{index + 12:x}" * 64,
                    },
                    "provenance": {
                        "source_id": f"source-{sample_id}",
                        "source_lineage": [{"id": f"lineage-{sample_id}"}],
                    },
                    "views": {
                        "context_224": {
                            "path": f"images/context_224/val/{sample_id}.png"
                        },
                        "glyph_224": {"path": f"images/glyph_224/val/{sample_id}.png"},
                    },
                    "work": {"id": self.work_ids[index]},
                }
                for index, sample_id in enumerate(self.sample_ids)
            ],
        )
        write_json(self.rescue / "render-bank" / "manifest.json", render_manifest)
        write_json(
            self.master_split_map,
            {
                "schema_version": 1,
                "algorithm": {
                    "id": "frozen-work-assignment",
                    "frozen_source": {"sha256": "f" * 64},
                },
                "components": [
                    {
                        "id": f"component-{index}",
                        "sample_count": 1,
                        "split": "val",
                        "work_count": 1,
                        "work_ids": [work_id],
                    }
                    for index, work_id in enumerate(self.work_ids)
                ],
                "work_assignments": {work_id: "val" for work_id in self.work_ids},
            },
        )
        source_report = source_seal(
            {
                "schema_version": LEDGER.SOURCE_SCHEMA_VERSION,
                "record_type": "font_matching_catalog_delta_review_inputs_report",
                "inputs": {
                    "expanded_catalog_sha256": "a" * 64,
                    "expanded_render_bank_sha256": "b" * 64,
                    "master_manifest_sha256": "c" * 64,
                    "master_split_map_sha256": LEDGER.sha256_file(
                        self.master_split_map
                    ),
                    "catalog_registry_sha256": "d" * 64,
                },
                "outputs": {
                    "selection_sha256": LEDGER.sha256_file(
                        self.rescue / "selection.jsonl"
                    ),
                    "assignments_sha256": LEDGER.sha256_file(
                        self.rescue / "assignments.jsonl"
                    ),
                    "master_sha256": LEDGER.sha256_file(self.rescue / "master.jsonl"),
                    "render_bank_manifest_sha256": LEDGER.sha256_file(
                        self.rescue / "render-bank" / "manifest.json"
                    ),
                },
                "summary": {"selected_sample_count": 2},
                "contracts": {},
            }
        )
        write_json(self.rescue / "report.json", source_report)

        write_jsonl(self.audit / "ledger.jsonl", [])
        write_jsonl(self.audit / "review-ready-inventory.jsonl", selection)
        write_jsonl(self.audit / "review-ready-assignments.jsonl", assignments)
        audit_report = LEDGER.seal(
            {
                "schema_version": LEDGER.AUDIT_SCHEMA_VERSION,
                "record_type": "font_matching_font_signal_audit_report",
                "inputs": {
                    "source_report_file_sha256": LEDGER.sha256_file(
                        self.rescue / "report.json"
                    ),
                    "source_report_record_sha256": source_report["record_sha256"],
                },
                "outputs": {
                    "ledger_sha256": LEDGER.sha256_file(self.audit / "ledger.jsonl"),
                    "review_ready_inventory_sha256": LEDGER.sha256_file(
                        self.audit / "review-ready-inventory.jsonl"
                    ),
                    "review_ready_assignments_sha256": LEDGER.sha256_file(
                        self.audit / "review-ready-assignments.jsonl"
                    ),
                },
                "summary": {"audit_count": 0, "review_ready_inventory_count": 2},
                "contracts": {},
            }
        )
        write_json(self.audit / "report.json", audit_report)

        blindness = {
            "candidate_identity_fields_present": False,
            "font_names_visible": False,
            "model_suggestions_visible": False,
            "public_candidates_use_blind_alias_only": True,
            "reveal_map_embedded": False,
            "same_work_references_anonymous": True,
        }
        write_json(
            self.primary_cards / "manifest.json",
            {
                "card_count": len(primary_cards),
                "blindness_contract": blindness,
                "cards": primary_cards,
            },
        )
        write_json(
            self.secondary_cards / "manifest.json",
            {
                "card_count": len(secondary_cards),
                "blindness_contract": blindness,
                "cards": secondary_cards,
            },
        )
        self._build_v5_split(
            stage="primary",
            card_root=self.primary_cards,
            split_root=self.primary_split,
        )
        self._build_v5_split(
            stage="secondary",
            card_root=self.secondary_cards,
            split_root=self.secondary_split,
        )

    def _build_v5_split(self, *, stage: str, card_root: Path, split_root: Path) -> None:
        source_manifest_path = card_root / "manifest.json"
        source_manifest = LEDGER.read_json(source_manifest_path)
        rows: list[dict] = []
        for card in source_manifest["cards"]:
            assignment_id = card["assignment"]["assignment_id"]
            source_file = split_root / "source-only" / f"{assignment_id}.png"
            candidate_file = split_root / "candidate-only" / f"{assignment_id}.png"
            source_file.parent.mkdir(parents=True, exist_ok=True)
            candidate_file.parent.mkdir(parents=True, exist_ok=True)
            full_file = card_root / card["artifact"]["file"]
            with Image.open(full_file) as opened:
                full_image = opened.convert("RGB")
            source_image = full_image.crop((0, 0, 100, 50))
            candidate_image = full_image.crop((0, 50, 100, 200))
            source_image.save(source_file, format="PNG")
            candidate_image.save(candidate_file, format="PNG")
            rows.append(
                {
                    "assignment_id": assignment_id,
                    "sample_id": card["assignment"]["sample_id"],
                    "stage": stage,
                    "full_card": {
                        "file": str(full_file.resolve()),
                        "sha256": LEDGER.sha256_file(full_file),
                        "pixel_sha256": LEDGER._v5_pixel_sha256(full_image),
                        "size_px": [100, 200],
                    },
                    "source_only": {
                        "file": source_file.relative_to(split_root).as_posix(),
                        "sha256": LEDGER.sha256_file(source_file),
                        "pixel_sha256": LEDGER._v5_pixel_sha256(source_image),
                        "size_px": [100, 50],
                    },
                    "candidate_only": {
                        "file": candidate_file.relative_to(split_root).as_posix(),
                        "sha256": LEDGER.sha256_file(candidate_file),
                        "pixel_sha256": LEDGER._v5_pixel_sha256(candidate_image),
                        "size_px": [100, 150],
                    },
                }
            )
        write_json(
            split_root / "manifest.json",
            LEDGER.seal(
                {
                    "schema_version": LEDGER.V5_SPLIT_SCHEMA_VERSION,
                    "record_type": "font_matching_review_card_split_manifest",
                    "purpose": "review_only_physical_source_candidate_separation",
                    "qa_overlay": True,
                    "training_asset": False,
                    "card_count": len(rows),
                    "cards": rows,
                    "source_manifest": {
                        "path": str(source_manifest_path.resolve()),
                        "sha256": LEDGER.sha256_file(source_manifest_path),
                        "renderer_hash": "a" * 64,
                    },
                    "split_contract": {
                        "candidate_pixels_visible_in_source_stage": False,
                        "lossless_vertical_rejoin_required": True,
                        "source_candidate_pixel_overlap": 0,
                        "source_stage_must_be_sealed_before_candidate_stage": True,
                        "canvas_px": [100, 200],
                        "source_box_px": [0, 0, 100, 50],
                        "candidate_box_px": [0, 50, 100, 200],
                    },
                }
            ),
        )

    def set_source_split(self, split: str) -> None:
        if split not in {"train", "val", "test"}:
            raise ValueError(split)
        master_path = self.rescue / "master.jsonl"
        rows = LEDGER.read_jsonl(master_path)
        for row in rows:
            for view in row["views"].values():
                if isinstance(view.get("path"), str):
                    parts = Path(view["path"]).parts
                    view["path"] = Path(
                        *(
                            split if part in {"train", "val", "test"} else part
                            for part in parts
                        )
                    ).as_posix()
        write_jsonl(master_path, rows)
        split_map = LEDGER.read_json(self.master_split_map)
        split_map["work_assignments"] = {work_id: split for work_id in self.work_ids}
        for component in split_map["components"]:
            component["split"] = split
        write_json(self.master_split_map, split_map)
        source_report_path = self.rescue / "report.json"
        source_report = LEDGER.read_json(source_report_path)
        source_report["outputs"]["master_sha256"] = LEDGER.sha256_file(master_path)
        source_report["inputs"]["master_split_map_sha256"] = LEDGER.sha256_file(
            self.master_split_map
        )
        write_json(source_report_path, source_seal(source_report))
        audit_report_path = self.audit / "report.json"
        audit_report = LEDGER.read_json(audit_report_path)
        audit_report["inputs"]["source_report_file_sha256"] = LEDGER.sha256_file(
            source_report_path
        )
        audit_report["inputs"]["source_report_record_sha256"] = LEDGER.read_json(
            source_report_path
        )["record_sha256"]
        write_json(audit_report_path, LEDGER.seal(audit_report))

    def init(
        self,
        workspace: Path,
        *,
        mode: str,
        calibration_reservoir: str | None = None,
        calibration_sample_ids: list[str] | None = None,
        prior_calibration_subsets: list[Path] | None = None,
        v5: bool = False,
        verify_card_files: bool = True,
        rubric: Path | None = None,
    ) -> None:
        calibration_ids = None
        round_id = None
        if mode == "calibration":
            calibration_ids = self.root / "calibration-ids.json"
            write_json(
                calibration_ids,
                (
                    self.sample_ids
                    if calibration_sample_ids is None
                    else calibration_sample_ids
                ),
            )
            round_id = "fresh-v2-round"
        LEDGER.initialize_workspace(
            workspace=workspace,
            rescue_inputs=self.rescue,
            font_signal_audit=self.audit,
            primary_card_manifests=[self.primary_cards / "manifest.json"],
            secondary_card_manifests=[self.secondary_cards / "manifest.json"],
            primary_split_manifests=(
                [self.primary_split / "manifest.json"] if v5 else []
            ),
            secondary_split_manifests=(
                [self.secondary_split / "manifest.json"] if v5 else []
            ),
            rubric=(
                rubric
                if rubric is not None
                else ROOT
                / "docs"
                / (
                    "font-matching-v2-review-rubric-v5.md"
                    if v5
                    else "font-matching-v2-review-rubric.md"
                )
            ),
            mode=mode,
            master_split_map=(self.master_split_map if v5 else None),
            calibration_sample_ids=calibration_ids,
            calibration_round_id=round_id,
            calibration_reservoir=calibration_reservoir,
            prior_calibration_subsets=prior_calibration_subsets or [],
            verify_card_files=verify_card_files,
        )

    def decision(
        self,
        sample_id: str,
        stage: str,
        *,
        disagreement: bool = False,
        none: bool = False,
        confidence: float = 0.95,
        eligibility: str = "font_signal_present",
    ) -> dict:
        assignment = self.assignments[(sample_id, stage)]
        manifest_root = (
            self.primary_cards if stage == "primary" else self.secondary_cards
        )
        manifest = json.loads((manifest_root / "manifest.json").read_text())
        card = next(
            row
            for row in manifest["cards"]
            if row["assignment"]["assignment_id"] == assignment["assignment_id"]
        )
        aliases = list(self.aliases)
        if none:
            judgment = {
                "preferred": [],
                "acceptable": [],
                "marginal": aliases[:4],
                "unacceptable": aliases[4:6],
                "unrenderable": aliases[6:],
                "none_acceptable": True,
            }
        else:
            judgment = {
                "preferred": aliases[:1],
                "acceptable": [] if disagreement else aliases[1:2],
                "marginal": aliases[1:4] if disagreement else aliases[2:4],
                "unacceptable": aliases[4:6],
                "unrenderable": aliases[6:],
                "none_acceptable": False,
            }
        return {
            "assignment_id": assignment["assignment_id"],
            "sample_id": sample_id,
            "review_card_sha256": card["artifact"]["sha256"],
            "candidate_order_seed": assignment["candidate_order_seed"],
            "role": "dialogue",
            "role_confidence": 0.95,
            "eligibility": eligibility,
            "font_judgment": judgment if eligibility == "font_signal_present" else None,
            "confidence": confidence,
            "rationale": "원문 골격과 배포 가능성을 네 축으로 확인한 판정이다.",
        }


def variant_v4_source() -> dict:
    roles = {
        "ordinary_body": "dialogue",
        "aside_whisper_handwritten": "aside_balloon_edge",
        "emphasis_shout": "emphasis_dialogue",
        "sfx_impact": "sfx_impact",
        "sfx_motion": "sfx_motion",
        "sfx_ambient": "sfx_ambient",
        "sfx_emotion": "sfx_emotion",
        "sfx_comic": "sfx_comic",
        "sign_ui_title": "sign_ui_title",
    }
    inventory: set[str] = set()
    selection: dict[str, dict] = {}
    master: dict[str, dict] = {}
    stages_by_sample: dict[str, dict[str, dict]] = {}
    split_by_sample: dict[str, str] = {}
    for work_index in range(LEDGER.VARIANT_V4_CORPUS_WORK_COUNT):
        work_id = f"variant-work-{work_index:02d}"
        for stratum_index, (stratum, role) in enumerate(roles.items()):
            sample_id = f"variant-sample-{work_index:02d}-{stratum_index:02d}"
            chapter_id = f"variant-chapter-{work_index:02d}-{stratum_index:02d}"
            page_id = f"variant-page-{work_index:02d}-{stratum_index:02d}"
            page_sha = LEDGER.sha256_bytes(page_id.encode())
            crop_sha = LEDGER.sha256_bytes(f"crop:{sample_id}".encode())
            is_handwritten = stratum == "aside_whisper_handwritten"
            prior = {
                "role": {"primary": role, "confidence": 0.95},
                "source_style": {
                    "weight": 0.5,
                    "width": 0.5,
                    "roundness": 0.5,
                    "handwritten": 0.8 if is_handwritten else 0.0,
                    "irregularity": 0.7 if is_handwritten else 0.0,
                    "angularity": 0.5,
                    "energy": 0.5,
                },
                "treatment": {"orientation": "horizontal"},
            }
            selection[sample_id] = {
                "sample_id": sample_id,
                "work_id": work_id,
                "priority": {"rank": work_index % 3},
                "merge_provenance": {"prior_final_record": prior},
            }
            master[sample_id] = {
                "id": sample_id,
                "sample_crop_sha256": crop_sha,
                "groups": {
                    "root": f"root:{sample_id}",
                    "variant": f"variant:{sample_id}",
                    "normalized_glyph": f"glyph:{sample_id}",
                },
                "chapter": {"id": chapter_id},
                "page": {"id": page_id, "source_page_sha256": page_sha},
                "provenance": {
                    "source_id": f"source:{sample_id}",
                    "source_lineage": [{"id": f"lineage:{sample_id}"}],
                },
                "metadata": {"orientation": "horizontal"},
            }
            stages_by_sample[sample_id] = {
                "primary": {"stage": "primary"},
                "secondary": {
                    "stage": "secondary",
                    "reviewer_independence": {
                        "required_for_secondary": True,
                    },
                },
            }
            split_by_sample[sample_id] = "train"
            inventory.add(sample_id)
    return {
        "inventory": inventory,
        "selection": selection,
        "master": master,
        "stages_by_sample": stages_by_sample,
        "split_by_sample": split_by_sample,
    }


class DeltaLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fixture = Fixture(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _v5_source_annotations(
        self, workspace: Path, *, stage: str, reviewer: str
    ) -> list[dict]:
        raw_tasks = [
            row
            for row in LEDGER.read_jsonl(workspace / "blind-tasks.jsonl")
            if row["stage"] == ("primary" if stage == "adjudication" else stage)
        ]
        tasks = [
            LEDGER.v5_deriver.validate_source_task(
                (
                    LEDGER._v5_task_for_stage(row, "adjudication")
                    if stage == "adjudication"
                    else row
                ),
                f"task[{index}]",
            )
            for index, row in enumerate(raw_tasks)
        ]
        batch_sha = LEDGER.v5_deriver.task_batch_sha256(tasks)
        adjudication_state = None
        adjudication_reviews: dict[str, dict[str, dict]] = {}
        if stage == "adjudication":
            adjudication_state = LEDGER._load_workspace(workspace)
            adjudication_reviews, _ = LEDGER._validate_review_records(
                adjudication_state
            )
        annotations: list[dict] = []
        for task in tasks:
            annotations.append(
                LEDGER.v5_deriver.seal_record(
                    {
                        "schema_version": LEDGER.v5_deriver.SOURCE_SCHEMA_VERSION,
                        "record_type": LEDGER.v5_deriver.SOURCE_RECORD_TYPE,
                        "assignment_id": task["assignment_id"],
                        "sample_id": task["sample_id"],
                        "stage": stage,
                        "reviewer_id": reviewer,
                        "batch_id": f"{stage}-batch-a",
                        "batch_size": len(tasks),
                        "batch_task_set_sha256": batch_sha,
                        "source_only_card_sha256": task["source_only_card_sha256"],
                        **(
                            {
                                "source_review_record_sha256s": [
                                    adjudication_reviews[
                                        str(
                                            adjudication_state["by_assignment"][
                                                task["assignment_id"]
                                            ]["sample_id"]
                                        )
                                    ][source_stage]["record_sha256"]
                                    for source_stage in ("primary", "secondary")
                                    if source_stage
                                    in adjudication_reviews[
                                        str(
                                            adjudication_state["by_assignment"][
                                                task["assignment_id"]
                                            ]["sample_id"]
                                        )
                                    ]
                                ]
                            }
                            if adjudication_state is not None
                            else {}
                        ),
                        "eligibility_evidence": {
                            "complete_text_object": True,
                            "single_source_skeleton": True,
                            "clean_glyph_isolation": True,
                            "role_context_sufficient": True,
                            "font_signal_skeleton_present": True,
                            "crop_issue": "none",
                        },
                        "role_evidence": {
                            "label": False,
                            "sfx_event": "none",
                            "comic_timing": False,
                            "external_utterance": True,
                            "independent_aside": False,
                            "same_utterance_contrast": False,
                            "shout_cues": [],
                            "whisper": False,
                            "inner_thought": False,
                            "narrator": False,
                            "other": False,
                        },
                        "source_family": "sans_printed",
                        "source_family_confidence": 0.95,
                        "serif_evidence": {
                            "raw": {
                                "thick_thin_glyph_ids": [],
                                "terminal_serif_glyph_ids": [],
                            },
                            "glyph_view": {
                                "thick_thin_glyph_ids": [],
                                "terminal_serif_glyph_ids": [],
                            },
                            "cross_view_glyph_ids": [],
                        },
                        "axes": {
                            "weight": 2.5,
                            "width": 2.0,
                            "roundness": 2.0,
                            "handwritten": 0.0,
                            "angularity": 1.5,
                            "energy": 1.5,
                        },
                        "hard_axes": ["weight", "handwritten"],
                        "treatment": {
                            "outline": False,
                            "shadow": False,
                            "inverse_fill": False,
                            "texture": False,
                            "distortion": False,
                            "rotation": False,
                        },
                        "rationale": "Sealed source-only evidence supports a normal printed utterance.",
                    }
                )
            )
        return annotations

    def _v5_release_manifests(self, stage: str) -> list[Path]:
        return [
            (
                self.fixture.secondary_split
                if stage == "secondary"
                else self.fixture.primary_split
            )
            / "manifest.json"
        ]

    def _v5_release_and_derive(
        self, workspace: Path, *, commit: dict
    ) -> tuple[dict, list[dict], list[dict]]:
        release = LEDGER.release_candidate_batch(
            workspace,
            source_commit_id=commit["commit_id"],
            candidate_split_manifests=self._v5_release_manifests(commit["stage"]),
        )
        state = LEDGER._load_workspace(workspace)
        normalized_commit = state["v5_commits_by_id"][commit["commit_id"]]
        normalized_release = state["v5_releases_by_commit_id"][commit["commit_id"]]
        tasks = state["v5_candidate_tasks_by_release_id"][release["release_id"]]
        decisions, audits = LEDGER.v5_deriver.derive_all(
            tasks,
            normalized_commit["annotations"],
            release=normalized_release,
        )
        return release, decisions, audits

    def _submit_v5_stage(
        self, workspace: Path, *, stage: str, reviewer: str
    ) -> list[dict]:
        annotations = self._v5_source_annotations(
            workspace, stage=stage, reviewer=reviewer
        )
        commit = LEDGER.commit_source_annotations(
            workspace,
            stage=stage,
            reviewer=reviewer,
            source_annotations=annotations,
        )
        _, decisions, audits = self._v5_release_and_derive(workspace, commit=commit)
        return LEDGER.submit_decisions(
            workspace,
            stage=stage,
            reviewer=reviewer,
            decisions=decisions,
            derivation_audits=audits,
        )

    def _complete_v5_calibration(self) -> Path:
        workspace = self.root / "v5-calibration-workspace"
        self.fixture.init(
            workspace,
            mode="calibration",
            calibration_sample_ids=[self.fixture.sample_ids[0]],
            v5=True,
        )
        self._submit_v5_stage(workspace, stage="primary", reviewer="v5-cal-primary")
        self._submit_v5_stage(workspace, stage="secondary", reviewer="v5-cal-secondary")
        report = LEDGER.finalize_workspace(
            workspace, resolver="v5-calibration-resolver"
        )
        self.assertTrue(report["all_gates_pass"])
        return workspace / "calibration-report.json"

    def test_direct_script_cli_imports_deriver_without_module_mode(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("commit-source", completed.stdout)

    def test_v5_forbids_card_file_verification_bypass(self) -> None:
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "forbids --skip-card-files"
        ):
            self.fixture.init(
                self.root / "v5-skip-workspace",
                mode="production",
                v5=True,
                verify_card_files=False,
            )

    def test_verified_state_validation_report_matches_public_wrapper(self) -> None:
        workspace = self.root / "v5-validation-state-equivalence"
        self.fixture.init(workspace, mode="production", v5=True)
        self._submit_v5_stage(
            workspace, stage="primary", reviewer="validation-equivalence-primary"
        )

        verified_state = LEDGER._load_workspace(workspace)
        from_verified_state = LEDGER._validate_workspace_state(
            verified_state, require_complete=False
        )
        from_public_wrapper = LEDGER.validate_workspace(
            workspace, require_complete=False
        )

        self.assertEqual(from_public_wrapper, from_verified_state)
        self.assertEqual(
            LEDGER.canonical_json_bytes(from_public_wrapper, pretty=True),
            LEDGER.canonical_json_bytes(from_verified_state, pretty=True),
        )

    def test_v5_rubric_detection_is_content_bound_not_filename_bound(self) -> None:
        canonical = ROOT / "docs" / "font-matching-v2-review-rubric-v5.md"
        renamed = self.root / "anonymous-review-contract.md"
        renamed.write_bytes(canonical.read_bytes())
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "forbids --skip-card-files"
        ):
            self.fixture.init(
                self.root / "renamed-v5-skip",
                mode="production",
                v5=True,
                verify_card_files=False,
                rubric=renamed,
            )
        workspace = self.root / "renamed-v5"
        self.fixture.init(workspace, mode="production", v5=True, rubric=renamed)
        self.assertTrue(
            LEDGER.read_json(workspace / "contract.json")["v5_derivation_required"]
        )

        altered = self.root / "altered-review-contract.md"
        altered.write_text(
            canonical.read_text(encoding="utf-8") + "\ncontent drift\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "v5 rubric content SHA"):
            self.fixture.init(
                self.root / "altered-v5",
                mode="production",
                v5=True,
                rubric=altered,
            )

    def test_v5_decodes_pngs_and_rejects_forged_split_bytes(self) -> None:
        manifest_path = self.fixture.primary_split / "manifest.json"
        manifest = LEDGER.read_json(manifest_path)
        descriptor = manifest["cards"][0]["source_only"]
        source_path = self.fixture.primary_split / descriptor["file"]
        source_path.write_bytes(b"this-is-not-a-png")
        descriptor["sha256"] = LEDGER.sha256_file(source_path)
        descriptor["pixel_sha256"] = "0" * 64
        write_json(manifest_path, LEDGER.seal(manifest))

        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "not a decodable image"):
            self.fixture.init(
                self.root / "v5-forged-image-workspace",
                mode="production",
                v5=True,
            )

    def test_v5_rejects_valid_png_that_no_longer_rejoins_full_card(self) -> None:
        fixture = Fixture(self.root / "valid-png-rejoin")
        manifest_path = fixture.primary_split / "manifest.json"
        manifest = LEDGER.read_json(manifest_path)
        descriptor = manifest["cards"][0]["source_only"]
        source_path = fixture.primary_split / descriptor["file"]
        with Image.open(source_path) as opened:
            image = opened.convert("RGB")
        image.putpixel((0, 0), (255, 0, 255))
        image.save(source_path, format="PNG")
        descriptor["sha256"] = LEDGER.sha256_file(source_path)
        descriptor["pixel_sha256"] = LEDGER._v5_pixel_sha256(image)
        write_json(manifest_path, LEDGER.seal(manifest))

        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "lossless.*rejoin failed"):
            fixture.init(
                self.root / "v5-valid-png-rejoin-workspace",
                mode="production",
                v5=True,
            )

    def test_v5_public_ids_are_fresh_and_do_not_reuse_source_ids(self) -> None:
        first = self.root / "v5-public-first"
        second = self.root / "v5-public-second"
        self.fixture.init(first, mode="production", v5=True)
        self.fixture.init(second, mode="production", v5=True)
        first_tasks = LEDGER.read_jsonl(first / "blind-tasks.jsonl")
        second_tasks = LEDGER.read_jsonl(second / "blind-tasks.jsonl")
        source_assignment_ids = {
            assignment["assignment_id"]
            for assignment in self.fixture.assignments.values()
        }
        source_sample_ids = set(self.fixture.sample_ids)
        self.assertTrue(
            source_assignment_ids.isdisjoint(
                {str(task["assignment_id"]) for task in first_tasks}
            )
        )
        self.assertTrue(
            source_sample_ids.isdisjoint(
                {str(task["sample_id"]) for task in first_tasks}
            )
        )
        self.assertTrue(
            {str(task["assignment_id"]) for task in first_tasks}.isdisjoint(
                {str(task["assignment_id"]) for task in second_tasks}
            )
        )
        self.assertTrue(
            {str(task["sample_id"]) for task in first_tasks}.isdisjoint(
                {str(task["sample_id"]) for task in second_tasks}
            )
        )

    def test_v5_init_materializes_only_exact_source_surface_before_release(
        self,
    ) -> None:
        workspace = self.root / "v5-source-only-boundary"
        self.fixture.init(workspace, mode="production", v5=True)
        tasks = LEDGER.read_jsonl(workspace / "blind-tasks.jsonl")
        self.assertTrue(tasks)
        for index, task in enumerate(tasks):
            self.assertEqual(LEDGER.v5_deriver.SOURCE_TASK_KEYS, set(task))
            LEDGER.v5_deriver.validate_source_task(task, f"source-task[{index}]")
            with self.assertRaises(LEDGER.v5_deriver.DerivationError):
                LEDGER.v5_deriver.validate_task(task, f"candidate-task[{index}]")
        for binding in LEDGER.read_jsonl(workspace / "private-bindings.jsonl"):
            self.assertEqual(
                {
                    "assignment_id",
                    "sample_id",
                    "work_id",
                    "source_page_sha256",
                    "stage",
                    "review_order",
                },
                set(binding["assignment"]),
            )
            self.assertEqual(
                {
                    "assignment_id",
                    "sample_id",
                    "stage",
                    "review_card_sha256",
                    "review_card_file",
                    "v5_public_ids",
                    "v5_source_card",
                },
                set(binding["card"]),
            )
            self.assertNotIn("alias_to_candidate_id", binding)
        contract = LEDGER.read_json(workspace / "contract.json")
        for stage in ("primary", "secondary"):
            for section in ("card_manifests", "split_card_manifests"):
                for value in contract[section][stage]:
                    self.assertEqual({"sha256", "byte_size"}, set(value))
        self.assertFalse((workspace / "candidate-tasks").exists())
        self.assertFalse((workspace / "candidate-surfaces").exists())
        serialized = b"".join(
            path.read_bytes() for path in workspace.rglob("*") if path.is_file()
        )
        for forbidden in (
            b'"blind_alias_order"',
            b'"mandatory_unrenderable"',
            b'"full_card_sha256"',
            b'"candidate_only_card_sha256"',
        ):
            self.assertNotIn(forbidden, serialized)

    def test_v5_release_nonce_changes_actual_b_pixels_names_and_batch_order(
        self,
    ) -> None:
        snapshots: list[dict] = []
        input_manifest = LEDGER.read_json(self.fixture.primary_split / "manifest.json")
        input_candidate_pixel_shas = {
            row["candidate_only"]["pixel_sha256"] for row in input_manifest["cards"]
        }
        input_candidate_file_shas = {
            row["candidate_only"]["sha256"] for row in input_manifest["cards"]
        }
        for suffix in ("first", "second"):
            workspace = self.root / f"v5-release-fresh-{suffix}"
            self.fixture.init(workspace, mode="production", v5=True)
            annotations = self._v5_source_annotations(
                workspace, stage="primary", reviewer=f"reviewer-{suffix}"
            )
            commit = LEDGER.commit_source_annotations(
                workspace,
                stage="primary",
                reviewer=f"reviewer-{suffix}",
                source_annotations=annotations,
            )
            release, _, _ = self._v5_release_and_derive(workspace, commit=commit)
            task_path = workspace / "candidate-tasks" / f"{release['release_id']}.jsonl"
            surface_path = (
                workspace
                / "candidate-surfaces"
                / release["release_id"]
                / "manifest.json"
            )
            tasks = LEDGER.read_jsonl(task_path)
            surface = LEDGER.read_json(surface_path)
            self.assertEqual(
                list(range(len(tasks))),
                [task["candidate_batch_order"] for task in tasks],
            )
            for task in tasks:
                self.assertEqual(task["review_order"], task["candidate_batch_order"])
                self.assertEqual(
                    LEDGER.v5_deriver.release_alias_order(
                        release["release_nonce_sha256"], task["assignment_id"]
                    ),
                    task["blind_alias_order"],
                )
            candidate_descriptors = [
                row["candidate_only"] for row in surface["entries"]
            ]
            self.assertTrue(
                input_candidate_pixel_shas.isdisjoint(
                    {row["pixel_sha256"] for row in candidate_descriptors}
                )
            )
            self.assertTrue(
                input_candidate_file_shas.isdisjoint(
                    {row["sha256"] for row in candidate_descriptors}
                )
            )
            snapshots.append(
                {
                    "nonce": release["release_nonce_sha256"],
                    "aliases": [
                        entry["blind_alias_order"] for entry in release["entries"]
                    ],
                    "seeds": [
                        entry["candidate_order_seed"] for entry in release["entries"]
                    ],
                    "task_sha": LEDGER.sha256_file(task_path),
                    "candidate_file_names": [
                        Path(row["file"]).name for row in candidate_descriptors
                    ],
                    "candidate_file_shas": [
                        row["sha256"] for row in candidate_descriptors
                    ],
                    "candidate_pixel_shas": [
                        row["pixel_sha256"] for row in candidate_descriptors
                    ],
                }
            )
        first, second = snapshots
        for key in (
            "nonce",
            "aliases",
            "seeds",
            "task_sha",
            "candidate_file_names",
            "candidate_file_shas",
            "candidate_pixel_shas",
        ):
            self.assertNotEqual(first[key], second[key], key)

    def test_v5_production_permanently_excludes_prior_calibration_closure(
        self,
    ) -> None:
        self.fixture.set_source_split("train")
        excluded = self.fixture.sample_ids[0]
        prior = self._prior_train_subset([excluded], "prior-v5-round")
        workspace = self.root / "v5-prior-exclusion"
        self.fixture.init(
            workspace,
            mode="production",
            v5=True,
            prior_calibration_subsets=[prior],
        )
        bindings = LEDGER.read_jsonl(workspace / "private-bindings.jsonl")
        self.assertEqual(
            {self.fixture.sample_ids[1]}, {row["sample_id"] for row in bindings}
        )
        report = LEDGER.validate_workspace(workspace, require_complete=False)
        self.assertEqual(1, report["expected_review_counts"]["primary"])

    def test_v5_requires_canonical_master_split_map_binding(self) -> None:
        source_report_path = self.fixture.rescue / "report.json"
        source_report = LEDGER.read_json(source_report_path)
        source_report["inputs"].pop("master_split_map_sha256")
        write_json(source_report_path, source_seal(source_report))
        audit_report_path = self.fixture.audit / "report.json"
        audit_report = LEDGER.read_json(audit_report_path)
        audit_report["inputs"]["source_report_file_sha256"] = LEDGER.sha256_file(
            source_report_path
        )
        audit_report["inputs"]["source_report_record_sha256"] = LEDGER.read_json(
            source_report_path
        )["record_sha256"]
        write_json(audit_report_path, LEDGER.seal(audit_report))

        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "master_split_map_sha256"):
            self.fixture.init(
                self.root / "v5-missing-split-map",
                mode="production",
                v5=True,
            )

    def test_v5_uses_declared_work_split_not_legacy_view_storage(self) -> None:
        master_path = self.fixture.rescue / "master.jsonl"
        master_rows = LEDGER.read_jsonl(master_path)
        for row in master_rows:
            row["split"] = "train"
            row["legacy_split"] = "val"
        write_jsonl(master_path, master_rows)

        split_map = LEDGER.read_json(self.fixture.master_split_map)
        split_map["work_assignments"] = {
            work_id: "train" for work_id in self.fixture.work_ids
        }
        for component in split_map["components"]:
            component["split"] = "train"
        write_json(self.fixture.master_split_map, split_map)

        source_report_path = self.fixture.rescue / "report.json"
        source_report = LEDGER.read_json(source_report_path)
        source_report["outputs"]["master_sha256"] = LEDGER.sha256_file(master_path)
        source_report["inputs"]["master_split_map_sha256"] = LEDGER.sha256_file(
            self.fixture.master_split_map
        )
        write_json(source_report_path, source_seal(source_report))
        audit_report_path = self.fixture.audit / "report.json"
        audit_report = LEDGER.read_json(audit_report_path)
        audit_report["inputs"]["source_report_file_sha256"] = LEDGER.sha256_file(
            source_report_path
        )
        audit_report["inputs"]["source_report_record_sha256"] = LEDGER.read_json(
            source_report_path
        )["record_sha256"]
        write_json(audit_report_path, LEDGER.seal(audit_report))

        workspace = self.root / "v5-declared-split"
        self.fixture.init(workspace, mode="production", v5=True)
        state = LEDGER._load_workspace(workspace)
        self.assertEqual({"train"}, set(state["source"]["split_by_sample"].values()))
        self.assertEqual(
            {"val"}, set(state["source"]["storage_split_by_sample"].values())
        )

    def test_v5_finalize_is_provisional_and_never_activates_delta_fonts(
        self,
    ) -> None:
        calibration = self._complete_v5_calibration()
        workspace = self.root / "v5-pruned-production"
        self.fixture.init(
            workspace,
            mode="production",
            prior_calibration_subsets=[calibration.parent / "calibration-subset.json"],
            v5=True,
        )
        self._submit_v5_stage(
            workspace, stage="primary", reviewer="v5-production-primary"
        )
        self._submit_v5_stage(
            workspace, stage="secondary", reviewer="v5-production-secondary"
        )
        report = LEDGER.finalize_workspace(
            workspace,
            resolver="v5-production-resolver",
            calibration_report_path=calibration,
        )
        disposition = LEDGER.read_json(workspace / "catalog-disposition.json")
        provisional_catalog = LEDGER.read_json(workspace / "provisional-catalog.json")

        self.assertEqual("provisional_not_released", report["release_state"])
        self.assertFalse(report["final_release_allowed"])
        self.assertEqual(7, disposition["candidate_count"])
        self.assertGreater(disposition["safe_zero_candidate_count"], 0)
        self.assertEqual([], disposition["included_aliases"])
        self.assertTrue(disposition["all_candidates_non_active"])
        safe_zero_entries = [
            entry
            for entry in disposition["entries"]
            if entry["action"] == LEDGER.V5_SAFE_ZERO_ACTION
        ]
        self.assertEqual(
            disposition["safe_zero_candidate_count"], len(safe_zero_entries)
        )
        self.assertTrue(
            all(
                entry["safe_count"] == 0
                and entry["deployable_opportunity_count"] > 0
                and entry["terminal"] is False
                and entry["active_release_eligible"] is False
                and entry["replacement_state"] == "pending_fresh_blind_v5_round"
                for entry in safe_zero_entries
            )
        )
        deployment_failures = [
            entry
            for entry in disposition["entries"]
            if entry["action"] == LEDGER.V5_DEPLOYMENT_FAILURE_ACTION
        ]
        self.assertEqual(
            disposition["deployment_failure_candidate_count"],
            len(deployment_failures),
        )
        self.assertTrue(
            all(
                entry["all_unrenderable"] is True
                and entry["deployable_opportunity_count"] == 0
                and entry["terminal"] is False
                for entry in deployment_failures
            )
        )
        self.assertEqual(0, provisional_catalog["active_delta_candidate_count"])
        self.assertFalse((workspace / "final-catalog.json").exists())
        self.assertFalse((workspace / "final-labels-catalog.jsonl").exists())
        self.assertFalse((workspace / "merge-report.json").exists())

        tampered = dict(disposition)
        tampered["safe_zero_candidate_count"] = 0
        write_json(workspace / "catalog-disposition.json", LEDGER.seal(tampered))
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "provisional catalog disposition changed"
        ):
            LEDGER.validate_workspace(workspace, require_complete=True)

        write_json(workspace / "catalog-disposition.json", disposition)
        write_json(workspace / "final-catalog.json", {"forged": True})
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "forbidden final-release artifact"
        ):
            LEDGER.validate_workspace(workspace, require_complete=True)

    def test_v5_fresh_calibration_closure_cannot_reenter_production(self) -> None:
        calibration_path = self._complete_v5_calibration()
        workspace = self.root / "v5-unexcluded-calibration-production"
        self.fixture.init(workspace, mode="production", v5=True)
        state = LEDGER._load_workspace(workspace)
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "calibration leakage closure overlaps"
        ):
            LEDGER._validate_calibration_report(
                LEDGER.read_json(calibration_path), state
            )

    def test_v5_adjudication_source_commit_must_cover_whole_triggered_batch(
        self,
    ) -> None:
        workspace = self.root / "v5-whole-adjudication-batch"
        self.fixture.init(workspace, mode="production", v5=True)
        self._submit_v5_stage(
            workspace, stage="primary", reviewer="v5-primary-reviewer"
        )

        secondary_annotations = self._v5_source_annotations(
            workspace, stage="secondary", reviewer="v5-secondary-reviewer"
        )
        for index, annotation in enumerate(secondary_annotations):
            annotation["role_evidence"]["whisper"] = True
            secondary_annotations[index] = LEDGER.v5_deriver.seal_record(annotation)
        secondary_commit = LEDGER.commit_source_annotations(
            workspace,
            stage="secondary",
            reviewer="v5-secondary-reviewer",
            source_annotations=secondary_annotations,
        )
        _, secondary_decisions, secondary_audits = self._v5_release_and_derive(
            workspace, commit=secondary_commit
        )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="v5-secondary-reviewer",
            decisions=secondary_decisions,
            derivation_audits=secondary_audits,
        )
        validation = LEDGER.validate_workspace(workspace, require_complete=False)
        self.assertEqual(2, validation["pending_adjudication_count"])

        adjudication_annotations = self._v5_source_annotations(
            workspace, stage="adjudication", reviewer="v5-adjudicator"
        )
        wrong_sources = json.loads(json.dumps(adjudication_annotations))
        wrong_sources[0]["source_review_record_sha256s"].reverse()
        wrong_sources[0] = LEDGER.v5_deriver.seal_record(wrong_sources[0])
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "adjudication A source reviews changed"
        ):
            LEDGER.commit_source_annotations(
                workspace,
                stage="adjudication",
                reviewer="v5-adjudicator",
                source_annotations=wrong_sources,
            )
        adjudication_tasks = [
            LEDGER.v5_deriver.validate_source_task(
                LEDGER._v5_task_for_stage(task, "adjudication"),
                f"adjudication-task[{index}]",
            )
            for index, task in enumerate(
                task
                for task in LEDGER.read_jsonl(workspace / "blind-tasks.jsonl")
                if task["stage"] == "primary"
            )
        ]
        partial = dict(adjudication_annotations[0])
        partial["batch_size"] = 1
        partial["batch_task_set_sha256"] = LEDGER.v5_deriver.task_batch_sha256(
            [adjudication_tasks[0]]
        )
        partial = LEDGER.v5_deriver.seal_record(partial)
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "whole triggered adjudication A batch"
        ):
            LEDGER.commit_source_annotations(
                workspace,
                stage="adjudication",
                reviewer="v5-adjudicator",
                source_annotations=[partial],
            )
        commit = LEDGER.commit_source_annotations(
            workspace,
            stage="adjudication",
            reviewer="v5-adjudicator",
            source_annotations=adjudication_annotations,
        )
        self.assertEqual(2, commit["batch_size"])
        _, decisions, audits = self._v5_release_and_derive(workspace, commit=commit)
        created = LEDGER.submit_decisions(
            workspace,
            stage="adjudication",
            reviewer="v5-adjudicator",
            decisions=decisions,
            derivation_audits=audits,
        )
        prior_reviews = [
            row
            for row in LEDGER.read_jsonl(workspace / "reviews.jsonl")
            if row["stage"] in {"primary", "secondary"}
        ]
        for review in created:
            expected_shas = [
                row["record_sha256"]
                for source_stage in ("primary", "secondary")
                for row in prior_reviews
                if row["sample_id"] == review["sample_id"]
                and row["stage"] == source_stage
            ]
            self.assertEqual(expected_shas, review["source_review_record_sha256s"])

    def test_v5_ledger_submit_revalidates_audit_annotation_cards_and_safe_cap(
        self,
    ) -> None:
        workspace = self.root / "v5-workspace"
        self.fixture.init(workspace, mode="production", v5=True)
        annotations = self._v5_source_annotations(
            workspace, stage="primary", reviewer="v5-primary"
        )
        precomputed_decisions = [
            {"assignment_id": annotation["assignment_id"]} for annotation in annotations
        ]
        precomputed_audits = [
            {"assignment_id": annotation["assignment_id"]} for annotation in annotations
        ]
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "requires sealed"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                decisions=precomputed_decisions,
            )

        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "simultaneous"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                decisions=precomputed_decisions,
                derivation_audits=precomputed_audits,
                source_annotations=annotations,
            )

        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "task-set seal|whole assigned"
        ):
            LEDGER.commit_source_annotations(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                source_annotations=annotations[:1],
            )

        tampered_annotations = json.loads(json.dumps(annotations))
        tampered_annotations[0]["source_only_card_sha256"] = "f" * 64
        tampered_annotations[0] = LEDGER.v5_deriver.seal_record(tampered_annotations[0])
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "sealed task"):
            LEDGER.commit_source_annotations(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                source_annotations=tampered_annotations,
            )

        commit = LEDGER.commit_source_annotations(
            workspace,
            stage="primary",
            reviewer="v5-primary",
            source_annotations=annotations,
        )
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "not been released"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                decisions=precomputed_decisions,
                derivation_audits=precomputed_audits,
            )
        release, decisions, audits = self._v5_release_and_derive(
            workspace, commit=commit
        )
        self.assertEqual(commit["commit_id"], release["source_commit_id"])

        tampered_decisions = json.loads(json.dumps(decisions))
        judgment = tampered_decisions[0]["font_judgment"]
        judgment["preferred"] = list(self.fixture.aliases)
        for tier in ("acceptable", "marginal", "unacceptable", "unrenderable"):
            judgment[tier] = []
        judgment["none_acceptable"] = False
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "deterministic v5 derivation"
        ):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                decisions=tampered_decisions,
                derivation_audits=audits,
            )

        tampered_audits = json.loads(json.dumps(audits))
        tampered_audits[0]["safe_count"] = 3
        tampered_audits[0] = LEDGER.v5_deriver.seal_record(tampered_audits[0])
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "tampered"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="v5-primary",
                decisions=decisions,
                derivation_audits=tampered_audits,
            )

        created = LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="v5-primary",
            decisions=decisions,
            derivation_audits=audits,
        )
        self.assertEqual(len(self.fixture.sample_ids), len(created))
        self.assertTrue(all(row["derivation_evidence"] for row in created))
        report = LEDGER.validate_workspace(workspace, require_complete=False)
        self.assertEqual(
            len(self.fixture.sample_ids),
            report["submitted_review_counts"]["primary"],
        )

    def _complete_calibration(self) -> Path:
        workspace = self.root / "calibration-workspace"
        self.fixture.init(workspace, mode="calibration")
        LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="cal-primary",
            decisions=[
                self.fixture.decision(sample_id, "primary")
                for sample_id in self.fixture.sample_ids
            ],
        )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="cal-secondary",
            decisions=[
                self.fixture.decision(sample_id, "secondary")
                for sample_id in self.fixture.sample_ids
            ],
        )
        report = LEDGER.finalize_workspace(workspace, resolver="cal-resolver")
        self.assertTrue(report["all_gates_pass"])
        return workspace / "calibration-report.json"

    def _prior_train_subset(self, sample_ids: list[str], name: str) -> Path:
        quarantine = sorted(sample_ids)
        path = self.root / f"{name}.json"
        write_json(
            path,
            LEDGER.seal(
                {
                    "schema_version": LEDGER.SCHEMA_VERSION,
                    "record_type": "font_catalog_delta_calibration_subset",
                    "round_id": name,
                    "selection_method": "explicit_sealed_sample_ids",
                    "selection_seed": None,
                    "development_only": True,
                    "source_split": "train",
                    "test_split_forbidden": True,
                    "training_quarantine_required": True,
                    "training_quarantine_sample_ids": quarantine,
                    "training_quarantine_sample_ids_sha256": (
                        LEDGER.sha256_bytes(LEDGER.canonical_json_bytes(quarantine))
                    ),
                    "split_visible_on_review_surface": False,
                    "sample_count": len(sample_ids),
                    "sample_ids": sample_ids,
                }
            ),
        )
        return path

    def test_full_merge_preserves_old_tiers_and_requires_adjudication(self) -> None:
        calibration = self._complete_calibration()
        workspace = self.root / "production-workspace"
        self.fixture.init(workspace, mode="production")
        LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="primary-reviewer",
            decisions=[
                self.fixture.decision(sample_id, "primary")
                for sample_id in self.fixture.sample_ids
            ],
        )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="secondary-reviewer",
            decisions=[
                self.fixture.decision(self.fixture.sample_ids[0], "secondary"),
                self.fixture.decision(
                    self.fixture.sample_ids[1], "secondary", disagreement=True
                ),
            ],
        )
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "incomplete"):
            LEDGER.finalize_workspace(
                workspace,
                resolver="merge-resolver",
                calibration_report_path=calibration,
            )
        LEDGER.submit_decisions(
            workspace,
            stage="adjudication",
            reviewer="independent-adjudicator",
            decisions=[self.fixture.decision(self.fixture.sample_ids[1], "primary")],
        )
        report = LEDGER.finalize_workspace(
            workspace,
            resolver="merge-resolver",
            calibration_report_path=calibration,
        )
        self.assertEqual(2, report["summary"]["merged_sample_count"])
        self.assertEqual(0, report["summary"]["old_tier_mutation_count"])
        finals = LEDGER.read_jsonl(workspace / "final-labels-22.jsonl")
        self.assertEqual(2, len(finals))
        for final in finals:
            judgment = final["font_judgment"]
            self.assertEqual(self.fixture.old_ids[:1], judgment["preferred"][:1])
            candidates = {
                item for tier in LEDGER.ALL_FINAL_TIERS for item in judgment[tier]
            }
            self.assertEqual(22, len(candidates))
            self.assertFalse(judgment["not_reviewed"])
            LABELS.validate_final_record(
                final,
                candidate_ids=[*self.fixture.old_ids, *self.fixture.font_ids],
            )

    def test_decision_must_partition_aliases_and_bind_card(self) -> None:
        workspace = self.root / "workspace"
        self.fixture.init(workspace, mode="production")
        decision = self.fixture.decision(self.fixture.sample_ids[0], "primary")
        decision["font_judgment"]["marginal"].pop()
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "tier all seven"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="reviewer-a",
                decisions=[decision],
            )
        leaked = self.fixture.decision(self.fixture.sample_ids[0], "primary")
        leaked["rationale"] = "delta-font-1 후보 이름을 보았다고 잘못 기록한 판정이다."
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "identity"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="reviewer-a",
                decisions=[leaked],
            )
        wrong_card = self.fixture.decision(self.fixture.sample_ids[0], "primary")
        wrong_card["review_card_sha256"] = "0" * 64
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "sealed task"):
            LEDGER.submit_decisions(
                workspace,
                stage="primary",
                reviewer="reviewer-a",
                decisions=[wrong_card],
            )

    def test_secondary_and_adjudicator_independence_are_enforced(self) -> None:
        workspace = self.root / "workspace"
        self.fixture.init(workspace, mode="production")
        sample_id = self.fixture.sample_ids[0]
        LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="same-reviewer",
            decisions=[self.fixture.decision(sample_id, "primary", none=True)],
        )
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "independent"):
            LEDGER.submit_decisions(
                workspace,
                stage="secondary",
                reviewer="same-reviewer",
                decisions=[self.fixture.decision(sample_id, "secondary", none=True)],
            )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="secondary-reviewer",
            decisions=[self.fixture.decision(sample_id, "secondary", none=True)],
        )
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "independent"):
            LEDGER.submit_decisions(
                workspace,
                stage="adjudication",
                reviewer="same-reviewer",
                decisions=[self.fixture.decision(sample_id, "primary")],
            )

    def test_production_finalize_requires_fresh_bound_calibration(self) -> None:
        workspace = self.root / "workspace"
        self.fixture.init(workspace, mode="production")
        LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="primary-reviewer",
            decisions=[
                self.fixture.decision(sample_id, "primary")
                for sample_id in self.fixture.sample_ids
            ],
        )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="secondary-reviewer",
            decisions=[
                self.fixture.decision(sample_id, "secondary")
                for sample_id in self.fixture.sample_ids
            ],
        )
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "calibration-report"):
            LEDGER.finalize_workspace(workspace, resolver="merge-resolver")
        calibration = self._complete_calibration()
        tampered = json.loads(calibration.read_text())
        tampered["overall"]["acceptable_set_jaccard"] = 0.0
        write_json(calibration, LEDGER.seal(tampered))
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "gate calculation"):
            LEDGER.finalize_workspace(
                workspace,
                resolver="merge-resolver",
                calibration_report_path=calibration,
            )

    def test_init_rejects_card_manifest_identity_leak(self) -> None:
        manifest_path = self.fixture.primary_cards / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["cards"][0]["candidates"][0]["font_id"] = self.fixture.font_ids[0]
        write_json(manifest_path, manifest)
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "blind surface"):
            self.fixture.init(self.root / "workspace", mode="production")

    def test_new_font_signal_false_negative_is_fail_closed(self) -> None:
        calibration = self._complete_calibration()
        workspace = self.root / "workspace"
        self.fixture.init(workspace, mode="production")
        excluded, kept = self.fixture.sample_ids
        LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="primary-reviewer",
            decisions=[
                self.fixture.decision(
                    excluded,
                    "primary",
                    eligibility="font_signal_absent",
                ),
                self.fixture.decision(kept, "primary"),
            ],
        )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="secondary-reviewer",
            decisions=[self.fixture.decision(kept, "secondary")],
        )
        invalid = self.fixture.decision(
            excluded, "secondary", eligibility="crop_needs_review"
        )
        invalid["font_judgment"] = {
            "preferred": self.fixture.aliases,
            "acceptable": [],
            "marginal": [],
            "unacceptable": [],
            "unrenderable": [],
            "none_acceptable": False,
        }
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "forbids all candidate tiers"
        ):
            LEDGER.submit_decisions(
                workspace,
                stage="secondary",
                reviewer="secondary-reviewer",
                decisions=[invalid],
            )
        report = LEDGER.finalize_workspace(
            workspace,
            resolver="merge-resolver",
            calibration_report_path=calibration,
        )
        self.assertEqual(1, report["summary"]["new_font_signal_exception_count"])
        self.assertEqual(1, len(LEDGER.read_jsonl(workspace / "final-labels-22.jsonl")))
        exceptions = LEDGER.read_jsonl(workspace / "eligibility-exceptions.jsonl")
        self.assertEqual(excluded, exceptions[0]["sample_id"])
        self.assertFalse(exceptions[0]["assignment_gate"]["candidate_tiering_allowed"])

    def test_deterministic_calibration_subset_is_val_only_and_exported(self) -> None:
        first = self.root / "cal-a"
        second = self.root / "cal-b"
        kwargs = {
            "rescue_inputs": self.fixture.rescue,
            "font_signal_audit": self.fixture.audit,
            "primary_card_manifests": [self.fixture.primary_cards / "manifest.json"],
            "secondary_card_manifests": [
                self.fixture.secondary_cards / "manifest.json"
            ],
            "rubric": ROOT / "docs" / "font-matching-v2-review-rubric.md",
            "mode": "calibration",
            "calibration_round_id": "fresh-deterministic-round",
            "calibration_count": 1,
            "calibration_seed": "frozen-calibration-seed-v1",
        }
        LEDGER.initialize_workspace(workspace=first, **kwargs)
        LEDGER.initialize_workspace(workspace=second, **kwargs)
        subset_a = LEDGER.read_json(first / "calibration-subset.json")
        subset_b = LEDGER.read_json(second / "calibration-subset.json")
        self.assertEqual(subset_a["sample_ids"], subset_b["sample_ids"])
        self.assertEqual(
            "deterministic_val_role_work_balanced_v1", subset_a["selection_method"]
        )
        self.assertEqual(1, subset_a["sample_count"])
        self.assertEqual(1, len(LEDGER.read_jsonl(first / "blind-tasks-primary.jsonl")))
        self.assertEqual(
            1, len(LEDGER.read_jsonl(first / "blind-tasks-secondary.jsonl"))
        )

    def test_failed_calibration_is_scored_before_adjudication_and_locks_none_bias(
        self,
    ) -> None:
        workspace = self.root / "failed-calibration"
        self.fixture.init(workspace, mode="calibration")
        LEDGER.submit_decisions(
            workspace,
            stage="primary",
            reviewer="calibration-primary",
            decisions=[
                self.fixture.decision(
                    sample_id,
                    "primary",
                    none=index == 0,
                )
                for index, sample_id in enumerate(self.fixture.sample_ids)
            ],
        )
        LEDGER.submit_decisions(
            workspace,
            stage="secondary",
            reviewer="calibration-secondary",
            decisions=[
                self.fixture.decision(sample_id, "secondary")
                for sample_id in self.fixture.sample_ids
            ],
        )
        validation = LEDGER.validate_workspace(workspace)
        self.assertGreater(validation["pending_adjudication_count"], 0)
        with self.assertRaisesRegex(
            LEDGER.CalibrationGateError, "fresh calibration failed"
        ):
            LEDGER.finalize_workspace(workspace, resolver="calibration-resolver")
        report = LEDGER.read_json(workspace / "calibration-report.json")
        self.assertFalse(report["all_gates_pass"])
        self.assertFalse(report["gates"]["none_acceptable_agreement"])
        self.assertEqual(0.5, report["overall"]["none_acceptable_agreement"])
        self.assertEqual(0, validation["adjudication_count"])

    def test_train_calibration_reservoir_is_sealed_and_exported_as_quarantine(
        self,
    ) -> None:
        self.fixture.set_source_split("train")
        rejected = self.root / "cal-rejected"
        with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "split mismatch"):
            self.fixture.init(rejected, mode="calibration")

        calibration_workspace = self.root / "cal-train-quarantine"
        self.fixture.init(
            calibration_workspace,
            mode="calibration",
            calibration_reservoir="train_quarantine",
        )
        subset = LEDGER.read_json(calibration_workspace / "calibration-subset.json")
        self.assertEqual("train", subset["source_split"])
        self.assertTrue(subset["training_quarantine_required"])
        for stage, reviewer in (
            ("primary", "train-cal-primary"),
            ("secondary", "train-cal-secondary"),
        ):
            LEDGER.submit_decisions(
                calibration_workspace,
                stage=stage,
                reviewer=reviewer,
                decisions=[
                    self.fixture.decision(sample_id, stage)
                    for sample_id in self.fixture.sample_ids
                ],
            )
        calibration_report = LEDGER.finalize_workspace(
            calibration_workspace, resolver="train-cal-resolver"
        )
        self.assertTrue(calibration_report["all_gates_pass"])
        self.assertEqual(
            sorted(self.fixture.sample_ids),
            calibration_report["training_quarantine_sample_ids"],
        )
        self.assertFalse(calibration_report["test_split_used"])

        production_workspace = self.root / "production-after-train-cal"
        self.fixture.init(production_workspace, mode="production")
        for stage, reviewer in (
            ("primary", "production-primary"),
            ("secondary", "production-secondary"),
        ):
            LEDGER.submit_decisions(
                production_workspace,
                stage=stage,
                reviewer=reviewer,
                decisions=[
                    self.fixture.decision(sample_id, stage)
                    for sample_id in self.fixture.sample_ids
                ],
            )
        merge = LEDGER.finalize_workspace(
            production_workspace,
            resolver="production-resolver",
            calibration_report_path=(calibration_workspace / "calibration-report.json"),
        )
        self.assertEqual(
            len(self.fixture.sample_ids),
            merge["summary"]["calibration_training_quarantine_count"],
        )
        quarantine = LEDGER.read_json(production_workspace / "training-quarantine.json")
        self.assertEqual(sorted(self.fixture.sample_ids), quarantine["sample_ids"])

    def test_prior_failed_train_round_is_freshness_excluded_and_permanent(
        self,
    ) -> None:
        self.fixture.set_source_split("train")
        prior_sample, fresh_sample = self.fixture.sample_ids
        prior_subset = self._prior_train_subset(
            [prior_sample], "failed-prior-train-round"
        )

        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "prior calibration leakage closure"
        ):
            self.fixture.init(
                self.root / "reused-calibration",
                mode="calibration",
                calibration_reservoir="train_quarantine",
                calibration_sample_ids=[prior_sample],
                prior_calibration_subsets=[prior_subset],
            )

        fresh_workspace = self.root / "fresh-after-failed-round"
        self.fixture.init(
            fresh_workspace,
            mode="calibration",
            calibration_reservoir="train_quarantine",
            calibration_sample_ids=[fresh_sample],
            prior_calibration_subsets=[prior_subset],
        )
        subset = LEDGER.read_json(fresh_workspace / "calibration-subset.json")
        self.assertEqual([fresh_sample], subset["sample_ids"])
        self.assertEqual(1, subset["prior_calibration_subset_count"])
        self.assertEqual(1, subset["prior_training_quarantine_sample_count"])
        for stage, reviewer in (
            ("primary", "fresh-primary"),
            ("secondary", "fresh-secondary"),
        ):
            LEDGER.submit_decisions(
                fresh_workspace,
                stage=stage,
                reviewer=reviewer,
                decisions=[self.fixture.decision(fresh_sample, stage)],
            )
        calibration_report = LEDGER.finalize_workspace(
            fresh_workspace, resolver="fresh-calibration-resolver"
        )
        self.assertTrue(calibration_report["all_gates_pass"])
        self.assertEqual(
            [fresh_sample], calibration_report["training_quarantine_sample_ids"]
        )

        production_workspace = self.root / "production-with-prior-quarantine"
        self.fixture.init(
            production_workspace,
            mode="production",
            prior_calibration_subsets=[prior_subset],
        )
        for stage, reviewer in (
            ("primary", "production-primary"),
            ("secondary", "production-secondary"),
        ):
            LEDGER.submit_decisions(
                production_workspace,
                stage=stage,
                reviewer=reviewer,
                decisions=[
                    self.fixture.decision(sample_id, stage)
                    for sample_id in self.fixture.sample_ids
                ],
            )
        merge = LEDGER.finalize_workspace(
            production_workspace,
            resolver="production-resolver",
            calibration_report_path=fresh_workspace / "calibration-report.json",
        )
        self.assertEqual(2, merge["summary"]["calibration_training_quarantine_count"])
        self.assertEqual(
            1,
            merge["summary"]["prior_calibration_training_quarantine_count"],
        )
        quarantine = LEDGER.read_json(production_workspace / "training-quarantine.json")
        self.assertEqual(sorted(self.fixture.sample_ids), quarantine["sample_ids"])
        self.assertEqual(1, quarantine["prior_round_sample_count"])
        self.assertEqual(1, quarantine["current_round_sample_count"])

    def test_variant_v4_profile_has_exact_quotas_caps_and_is_deterministic(
        self,
    ) -> None:
        source = variant_v4_source()
        kwargs = {
            "source": source,
            "count": 60,
            "seed": "variant-v4-focused-test",
            "source_split": "train",
            "excluded_sample_ids": frozenset(),
        }
        selected_a, audit_a = LEDGER._deterministic_variant_v4_calibration_subset(
            **kwargs
        )
        selected_b, audit_b = LEDGER._deterministic_variant_v4_calibration_subset(
            **kwargs
        )
        self.assertEqual(selected_a, selected_b)
        self.assertEqual(audit_a, audit_b)
        self.assertEqual(60, len(selected_a))
        self.assertEqual(
            LEDGER.VARIANT_V4_STRATA_TARGETS,
            audit_a["strata_achieved"],
        )
        self.assertEqual(
            {key: 0 for key in LEDGER.VARIANT_V4_STRATA_TARGETS},
            audit_a["strata_shortfall"],
        )
        self.assertEqual(
            LEDGER.VARIANT_V4_SELECTION_METHOD,
            audit_a["selection_method"],
        )
        self.assertEqual(
            LEDGER.sha256_bytes(LEDGER.canonical_json_bytes(selected_a)),
            audit_a["selected_sample_ids_ordered_sha256"],
        )

        rows = [
            LEDGER._variant_v4_candidate(source, sample_id) for sample_id in selected_a
        ]
        self.assertNotIn(None, rows)
        by_work: dict[str, list[dict]] = {}
        page_keys: list[str] = []
        for row in rows:
            assert row is not None
            by_work.setdefault(row["work_id"], []).append(row)
            page_keys.append(row["page_key"])
        self.assertEqual(len(page_keys), len(set(page_keys)))
        self.assertLessEqual(max(map(len, by_work.values())), 3)
        for work_rows in by_work.values():
            if len(work_rows) == 3:
                self.assertEqual(
                    3,
                    len({(row["chapter_id"], row["role"]) for row in work_rows}),
                )

    def test_variant_v4_excludes_prior_round_page_and_lineage_closure(self) -> None:
        source = variant_v4_source()
        prior_id = "variant-sample-00-00"
        sibling_id = "variant-sample-00-01"
        source["master"][sibling_id]["page"] = dict(source["master"][prior_id]["page"])
        source["master"][sibling_id]["groups"]["root"] = source["master"][prior_id][
            "groups"
        ]["root"]
        quarantine = sorted(LEDGER._calibration_leakage_closure(source, {prior_id}))
        prior_path = self.root / "variant-prior-subset.json"
        write_json(
            prior_path,
            LEDGER.seal(
                {
                    "schema_version": LEDGER.SCHEMA_VERSION,
                    "record_type": "font_catalog_delta_calibration_subset",
                    "round_id": "variant-prior-round",
                    "selection_method": "explicit_sealed_sample_ids",
                    "selection_seed": None,
                    "development_only": True,
                    "source_split": "train",
                    "test_split_forbidden": True,
                    "training_quarantine_required": True,
                    "training_quarantine_sample_ids": quarantine,
                    "training_quarantine_sample_ids_sha256": LEDGER.sha256_bytes(
                        LEDGER.canonical_json_bytes(quarantine)
                    ),
                    "split_visible_on_review_surface": False,
                    "sample_count": 1,
                    "sample_ids": [prior_id],
                }
            ),
        )
        prior = LEDGER._load_prior_calibration_subsets([prior_path], source=source)
        self.assertTrue({prior_id, sibling_id}.issubset(prior["excluded_sample_ids"]))
        selected, _ = LEDGER._deterministic_variant_v4_calibration_subset(
            source,
            count=60,
            seed="variant-v4-prior-closure-test",
            source_split="train",
            excluded_sample_ids=frozenset(prior["excluded_sample_ids"]),
        )
        self.assertTrue(set(selected).isdisjoint({prior_id, sibling_id}))

    def test_variant_v4_hard_fails_when_exact_stratum_is_infeasible(self) -> None:
        source = variant_v4_source()
        ambient_ids = sorted(
            sample_id
            for sample_id in source["inventory"]
            if LEDGER._variant_v4_stratum(source, sample_id) == "sfx_ambient"
        )
        for sample_id in ambient_ids[3:]:
            source["inventory"].remove(sample_id)
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError,
            "infeasible without quota relaxation.*sfx_ambient",
        ):
            LEDGER._deterministic_variant_v4_calibration_subset(
                source,
                count=60,
                seed="variant-v4-infeasible-test",
                source_split="train",
                excluded_sample_ids=frozenset(),
            )


class CalibrationSupplementContractTests(unittest.TestCase):
    @staticmethod
    def _master(sample_id: str, *, page_sha: str, crop_sha: str) -> dict:
        return {
            "id": sample_id,
            "work": {"id": "work-supplement"},
            "page": {
                "id": f"page-{sample_id}",
                "source_page_sha256": page_sha,
            },
            "sample_crop_sha256": crop_sha,
            "legacy_split": "train",
            "split": "train",
            "provenance": {"synthetic": False, "qa_overlay": False},
        }

    def test_closure_only_rows_never_enter_review_inventory_or_cards(self) -> None:
        sample_id = "fm_supplement"
        sibling_id = "fm_closure_only"
        sample = {
            "schema_version": LEDGER.CALIBRATION_SUPPLEMENT_SCHEMA_VERSION,
            "record_type": "font_matching_calibration_only_supplement_sample",
            "sample_id": sample_id,
            "baseline_label_fields_present": False,
            "candidate_score_or_rank_fields_present": False,
            "training_disposition": LEDGER.CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION,
            "record_sha256": "a" * 64,
        }
        inventory = {"sample_id": sample_id}
        primary = {"assignment_id": "assignment-primary", "sample_id": sample_id}
        secondary = {
            "assignment_id": "assignment-secondary",
            "sample_id": sample_id,
        }
        source = {
            "master": {},
            "split_by_sample": {},
            "storage_split_by_sample": {},
            "selection": {},
            "inventory": {},
            "assignments": {},
            "stages_by_sample": {},
        }
        LEDGER._merge_calibration_only_rows(
            source,
            closure_master={
                sample_id: self._master(
                    sample_id, page_sha="1" * 64, crop_sha="2" * 64
                ),
                sibling_id: self._master(
                    sibling_id, page_sha="1" * 64, crop_sha="3" * 64
                ),
            },
            samples={sample_id: sample},
            inventory={sample_id: inventory},
            assignments={
                primary["assignment_id"]: primary,
                secondary["assignment_id"]: secondary,
            },
            stages_by_sample={sample_id: {"primary": primary, "secondary": secondary}},
        )
        self.assertEqual({sample_id, sibling_id}, set(source["master"]))
        self.assertEqual({sample_id}, set(source["inventory"]))
        self.assertEqual({sample_id}, set(source["selection"]))
        self.assertEqual({sample_id}, set(source["stages_by_sample"]))
        self.assertNotIn(sibling_id, source["inventory"])
        self.assertNotIn(sibling_id, source["selection"])
        self.assertNotIn(sibling_id, source["stages_by_sample"])
        self.assertEqual("train", source["split_by_sample"][sibling_id])

    def test_calibration_selection_has_no_inherited_prior_answer(self) -> None:
        selection = {
            "schema_version": LEDGER.CALIBRATION_SUPPLEMENT_SCHEMA_VERSION,
            "record_type": "font_matching_calibration_only_supplement_sample",
            "baseline_label_fields_present": False,
            "candidate_score_or_rank_fields_present": False,
            "training_disposition": LEDGER.CALIBRATION_SUPPLEMENT_TRAINING_DISPOSITION,
        }
        self.assertIsNone(
            LEDGER._selection_prior_final_record_sha256(
                selection, location="supplement selection"
            )
        )
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "inherited answer field font_judgment"
        ):
            LEDGER._reject_calibration_supplement_answers(
                {"font_judgment": {"preferred": ["leaked-font"]}},
                "supplement",
            )

    def test_sealed_preflight_quarantine_can_strictly_exceed_computed_closure(
        self,
    ) -> None:
        sample_id = "fm_selected"
        sibling_id = "fm_preflight_extra"
        source = {
            "master": {
                sample_id: self._master(
                    sample_id, page_sha="4" * 64, crop_sha="5" * 64
                ),
                sibling_id: self._master(
                    sibling_id, page_sha="6" * 64, crop_sha="7" * 64
                ),
            },
            "split_by_sample": {sample_id: "train", sibling_id: "train"},
            "calibration_only_supplement": {
                "selected_sample_ids": [sample_id],
                "training_quarantine_sample_ids": [sample_id, sibling_id],
            },
        }
        self.assertEqual(
            sorted([sample_id, sibling_id]),
            LEDGER._sealed_calibration_training_quarantine(source, {sample_id}),
        )
        with self.assertRaisesRegex(
            LEDGER.DeltaLedgerError, "exact sealed 60-sample round"
        ):
            LEDGER._sealed_calibration_training_quarantine(source, {sibling_id})

    @staticmethod
    def _authority_row(sample_id: str, index: int, *, split: str = "train") -> dict:
        page_sha = f"{index + 1:064x}"
        crop_sha = f"{index + 1001:064x}"
        return {
            "schema_version": 1,
            "catalog_version": 1,
            "id": sample_id,
            "work": {"id": "work-authority"},
            "chapter": {"id": f"chapter-{index:03d}"},
            "page": {
                "id": f"page-{index:03d}",
                "source_page_sha256": page_sha,
            },
            "geometry": {"bbox_px": [0, 0, 16, 16]},
            "groups": {
                "root": f"root-{index:03d}",
                "variant": f"variant-{index:03d}",
                "normalized_glyph": f"glyph-{index:03d}",
            },
            "provenance": {
                "source_catalog_id": "catalog-a",
                "source_id": f"source-{index:03d}",
                "source_line_sha256": f"{index + 2001:064x}",
                "source_lineage": [],
                "synthetic": False,
                "qa_overlay": False,
            },
            "sample_crop_sha256": crop_sha,
            "views": {
                "context_224": {
                    "catalog_id": "catalog-a",
                    "status": "available",
                    "file_sha256": f"{index + 3001:064x}",
                },
                "raw_224": {
                    "catalog_id": "catalog-a",
                    "status": "derivable",
                    "file_sha256": None,
                    "source_native": {
                        "catalog_id": "catalog-a",
                        "status": "available",
                        "file_sha256": f"{index + 4001:064x}",
                    },
                },
                "glyph_224": {
                    "catalog_id": "catalog-a",
                    "status": "available",
                    "file_sha256": f"{index + 5001:064x}",
                },
            },
            "split": split,
        }

    def _authority_fixture(self, root: Path) -> tuple[dict, dict, set[str], dict]:
        selected = {f"fm_fresh_{index:03d}" for index in range(60)}
        successor_rows = [
            self._authority_row(sample_id, index)
            for index, sample_id in enumerate(sorted(selected))
        ]
        sibling = self._authority_row("fm_fresh_sibling", 100)
        sibling["page"]["source_page_sha256"] = successor_rows[0]["page"][
            "source_page_sha256"
        ]
        successor_rows.append(sibling)
        successor_manifest = root / "successor-master.jsonl"
        write_jsonl(successor_manifest, successor_rows)

        catalog_root = root / "catalog-a"
        catalog_manifest = catalog_root / "manifest.jsonl"
        write_jsonl(catalog_manifest, [{"id": "asset-a"}])
        registry = LEDGER.seal(
            {
                "schema_version": "font-matching-catalog-registry-v1",
                "record_type": "font_matching_catalog_registry",
                "catalogs": [
                    {
                        "catalog_id": "catalog-a",
                        "root": str(catalog_root),
                        "manifest_name": "manifest.jsonl",
                        "manifest_sha256": LEDGER.sha256_file(catalog_manifest),
                    }
                ],
            }
        )
        registry_path = root / "registry.json"
        write_json(registry_path, registry)
        split_path = root / "split.json"
        write_json(
            split_path,
            {"work_assignments": {"work-authority": "train"}},
        )
        selection = LEDGER.seal(
            {
                "schema_version": LEDGER.SCHEMA_VERSION,
                "record_type": LEDGER.SUCCESSOR_AUTHORITY_SELECTION_RECORD_TYPE,
                "round_id": "round-successor",
                "development_only": True,
                "source_authority": "sealed_successor_master_registry_split",
                "sample_count": 60,
                "sample_ids": sorted(selected),
            }
        )
        selection_path = root / "selection.json"
        write_json(selection_path, selection)
        selection_ids, selection_binding = (
            LEDGER._read_successor_authority_selection_manifest(
                selection_path, round_id="round-successor"
            )
        )
        self.assertEqual(selected, selection_ids)
        source_master = {}
        for row in successor_rows[:-1]:
            legacy = json.loads(json.dumps(row))
            legacy.pop("split")
            source_master[row["id"]] = legacy
        source = {
            "master": source_master,
            "split_by_sample": {sample_id: "train" for sample_id in selected},
        }
        supplement = {
            "manifest_record_sha256": "a" * 64,
            "successor_master_manifest_sha256": LEDGER.sha256_file(successor_manifest),
            "successor_catalog_registry_sha256": LEDGER.sha256_file(registry_path),
            "successor_master_split_map_sha256": LEDGER.sha256_file(split_path),
            "_successor_master_manifest_path": successor_manifest,
            "_successor_catalog_registry_path": registry_path,
            "_successor_master_split_map_path": split_path,
        }
        return source, supplement, selected, selection_binding

    def test_successor_authority_binding_uses_full_master_closure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source, supplement, selected, selection_binding = self._authority_fixture(
                root
            )
            binding = LEDGER._successor_authority_only_binding(
                source,
                supplement=supplement,
                selected_ids=selected,
                split_by_sample=source["split_by_sample"],
                predecessor_master=source["master"],
                predecessor_split_by_sample=source["split_by_sample"],
                selection_manifest_binding=selection_binding,
            )
            self.assertEqual(60, binding["selected_sample_count"])
            self.assertEqual(
                61,
                len(binding["successor_training_quarantine_sample_ids"]),
            )
            self.assertIn(
                "fm_fresh_sibling",
                binding["successor_training_quarantine_sample_ids"],
            )
            source["calibration_only_supplement"] = {
                "selected_sample_ids": ["fm_old"],
                "training_quarantine_sample_ids": ["fm_old"],
            }
            self.assertEqual(
                binding["successor_training_quarantine_sample_ids"],
                LEDGER._sealed_calibration_training_quarantine(
                    source,
                    selected,
                    successor_authority_only=binding,
                ),
            )

    def test_successor_authority_rejects_view_and_split_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source, supplement, selected, selection_binding = self._authority_fixture(
                root
            )
            target = sorted(selected)[0]
            source["master"][target]["views"]["glyph_224"]["file_sha256"] = "f" * 64
            with self.assertRaisesRegex(LEDGER.DeltaLedgerError, "view hashes differ"):
                LEDGER._successor_authority_only_binding(
                    source,
                    supplement=supplement,
                    selected_ids=selected,
                    split_by_sample=source["split_by_sample"],
                    predecessor_master=source["master"],
                    predecessor_split_by_sample=source["split_by_sample"],
                    selection_manifest_binding=selection_binding,
                )

            source, supplement, selected, selection_binding = self._authority_fixture(
                root / "split-case"
            )
            split_path = supplement["_successor_master_split_map_path"]
            write_json(
                split_path,
                {"work_assignments": {"work-authority": "test"}},
            )
            supplement["successor_master_split_map_sha256"] = LEDGER.sha256_file(
                split_path
            )
            with self.assertRaisesRegex(
                LEDGER.DeltaLedgerError,
                "split authority|sealed test sample|changed or removed predecessor",
            ):
                LEDGER._successor_authority_only_binding(
                    source,
                    supplement=supplement,
                    selected_ids=selected,
                    split_by_sample=source["split_by_sample"],
                    predecessor_master=source["master"],
                    predecessor_split_by_sample=source["split_by_sample"],
                    selection_manifest_binding=selection_binding,
                )

    def test_successor_authority_accepts_genuine_new_train_work(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source, supplement, selected, selection_binding = self._authority_fixture(
                Path(temp_dir)
            )
            binding = LEDGER._successor_authority_only_binding(
                source,
                supplement=supplement,
                selected_ids=selected,
                split_by_sample=source["split_by_sample"],
                predecessor_master={},
                predecessor_split_by_sample={},
                selection_manifest_binding=selection_binding,
            )
            self.assertEqual(["work-authority"], binding["new_train_work_ids"])

    def test_successor_authority_rejects_new_non_train_work(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source, supplement, selected, selection_binding = self._authority_fixture(
                Path(temp_dir)
            )
            split_path = supplement["_successor_master_split_map_path"]
            write_json(
                split_path,
                {"work_assignments": {"work-authority": "val"}},
            )
            supplement["successor_master_split_map_sha256"] = LEDGER.sha256_file(
                split_path
            )
            with self.assertRaisesRegex(
                LEDGER.DeltaLedgerError, "new successor works must be train-only"
            ):
                LEDGER._successor_authority_only_binding(
                    source,
                    supplement=supplement,
                    selected_ids=selected,
                    split_by_sample=source["split_by_sample"],
                    predecessor_master={},
                    predecessor_split_by_sample={},
                    selection_manifest_binding=selection_binding,
                )

    def test_successor_authority_rejects_predecessor_identity_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source, supplement, selected, selection_binding = self._authority_fixture(
                Path(temp_dir)
            )
            predecessor_master = copy.deepcopy(source["master"])
            target = sorted(selected)[0]
            predecessor_master[target]["views"]["glyph_224"]["file_sha256"] = "e" * 64
            with self.assertRaisesRegex(
                LEDGER.DeltaLedgerError, "predecessor sample identity differs"
            ):
                LEDGER._successor_authority_only_binding(
                    source,
                    supplement=supplement,
                    selected_ids=selected,
                    split_by_sample=source["split_by_sample"],
                    predecessor_master=predecessor_master,
                    predecessor_split_by_sample=source["split_by_sample"],
                    selection_manifest_binding=selection_binding,
                )

    def test_successor_authority_rejects_predecessor_val_lineage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source, supplement, selected, selection_binding = self._authority_fixture(
                Path(temp_dir)
            )
            target = sorted(selected)[0]
            predecessor = copy.deepcopy(source["master"][target])
            predecessor["id"] = "fm_predecessor_val"
            predecessor["work"]["id"] = "work-predecessor-val"
            predecessor_master = {predecessor["id"]: predecessor}
            predecessor_splits = {predecessor["id"]: "val"}
            split_path = supplement["_successor_master_split_map_path"]
            write_json(
                split_path,
                {
                    "work_assignments": {
                        "work-authority": "train",
                        "work-predecessor-val": "val",
                    }
                },
            )
            supplement["successor_master_split_map_sha256"] = LEDGER.sha256_file(
                split_path
            )
            with self.assertRaisesRegex(
                LEDGER.DeltaLedgerError, "overlaps predecessor val/test lineage"
            ):
                LEDGER._successor_authority_only_binding(
                    source,
                    supplement=supplement,
                    selected_ids=selected,
                    split_by_sample=source["split_by_sample"],
                    predecessor_master=predecessor_master,
                    predecessor_split_by_sample=predecessor_splits,
                    selection_manifest_binding=selection_binding,
                )

    def test_successor_authority_requires_exact_predecessor_subset(self) -> None:
        selected = [f"fm_old_{index:03d}" for index in range(60)]
        quarantine = [*selected, "fm_old_sibling"]
        supplement = {
            "round_id": "round-old",
            "selected_sample_ids": selected,
            "training_quarantine_sample_ids": quarantine,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            predecessor = LEDGER.seal(
                {
                    "schema_version": LEDGER.SCHEMA_VERSION,
                    "record_type": "font_catalog_delta_calibration_subset",
                    "round_id": "round-old",
                    "development_only": True,
                    "training_quarantine_required": True,
                    "training_quarantine_sample_ids": quarantine,
                    "training_quarantine_sample_ids_sha256": LEDGER.sha256_bytes(
                        LEDGER.canonical_json_bytes(quarantine)
                    ),
                    "sample_ids": selected,
                    "sample_count": 60,
                }
            )
            predecessor_path = root / "predecessor.json"
            write_json(predecessor_path, predecessor)
            LEDGER._validate_successor_authority_only_prior(
                supplement=supplement,
                selected_ids={"fm_new"},
                prior_excluded_ids=set(quarantine),
                prior_training_quarantine_ids=set(quarantine),
                prior_subset_paths=[predecessor_path],
            )
            with self.assertRaisesRegex(
                LEDGER.DeltaLedgerError, "exactly one sealed prior subset"
            ):
                LEDGER._validate_successor_authority_only_prior(
                    supplement=supplement,
                    selected_ids={"fm_new"},
                    prior_excluded_ids=set(quarantine),
                    prior_training_quarantine_ids=set(quarantine),
                    prior_subset_paths=[],
                )
            partial = dict(predecessor)
            partial.pop("record_sha256")
            partial["training_quarantine_sample_ids"] = selected
            partial["training_quarantine_sample_ids_sha256"] = LEDGER.sha256_bytes(
                LEDGER.canonical_json_bytes(selected)
            )
            partial = LEDGER.seal(partial)
            partial_path = root / "partial.json"
            write_json(partial_path, partial)
            with self.assertRaisesRegex(
                LEDGER.DeltaLedgerError, "does not exactly seal"
            ):
                LEDGER._validate_successor_authority_only_prior(
                    supplement=supplement,
                    selected_ids={"fm_new"},
                    prior_excluded_ids=set(quarantine),
                    prior_training_quarantine_ids=set(quarantine),
                    prior_subset_paths=[partial_path],
                )

    def test_successor_authority_rejects_unsealed_selection_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "selection.json"
            write_json(path, [f"fm_new_{index:03d}" for index in range(60)])
            with self.assertRaises(LEDGER.DeltaLedgerError):
                LEDGER._read_successor_authority_selection_manifest(
                    path, round_id="round-successor"
                )


if __name__ == "__main__":
    unittest.main()
