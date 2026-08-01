from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


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
        self.aliases = [f"ko-candidate-{index:016x}" for index in range(1, 8)]
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
        artifact_path.write_bytes(f"card:{assignment['assignment_id']}".encode())
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
                "height": 100,
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
                }
                for index, sample_id in enumerate(self.sample_ids)
            ],
        )
        write_json(self.rescue / "render-bank" / "manifest.json", render_manifest)
        source_report = source_seal(
            {
                "schema_version": LEDGER.SOURCE_SCHEMA_VERSION,
                "record_type": "font_matching_catalog_delta_review_inputs_report",
                "inputs": {
                    "expanded_catalog_sha256": "a" * 64,
                    "expanded_render_bank_sha256": "b" * 64,
                    "master_manifest_sha256": "c" * 64,
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
        source_report_path = self.rescue / "report.json"
        source_report = LEDGER.read_json(source_report_path)
        source_report["outputs"]["master_sha256"] = LEDGER.sha256_file(master_path)
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
            rubric=ROOT / "docs" / "font-matching-v2-review-rubric.md",
            mode=mode,
            calibration_sample_ids=calibration_ids,
            calibration_round_id=round_id,
            calibration_reservoir=calibration_reservoir,
            prior_calibration_subsets=prior_calibration_subsets or [],
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


if __name__ == "__main__":
    unittest.main()
