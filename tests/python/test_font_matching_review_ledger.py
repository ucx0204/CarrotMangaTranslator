from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "font_matching_review_ledger.py"
SPEC = importlib.util.spec_from_file_location(
    "font_matching_review_ledger", SCRIPT_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load script: {SCRIPT_PATH}")
LEDGER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = LEDGER
SPEC.loader.exec_module(LEDGER)


NOW = datetime(2026, 8, 1, tzinfo=timezone.utc)
CATALOG_VERSION = "font-face-manifest-v1"
ALLOCATION_SEED = "review-ledger-unit-v1"
CANDIDATES = ("family-a", "family-b", "family-c")
ALIASES = {
    "family-a": "ko-candidate-aaaaaaaaaaaaaaaa",
    "family-b": "ko-candidate-bbbbbbbbbbbbbbbb",
    "family-c": "ko-candidate-cccccccccccccccc",
}


def sha(label: str) -> str:
    return LEDGER.sha256_bytes(label.encode("utf-8"))


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def core_decision(
    aliases: list[str],
    *,
    preferred: str = ALIASES["family-a"],
    none_acceptable: bool = False,
) -> dict:
    if none_acceptable:
        judgment = {
            "preferred": [],
            "acceptable": [],
            "marginal": [preferred],
            "unacceptable": [alias for alias in aliases if alias != preferred],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": True,
        }
    else:
        judgment = {
            "preferred": [preferred],
            "acceptable": [],
            "marginal": [],
            "unacceptable": [alias for alias in aliases if alias != preferred],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": False,
        }
    return {
        "role": {"primary": "dialogue", "confidence": 0.95},
        "source_style": {
            "serifness": 0.25,
            "weight": 0.5,
            "width": 0.5,
            "roundness": 0.25,
            "stroke_contrast": 0.25,
            "handwritten": 0.0,
            "angularity": 0.25,
            "irregularity": 0.0,
            "slant": 0.0,
            "energy": 0.25,
            "unknown_fields": [],
        },
        "treatment": {
            "orientation": "vertical",
            "outline": "none",
            "shadow": "none",
            "fill": "solid",
            "distortion": "none",
        },
        "font_judgment": judgment,
        "consistency": {
            "policy": "inherit_work_anchor",
            "reason_code": "ordinary_dialogue",
        },
    }


def review_response(
    claim: dict,
    task: dict,
    *,
    confidence: float = 0.95,
    flags: list[str] | None = None,
    preferred: str = ALIASES["family-a"],
    none_acceptable: bool = False,
) -> dict:
    binding = task["binding"]
    aliases = list(binding["candidate_order_aliases"])
    decision = core_decision(
        aliases, preferred=preferred, none_acceptable=none_acceptable
    )
    response_flags = list(flags or [])
    if none_acceptable and "none_acceptable" not in response_flags:
        response_flags.append("none_acceptable")
    return {
        "schema_version": 1,
        "record_type": LEDGER.REVIEW_RESPONSE_TYPE,
        "claim_id": claim["claim_id"],
        "assignment_id": task["assignment_id"],
        "binding": {
            "source_page_sha256": binding["source_page_sha256"],
            "sample_crop_sha256": binding["sample_crop_sha256"],
            "review_card_sha256": binding["review_card_sha256"],
            "candidate_order_seed": binding["candidate_order_seed"],
            "candidate_order_aliases": aliases,
        },
        **decision,
        "confidence": confidence,
        "flags": response_flags,
        "reviewed_at": LEDGER.timestamp(NOW + timedelta(minutes=1)),
    }


def minimal_decision(task: dict, *, use_positions: bool = True) -> dict:
    aliases = list(task["binding"]["candidate_order_aliases"])
    decision = core_decision(aliases)
    if use_positions:
        position = {alias: index for index, alias in enumerate(aliases, 1)}
        judgment = decision["font_judgment"]
        for tier in LEDGER.labels.FONT_TIERS:
            judgment[tier] = [position[alias] for alias in judgment[tier]]
    return {
        "assignment_id": task["assignment_id"],
        **decision,
        "confidence": 0.95,
        "flags": [],
    }


def adjudication_response(claim: dict, task: dict) -> dict:
    binding = task["binding"]
    decision = copy.deepcopy(task["blind_reviews"][0]["decision"])
    return {
        "schema_version": 1,
        "record_type": LEDGER.ADJUDICATION_RESPONSE_TYPE,
        "claim_id": claim["claim_id"],
        "sample_id": task["sample_id"],
        "binding": copy.deepcopy(binding),
        **decision,
        "confidence": 0.98,
        "notes": "원본 페이지와 15개 후보를 다시 보고 primary 결정을 유지했다.",
        "font_names_visible": False,
        "model_suggestions_visible": False,
        "resolved_at": LEDGER.timestamp(NOW + timedelta(minutes=5)),
    }


class Fixture:
    def __init__(self, root: Path, *, sample_count: int = 4, secondary_count: int = 2):
        self.root = root
        self.workspace = root / "workspace"
        self.master = root / "master.jsonl"
        self.catalog = root / "font-catalog.json"
        self.render_bank = root / "render-bank.json"
        self.card_root = root / "review-cards"
        self.card_manifest = self.card_root / "manifest.json"
        self.canonical_assignments = root / "canonical-assignments.jsonl"
        self.sample_count = sample_count
        self.secondary_count = secondary_count
        self._build()

    def _build(self) -> None:
        write_json(self.catalog, {"schema_version": "font-face-manifest-v1"})
        catalog_sha = LEDGER.sha256_file(self.catalog)
        render = {
            "schema_version": "font-render-bank-v1",
            "specification_sha256": sha("render-spec"),
            "source_contract": {
                "schema_version": CATALOG_VERSION,
                "manifest_sha256": catalog_sha,
            },
            "candidates": [
                {
                    "font_id": candidate,
                    "blind_alias": ALIASES[candidate],
                    "production_400_normal_canonical": True,
                }
                for candidate in CANDIDATES
            ],
        }
        write_json(self.render_bank, render)
        master_rows = []
        samples = []
        for index in range(self.sample_count):
            sample_id = f"sample-{index:03d}"
            work_id = f"work-{index % 2:02d}"
            page_sha = sha(f"page-{index}")
            view_hashes = {
                name: sha(f"{sample_id}-{name}")
                for name in ("raw_224", "context_224", "glyph_224")
            }
            master_rows.append(
                {
                    "id": sample_id,
                    "work": {"id": work_id},
                    "chapter": {"id": f"chapter-{index // 2:02d}"},
                    "page": {"id": f"page-{index:03d}", "source_page_sha256": page_sha},
                    "split": "train",
                    "sample_crop_sha256": sha(f"crop-{index}"),
                    "views": {
                        name: {"status": "available", "file_sha256": value}
                        for name, value in view_hashes.items()
                    },
                    "metadata": {
                        "candidate_categories": ["bubble_edge"] if index == 0 else [],
                        "cohort_signals": {"manual_recrop": index == 0},
                    },
                    "provenance": {"qa_overlay": False, "synthetic": False},
                }
            )
            samples.append(
                LEDGER.labels.ReviewSample(
                    sample_id=sample_id,
                    work_id=work_id,
                    source_page_sha256=page_sha,
                    candidate_ids=CANDIDATES,
                )
            )
        self.master.write_bytes(LEDGER.jsonl_bytes(master_rows))
        assignments = LEDGER.labels.build_blind_review_assignments(
            samples,
            catalog_version=CATALOG_VERSION,
            allocation_seed=ALLOCATION_SEED,
            double_review_fraction=self.secondary_count / self.sample_count,
        )
        assignment_payload = LEDGER.jsonl_bytes(
            assignment.as_dict() for assignment in assignments
        )
        self.canonical_assignments.write_bytes(assignment_payload)
        self.assignment_objects = list(assignments)
        renderer_hash = sha("card-renderer")
        self.card_root.mkdir()
        (self.card_root / "cards").mkdir()
        cards = []
        for assignment in assignments:
            aliases = [ALIASES[candidate] for candidate in assignment.candidate_order]
            artifact = f"cards/{assignment.assignment_id}.png"
            artifact_path = self.card_root / artifact
            artifact_path.write_bytes(f"card:{assignment.assignment_id}".encode())
            master = next(
                row for row in master_rows if row["id"] == assignment.sample_id
            )
            views = {
                name: {
                    "status": "available",
                    "source_sha256": master["views"][name]["file_sha256"],
                    "display_sha256": sha(f"display-{assignment.assignment_id}-{name}"),
                }
                for name in ("raw_224", "context_224", "glyph_224")
            }
            cards.append(
                {
                    "schema_version": LEDGER.CARD_SCHEMA_VERSION,
                    "card_id": "fmrc-" + sha(assignment.assignment_id)[:32],
                    "assignment": {
                        "assignment_id": assignment.assignment_id,
                        "sample_id": assignment.sample_id,
                        "stage": assignment.stage,
                        "catalog_version": assignment.catalog_version,
                        "candidate_order_seed": assignment.candidate_order_seed,
                        "blind_candidate_order": aliases,
                    },
                    "source": {
                        "source_page_sha256": assignment.source_page_sha256,
                        "sample_crop_sha256": master["sample_crop_sha256"],
                        "bbox_px": [1, 2, 30, 40],
                        "orientation": "vertical",
                        "views": views,
                    },
                    "candidates": [
                        {
                            "position": position,
                            "blind_alias": alias,
                            "status": "rendered",
                            "status_code": None,
                            "probes": [],
                        }
                        for position, alias in enumerate(aliases, 1)
                    ],
                    "artifact": {
                        "file": artifact,
                        "sha256": LEDGER.sha256_file(artifact_path),
                        "width": 2400,
                        "height": 3508,
                        "qa_overlay": True,
                        "watermark": "REVIEW-ONLY",
                    },
                }
            )
        card_manifest = {
            "schema_version": LEDGER.CARD_SCHEMA_VERSION,
            "renderer_hash": renderer_hash,
            "input_hashes": {
                "master_manifest_sha256": LEDGER.sha256_file(self.master),
                "assignments_sha256": LEDGER.sha256_bytes(assignment_payload),
                "render_bank_manifest_sha256": LEDGER.sha256_file(self.render_bank),
            },
            "configuration": {"stage": "all", "batch": "all", "limit": None},
            "card_count": len(cards),
            "cards": cards,
            "qa_overlay": True,
            "training_asset": False,
            "blindness_contract": {
                "candidate_identity_fields_present": False,
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "public_candidates_use_blind_alias_only": True,
                "reveal_map_embedded": False,
            },
        }
        write_json(self.card_manifest, card_manifest)

    def pilot_stage(self, selected_ids: list[str]) -> tuple[Path, Path, int]:
        inventory = self.root / "pilot-inventory.jsonl"
        master_hash = LEDGER.sha256_file(self.master)
        inventory_rows = [
            {
                "schema_version": 1,
                "sample_id": sample_id,
                "master_manifest_sha256": master_hash,
                "batches": {
                    "pilot": {
                        "review_order": index,
                        "selection_reasons": ["unit:pilot"],
                    }
                },
                "provenance": {"qa_overlay": False, "synthetic": False},
            }
            for index, sample_id in enumerate(selected_ids, 1)
        ]
        inventory.write_bytes(LEDGER.jsonl_bytes(inventory_rows))
        full_manifest = json.loads(self.card_manifest.read_text(encoding="utf-8"))
        selected = set(selected_ids)
        full_manifest["cards"] = [
            card
            for card in full_manifest["cards"]
            if card["assignment"]["sample_id"] in selected
        ]
        full_manifest["card_count"] = len(full_manifest["cards"])
        full_manifest["configuration"] = {
            "stage": "all",
            "batch": "pilot",
            "limit": None,
        }
        full_manifest["input_hashes"]["inventory_sha256"] = LEDGER.sha256_file(
            inventory
        )
        full_manifest["input_hashes"]["assignments_sha256"] = LEDGER.sha256_file(
            self.canonical_assignments
        )
        pilot_manifest = self.card_root / "pilot-manifest.json"
        write_json(pilot_manifest, full_manifest)
        secondary_count = sum(
            assignment.stage == "secondary" and assignment.sample_id in selected
            for assignment in self.assignment_objects
        )
        return inventory, pilot_manifest, secondary_count

    def init(self) -> dict:
        return LEDGER.initialize_workspace(
            workspace=self.workspace,
            master_manifest=self.master,
            card_manifest=self.card_manifest,
            font_catalog=self.catalog,
            render_bank=self.render_bank,
            catalog_version=CATALOG_VERSION,
            allocation_seed=ALLOCATION_SEED,
            expected_primary=self.sample_count,
            expected_secondary=self.secondary_count,
            expected_candidates=len(CANDIDATES),
        )


class ReviewLedgerContractTest(unittest.TestCase):
    def test_pilot_staged_init_projects_only_canonical_selected_assignments(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            selected = ["sample-002", "sample-000", "sample-003"]
            inventory, card_manifest, secondary_count = fixture.pilot_stage(selected)
            workspace = fixture.root / "pilot-workspace"
            report = LEDGER.initialize_workspace(
                workspace=workspace,
                master_manifest=fixture.master,
                card_manifest=card_manifest,
                font_catalog=fixture.catalog,
                render_bank=fixture.render_bank,
                catalog_version=CATALOG_VERSION,
                allocation_seed=ALLOCATION_SEED,
                priority_inventory=inventory,
                canonical_assignments=fixture.canonical_assignments,
                batch="pilot",
                expected_primary=fixture.sample_count,
                expected_secondary=fixture.secondary_count,
                expected_batch_primary=len(selected),
                expected_batch_secondary=secondary_count,
                expected_candidates=len(CANDIDATES),
            )
            self.assertEqual(len(selected), report["expected"]["primary"])
            self.assertEqual(secondary_count, report["expected"]["secondary"])
            state = LEDGER.load_workspace(workspace)
            primary_rows = [
                row for row in state.rows if row["assignment"]["stage"] == "primary"
            ]
            secondary_rows = [
                row for row in state.rows if row["assignment"]["stage"] == "secondary"
            ]
            self.assertEqual(
                selected, [row["assignment"]["sample_id"] for row in primary_rows]
            )
            canonical_secondary = {
                assignment.sample_id
                for assignment in fixture.assignment_objects
                if assignment.stage == "secondary"
            }
            self.assertEqual(
                [
                    sample_id
                    for sample_id in selected
                    if sample_id in canonical_secondary
                ],
                [row["assignment"]["sample_id"] for row in secondary_rows],
            )
            self.assertEqual(
                len(selected) + secondary_count,
                len({row["assignment"]["assignment_id"] for row in state.rows}),
            )
            for row in state.rows:
                sample_id = row["assignment"]["sample_id"]
                self.assertEqual(
                    selected.index(sample_id) + 1,
                    row["priority_batches"]["pilot"]["review_order"],
                )
            self.assertEqual("pilot", state.contract["scope"]["batch"])
            self.assertEqual(
                LEDGER.sha256_file(fixture.master),
                state.contract["inputs"]["master_manifest_sha256"],
            )
            self.assertEqual(
                LEDGER.sha256_file(fixture.canonical_assignments),
                state.contract["inputs"]["canonical_assignments_sha256"],
            )

    def test_pilot_staged_init_rejects_out_of_scope_and_missing_cards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            selected = ["sample-000", "sample-001", "sample-002"]
            inventory, card_manifest, secondary_count = fixture.pilot_stage(selected)
            manifest = json.loads(card_manifest.read_text(encoding="utf-8"))
            full = json.loads(fixture.card_manifest.read_text(encoding="utf-8"))
            outside = next(
                card
                for card in full["cards"]
                if card["assignment"]["sample_id"] not in set(selected)
            )
            contaminated = copy.deepcopy(manifest)
            contaminated["cards"].append(outside)
            contaminated["card_count"] += 1
            contaminated_path = fixture.card_root / "pilot-contaminated.json"
            write_json(contaminated_path, contaminated)
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "missing=.*extra"):
                LEDGER.initialize_workspace(
                    workspace=fixture.root / "contaminated-workspace",
                    master_manifest=fixture.master,
                    card_manifest=contaminated_path,
                    font_catalog=fixture.catalog,
                    render_bank=fixture.render_bank,
                    catalog_version=CATALOG_VERSION,
                    allocation_seed=ALLOCATION_SEED,
                    priority_inventory=inventory,
                    canonical_assignments=fixture.canonical_assignments,
                    batch="pilot",
                    expected_primary=fixture.sample_count,
                    expected_secondary=fixture.secondary_count,
                    expected_batch_primary=len(selected),
                    expected_batch_secondary=secondary_count,
                    expected_candidates=len(CANDIDATES),
                )

            missing = copy.deepcopy(manifest)
            missing["cards"].pop()
            missing["card_count"] -= 1
            missing_path = fixture.card_root / "pilot-missing.json"
            write_json(missing_path, missing)
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "missing=.*extra"):
                LEDGER.initialize_workspace(
                    workspace=fixture.root / "missing-workspace",
                    master_manifest=fixture.master,
                    card_manifest=missing_path,
                    font_catalog=fixture.catalog,
                    render_bank=fixture.render_bank,
                    catalog_version=CATALOG_VERSION,
                    allocation_seed=ALLOCATION_SEED,
                    priority_inventory=inventory,
                    canonical_assignments=fixture.canonical_assignments,
                    batch="pilot",
                    expected_primary=fixture.sample_count,
                    expected_secondary=fixture.secondary_count,
                    expected_batch_primary=len(selected),
                    expected_batch_secondary=secondary_count,
                    expected_candidates=len(CANDIDATES),
                )

    def test_plan_owns_full_assignment_and_card_inventory_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            assignments = fixture.root / "planned-assignments.jsonl"
            inventory = fixture.root / "planned-inventory.jsonl"
            report_path = fixture.root / "plan-report.json"
            report = LEDGER.write_assignment_plan(
                master_manifest=fixture.master,
                render_bank=fixture.render_bank,
                assignments_output=assignments,
                inventory_output=inventory,
                report_output=report_path,
                catalog_version=CATALOG_VERSION,
                allocation_seed=ALLOCATION_SEED,
                expected_primary=fixture.sample_count,
                expected_secondary=fixture.secondary_count,
                expected_candidates=len(CANDIDATES),
            )
            card_manifest = json.loads(
                fixture.card_manifest.read_text(encoding="utf-8")
            )
            self.assertEqual(
                card_manifest["input_hashes"]["assignments_sha256"],
                report["hashes"]["assignments_sha256"],
            )
            self.assertEqual(4, len(LEDGER.read_jsonl(inventory)))
            self.assertEqual(6, len(LEDGER.read_jsonl(assignments)))

    def test_init_is_deterministic_and_binds_exact_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            report = fixture.init()
            self.assertEqual(4, report["assignments"]["primary"])
            self.assertEqual(2, report["assignments"]["secondary"])
            self.assertEqual(0, report["reviews_completed"].get("primary", 0))
            state = LEDGER.load_workspace(fixture.workspace)
            self.assertEqual(6, len(state.rows))
            self.assertEqual(
                set(range(1, 7)), {row["review_order"] for row in state.rows}
            )
            self.assertEqual(
                state.contract["assignments_sha256"],
                LEDGER.sha256_file(fixture.workspace / LEDGER.ASSIGNMENTS_FILE),
            )

    def test_public_claim_exposes_only_blind_aliases_and_claims_do_not_overlap(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            first = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=2,
                now=NOW,
            )
            second = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-b",
                target_kind="primary",
                count=2,
                now=NOW,
            )
            first_ids = {task["assignment_id"] for task in first["tasks"]}
            second_ids = {task["assignment_id"] for task in second["tasks"]}
            self.assertFalse(first_ids & second_ids)
            rendered = json.dumps(first, ensure_ascii=False)
            for candidate_id in CANDIDATES:
                self.assertNotIn(candidate_id, rendered)
            self.assertIn(ALIASES["family-a"], rendered)

    def test_prepare_response_binds_positions_and_aliases_then_submits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            claim = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=2,
                now=NOW,
            )
            decisions = [
                minimal_decision(claim["tasks"][1], use_positions=False),
                minimal_decision(claim["tasks"][0], use_positions=True),
            ]
            responses = LEDGER.prepare_review_responses(
                claim,
                decisions,
                reviewed_at=NOW + timedelta(minutes=1),
            )

            self.assertEqual(
                [task["assignment_id"] for task in claim["tasks"]],
                [response["assignment_id"] for response in responses],
            )
            for task, response in zip(claim["tasks"], responses, strict=True):
                self.assertEqual(claim["claim_id"], response["claim_id"])
                self.assertEqual(
                    {
                        key: task["binding"][key]
                        for key in (
                            "source_page_sha256",
                            "sample_crop_sha256",
                            "review_card_sha256",
                            "candidate_order_seed",
                            "candidate_order_aliases",
                        )
                    },
                    response["binding"],
                )
                judged = [
                    alias
                    for tier in LEDGER.labels.FONT_TIERS
                    for alias in response["font_judgment"][tier]
                ]
                self.assertCountEqual(
                    task["binding"]["candidate_order_aliases"], judged
                )
            rendered = json.dumps(responses, ensure_ascii=False)
            for candidate_id in CANDIDATES:
                self.assertNotIn(candidate_id, rendered)

            created = LEDGER.submit_review_batch(
                fixture.workspace,
                responses,
                now=NOW + timedelta(minutes=2),
            )
            self.assertEqual(2, len(created))

    def test_prepare_response_rejects_nonblind_or_incomplete_decisions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            claim = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=2,
                now=NOW,
            )
            first = minimal_decision(claim["tasks"][0])
            second = minimal_decision(claim["tasks"][1])

            invalid_decisions: dict[str, list[dict]] = {}

            out_of_range = copy.deepcopy(first)
            out_of_range["font_judgment"]["preferred"] = [len(CANDIDATES) + 1]
            invalid_decisions["out-of-range position"] = [out_of_range, second]

            duplicate = copy.deepcopy(first)
            duplicate["font_judgment"]["acceptable"] = [1]
            invalid_decisions["candidate repeated across tiers"] = [duplicate, second]

            missing_candidate = copy.deepcopy(first)
            missing_candidate["font_judgment"]["unacceptable"].pop()
            invalid_decisions["candidate missing from partition"] = [
                missing_candidate,
                second,
            ]

            exposed_font_id = copy.deepcopy(first)
            exposed_font_id["font_judgment"]["preferred"] = ["family-a"]
            invalid_decisions["font id instead of blind alias"] = [
                exposed_font_id,
                second,
            ]

            extra_identity_field = copy.deepcopy(first)
            extra_identity_field["font_id"] = "family-a"
            invalid_decisions["font identity field"] = [
                extra_identity_field,
                second,
            ]

            reveal_map = copy.deepcopy(first)
            reveal_map["reveal_map"] = {ALIASES["family-a"]: "family-a"}
            invalid_decisions["reveal map"] = [reveal_map, second]

            invalid_decisions["missing decision row"] = [first]
            invalid_decisions["duplicate decision row"] = [first, first]

            for reason, decisions in invalid_decisions.items():
                with self.subTest(reason=reason):
                    with self.assertRaises(LEDGER.ReviewLedgerError):
                        LEDGER.prepare_review_responses(
                            claim,
                            decisions,
                            reviewed_at=NOW + timedelta(minutes=1),
                        )

            tampered_claim = copy.deepcopy(claim)
            tampered_claim["reviewer"] = "reviewer-b"
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "binding failed"):
                LEDGER.prepare_review_responses(
                    tampered_claim,
                    [first, second],
                    reviewed_at=NOW + timedelta(minutes=1),
                )

            leaked_claim = copy.deepcopy(claim)
            leaked_claim["reveal_map"] = {
                ALIASES["family-a"]: "family-a",
            }
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "unexpected"):
                LEDGER.prepare_review_responses(
                    LEDGER.seal(leaked_claim),
                    [first, second],
                    reviewed_at=NOW + timedelta(minutes=1),
                )

    def test_release_makes_an_unfinished_batch_claimable_again(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            claim = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=4,
                now=NOW,
            )
            LEDGER.release_claim(
                fixture.workspace,
                claim_id=claim["claim_id"],
                reviewer="reviewer-a",
                now=NOW + timedelta(minutes=1),
            )
            replacement = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-b",
                target_kind="primary",
                count=4,
                now=NOW + timedelta(minutes=2),
            )
            self.assertEqual(4, replacement["task_count"])

    def test_submit_is_atomic_and_rejects_any_binding_tamper(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            claim = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=2,
                now=NOW,
            )
            responses = [review_response(claim, task) for task in claim["tasks"]]
            responses[1]["binding"]["sample_crop_sha256"] = "0" * 64
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "differs from claim"):
                LEDGER.submit_review_batch(
                    fixture.workspace,
                    responses,
                    now=NOW + timedelta(minutes=2),
                )
            self.assertEqual(
                [], LEDGER.read_jsonl(fixture.workspace / LEDGER.REVIEWS_FILE)
            )
            responses[1] = review_response(claim, claim["tasks"][1])
            created = LEDGER.submit_review_batch(
                fixture.workspace,
                responses,
                now=NOW + timedelta(minutes=2),
            )
            self.assertEqual(2, len(created))
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "already reviewed"):
                LEDGER.submit_review_batch(
                    fixture.workspace,
                    responses,
                    now=NOW + timedelta(minutes=3),
                )

    def test_low_confidence_requires_flag_and_enters_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            claim = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=1,
                now=NOW,
            )
            response = review_response(claim, claim["tasks"][0], confidence=0.5)
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "low_confidence"):
                LEDGER.submit_review_batch(
                    fixture.workspace, [response], now=NOW + timedelta(minutes=1)
                )
            response["flags"] = ["low_confidence"]
            LEDGER.submit_review_batch(
                fixture.workspace, [response], now=NOW + timedelta(minutes=1)
            )
            queue = LEDGER.write_queue_snapshot(fixture.workspace)
            self.assertEqual(1, queue["by_reason"]["low_confidence"])

    def test_none_crop_render_catalog_and_policy_flags_enter_adjudication_queue(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            claim = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=4,
                now=NOW,
            )
            responses = [review_response(claim, task) for task in claim["tasks"]]
            responses[0] = review_response(
                claim,
                claim["tasks"][0],
                none_acceptable=True,
                flags=[
                    "none_acceptable",
                    "crop_needs_review",
                    "rendering_issue",
                    "catalog_gap",
                    "policy_uncertain",
                ],
            )
            LEDGER.submit_review_batch(
                fixture.workspace,
                responses,
                now=NOW + timedelta(minutes=1),
            )
            queue = LEDGER.write_queue_snapshot(fixture.workspace)
            for reason in (
                "none_acceptable",
                "crop_needs_review",
                "rendering_issue",
                "catalog_gap",
                "policy_uncertain",
                "manual_recrop",
            ):
                self.assertGreaterEqual(queue["by_reason"].get(reason, 0), 1)

    def test_tier_disagreement_enters_queue_after_independent_secondary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            primary = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=4,
                now=NOW,
            )
            LEDGER.submit_review_batch(
                fixture.workspace,
                [review_response(primary, task) for task in primary["tasks"]],
                now=NOW + timedelta(minutes=1),
            )
            secondary = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-b",
                target_kind="secondary",
                count=2,
                now=NOW + timedelta(minutes=2),
            )
            responses = [
                review_response(
                    secondary, secondary["tasks"][0], preferred=ALIASES["family-b"]
                ),
                review_response(secondary, secondary["tasks"][1]),
            ]
            LEDGER.submit_review_batch(
                fixture.workspace,
                responses,
                now=NOW + timedelta(minutes=3),
            )
            queue = LEDGER.write_queue_snapshot(fixture.workspace)
            self.assertEqual(1, queue["by_reason"]["font_tier_disagreement"])

    def test_secondary_is_independent_and_complete_flow_adjudicates_manual_recrop(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            fixture.init()
            primary = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-a",
                target_kind="primary",
                count=4,
                now=NOW,
            )
            LEDGER.submit_review_batch(
                fixture.workspace,
                [review_response(primary, task) for task in primary["tasks"]],
                now=NOW + timedelta(minutes=1),
            )
            with self.assertRaisesRegex(LEDGER.ReviewLedgerError, "no claimable"):
                LEDGER.claim_batch(
                    fixture.workspace,
                    reviewer="reviewer-a",
                    target_kind="secondary",
                    count=1,
                    now=NOW + timedelta(minutes=2),
                )
            secondary = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-b",
                target_kind="secondary",
                count=2,
                now=NOW + timedelta(minutes=2),
            )
            LEDGER.submit_review_batch(
                fixture.workspace,
                [review_response(secondary, task) for task in secondary["tasks"]],
                now=NOW + timedelta(minutes=3),
            )
            with self.assertRaisesRegex(
                LEDGER.ReviewLedgerError, "valid but incomplete"
            ):
                LEDGER.validate_workspace(fixture.workspace, require_complete=True)
            projected = LEDGER.finalize_uncontested(
                fixture.workspace,
                resolver="projection-service",
                now=NOW + timedelta(minutes=4),
            )
            self.assertEqual(3, len(projected))
            adjudication = LEDGER.claim_batch(
                fixture.workspace,
                reviewer="reviewer-c",
                target_kind="adjudication",
                count=1,
                now=NOW + timedelta(minutes=4),
            )
            self.assertIn("manual_recrop", adjudication["tasks"][0]["reasons"])
            created = LEDGER.submit_adjudication_batch(
                fixture.workspace,
                [adjudication_response(adjudication, adjudication["tasks"][0])],
                now=NOW + timedelta(minutes=6),
            )
            self.assertEqual(
                ["manual_recrop_resolved"], created[0]["resolution"]["flags"]
            )
            report = LEDGER.validate_workspace(fixture.workspace, require_complete=True)
            self.assertTrue(report["completion_ready"])
            self.assertEqual(4, report["reviews_completed"]["primary"])
            self.assertEqual(2, report["reviews_completed"]["secondary"])
            self.assertEqual(4, report["finals"]["completed"])

    def test_card_identity_leak_and_artifact_tamper_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            manifest = json.loads(fixture.card_manifest.read_text(encoding="utf-8"))
            leaked = copy.deepcopy(manifest["cards"][0])
            leaked["candidates"][0]["font_id"] = "family-a"
            with self.assertRaisesRegex(
                LEDGER.ReviewLedgerError, "leaks font identity"
            ):
                LEDGER.parse_card_binding(leaked, location="leaked")

            fixture.init()
            card_path = fixture.card_root / manifest["cards"][0]["artifact"]["file"]
            card_path.write_bytes(b"tampered")
            with self.assertRaisesRegex(
                LEDGER.ReviewLedgerError, "review card artifact changed"
            ):
                LEDGER.validate_workspace(fixture.workspace)


if __name__ == "__main__":
    unittest.main()
