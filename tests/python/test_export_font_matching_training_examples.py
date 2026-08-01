from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from collections import Counter
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = ROOT / "tests" / "python" / "test_font_matching_review_ledger.py"
FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "font_matching_review_ledger_test_fixture", FIXTURE_PATH
)
if FIXTURE_SPEC is None or FIXTURE_SPEC.loader is None:
    raise RuntimeError(f"Could not load fixture module: {FIXTURE_PATH}")
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
sys.modules[FIXTURE_SPEC.name] = FIXTURE
FIXTURE_SPEC.loader.exec_module(FIXTURE)

SCRIPT_PATH = ROOT / "scripts" / "export_font_matching_training_examples.py"
EXPORT_SPEC = importlib.util.spec_from_file_location(
    "export_font_matching_training_examples", SCRIPT_PATH
)
if EXPORT_SPEC is None or EXPORT_SPEC.loader is None:
    raise RuntimeError(f"Could not load exporter: {SCRIPT_PATH}")
EXPORT = importlib.util.module_from_spec(EXPORT_SPEC)
sys.modules[EXPORT_SPEC.name] = EXPORT
EXPORT_SPEC.loader.exec_module(EXPORT)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_bytes(FIXTURE.LEDGER.jsonl_bytes(rows))


def prepare_fixture(
    root: Path,
    *,
    sample_count: int = 4,
    secondary_count: int = 2,
    master_v2_fields: bool = False,
) -> object:
    inputs = root / "inputs"
    inputs.mkdir(parents=True)
    fixture = FIXTURE.Fixture(
        inputs,
        sample_count=sample_count,
        secondary_count=secondary_count,
    )

    master_rows = read_jsonl(fixture.master)
    for index, row in enumerate(master_rows):
        row["split"] = "train" if row["work"]["id"] == "work-00" else "val"
        for view_name, descriptor in row["views"].items():
            descriptor.update(
                {
                    "catalog_id": "fixture-source",
                    "expected_size_px": [224, 224],
                    "path": f"assets/{row['id']}/{view_name}.png",
                }
            )
        if master_v2_fields:
            catalog_id, source_kind = (
                ("fixture-base", "base"),
                ("fixture-hard", "hard"),
                ("fixture-delta", "hard"),
            )[index % 3]
            row["groups"] = {"split_component": f"component-{row['work']['id']}"}
            for descriptor in row["views"].values():
                descriptor["catalog_id"] = catalog_id
            row["provenance"].update(
                {
                    "source_catalog_id": catalog_id,
                    "source_kind": source_kind,
                }
            )
            row["work_balance_weight"] = round(
                1.0
                / sum(
                    candidate["work"]["id"] == row["work"]["id"]
                    for candidate in master_rows
                ),
                12,
            )
    write_jsonl(fixture.master, master_rows)

    render_bank = read_json(fixture.render_bank)
    render_bank["render_spec"] = {"qa_overlay": False}
    render_bank["renders"] = []
    render_root = fixture.root / "renders"
    render_root.mkdir()
    for index, candidate in enumerate(render_bank["candidates"]):
        candidate_id = candidate["font_id"]
        display_id = f"display-{candidate_id}"
        candidate.update(
            {
                "allowed_writing_modes": ["horizontal", "vertical"],
                "display_id": display_id,
                "face_id": f"face:{candidate_id}",
                "production_asset_status": {
                    "chromium_ots_compatible": True,
                    "code": "passed",
                },
                "render_style": "normal",
                "render_weight": 400,
                "source_file": f"fonts/{candidate_id}.ttf",
                "source_sha256": FIXTURE.sha(f"font-source-{candidate_id}"),
            }
        )
        artifact = render_root / f"{candidate_id}.png"
        artifact.write_bytes(f"render:{candidate_id}".encode())
        render_bank["renders"].append(
            {
                "artifact": {
                    "file": f"renders/{candidate_id}.png",
                    "qa_overlay": False,
                    "sha256": FIXTURE.LEDGER.sha256_file(artifact),
                },
                "candidate_display_id": display_id,
                "fallback_detection": {"status": "passed"},
                "font_style": "normal",
                "font_weight": 400,
                "probe_id": f"probe-{index:02d}",
                "readiness": {"document_fonts_ready": True},
                "render_id": f"render-{index:02d}",
                "writing_mode": "vertical",
            }
        )
    FIXTURE.write_json(fixture.render_bank, render_bank)

    card_manifest = read_json(fixture.card_manifest)
    card_manifest["input_hashes"]["master_manifest_sha256"] = (
        FIXTURE.LEDGER.sha256_file(fixture.master)
    )
    card_manifest["input_hashes"]["render_bank_manifest_sha256"] = (
        FIXTURE.LEDGER.sha256_file(fixture.render_bank)
    )
    FIXTURE.write_json(fixture.card_manifest, card_manifest)
    return fixture


def review_response(claim: dict, task: dict) -> dict:
    sample_id = task["sample_id"]
    response = FIXTURE.review_response(
        claim,
        task,
        none_acceptable=sample_id == "sample-000",
    )
    if sample_id == "sample-001":
        response["font_judgment"] = {
            "preferred": [FIXTURE.ALIASES["family-a"]],
            "acceptable": [FIXTURE.ALIASES["family-b"]],
            "marginal": [],
            "unacceptable": [FIXTURE.ALIASES["family-c"]],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": False,
        }
    return response


def finish_workspace(
    fixture: object,
    *,
    workspace: Path,
    primary_count: int,
    secondary_count: int,
    adjudicate: bool = True,
) -> None:
    primary = FIXTURE.LEDGER.claim_batch(
        workspace,
        reviewer="reviewer-a",
        target_kind="primary",
        count=primary_count,
        now=FIXTURE.NOW,
    )
    FIXTURE.LEDGER.submit_review_batch(
        workspace,
        [review_response(primary, task) for task in primary["tasks"]],
        now=FIXTURE.NOW + timedelta(minutes=1),
    )
    if secondary_count:
        secondary = FIXTURE.LEDGER.claim_batch(
            workspace,
            reviewer="reviewer-b",
            target_kind="secondary",
            count=secondary_count,
            now=FIXTURE.NOW + timedelta(minutes=2),
        )
        FIXTURE.LEDGER.submit_review_batch(
            workspace,
            [review_response(secondary, task) for task in secondary["tasks"]],
            now=FIXTURE.NOW + timedelta(minutes=3),
        )
    FIXTURE.LEDGER.finalize_uncontested(
        workspace,
        resolver="projection-service",
        now=FIXTURE.NOW + timedelta(minutes=4),
    )
    if not adjudicate:
        return
    adjudication = FIXTURE.LEDGER.claim_batch(
        workspace,
        reviewer="reviewer-c",
        target_kind="adjudication",
        count=1,
        now=FIXTURE.NOW + timedelta(minutes=5),
    )
    FIXTURE.LEDGER.submit_adjudication_batch(
        workspace,
        [FIXTURE.adjudication_response(adjudication, adjudication["tasks"][0])],
        now=FIXTURE.NOW + timedelta(minutes=6),
    )


def complete_fixture(fixture: object, *, adjudicate: bool = True) -> None:
    fixture.init()
    finish_workspace(
        fixture,
        workspace=fixture.workspace,
        primary_count=fixture.sample_count,
        secondary_count=fixture.secondary_count,
        adjudicate=adjudicate,
    )


def write_augmentation(
    root: Path,
    fixture: object,
    *,
    parent_sample_id: str = "sample-000",
    qa_overlay: bool = False,
) -> Path:
    augmentation_root = root / "augmentation-input"
    augmentation_root.mkdir()
    views = {}
    for view_name in EXPORT.VIEW_NAMES:
        asset = augmentation_root / f"{view_name}.png"
        asset.write_bytes(f"generated:{parent_sample_id}:{view_name}".encode())
        views[view_name] = {
            "file_sha256": EXPORT.sha256_file(asset),
            "path": asset.name,
            "qa_overlay": qa_overlay,
        }
    master = next(
        row for row in read_jsonl(fixture.master) if row["id"] == parent_sample_id
    )
    record = EXPORT.seal(
        {
            "augmentation_id": f"aug-{parent_sample_id}",
            "parent_sample_id": parent_sample_id,
            "provenance": {
                "allowed_splits": ["train"],
                "generated": True,
                "generator_config_sha256": FIXTURE.sha("augmentation-config"),
                "generator_id": "fixture-generator",
                "generator_version": "1.0.0",
                "parent_sample_crop_sha256": master["sample_crop_sha256"],
                "qa_overlay": qa_overlay,
                "synthetic": True,
                "train_only": True,
            },
            "schema_version": EXPORT.AUGMENTATION_SCHEMA_VERSION,
            "split": "train",
            "transform": {"kind": "ink-distortion", "seed": 17},
            "views": views,
        }
    )
    manifest = augmentation_root / "augmentations.jsonl"
    manifest.write_bytes(EXPORT.canonical_jsonl_record(record))
    return manifest


def build_kwargs(root: Path, fixture: object, augmentation: Path | None) -> dict:
    return {
        "augmentation_manifest": augmentation,
        "master_manifest": fixture.master,
        "output_dir": root / "training-export",
        "render_bank_manifest": fixture.render_bank,
        "review_workspace": fixture.workspace,
    }


def master_seal(record: dict) -> dict:
    output = dict(record)
    output.pop("record_sha256", None)
    output["record_sha256"] = EXPORT.master_builder.sha256_bytes(
        EXPORT.master_builder.canonical_json(output).encode("utf-8")
    )
    return output


def write_registry_fixture(
    root: Path, *, unknown_exclusion: bool = False
) -> tuple[Path, str]:
    source_id = "source-000"
    excluded_catalog_id = "unknown-catalog" if unknown_exclusion else "fixture-base"
    parent_id = EXPORT.master_builder._master_id(excluded_catalog_id, source_id)
    parent = {
        "id": parent_id,
        "provenance": {
            "source_catalog_id": excluded_catalog_id,
            "source_id": source_id,
            "source_line_number": 1,
            "source_line_sha256": FIXTURE.sha("source-line"),
        },
    }
    parent_manifest = root / "parent-master.jsonl"
    write_jsonl(parent_manifest, [parent])
    exclusion = master_seal(
        {
            "excluded_from_font_review": True,
            "excluded_from_training": True,
            "parent_master_id": parent_id,
            "parent_master_record_sha256": EXPORT.master_builder.sha256_bytes(
                EXPORT.master_builder.canonical_json(parent).encode("utf-8")
            ),
            "prior_final_labels_invalidated": True,
            "record_type": "font_matching_master_parent_exclusion",
            "schema_version": "fixture-exclusion-v1",
            "source_catalog_id": excluded_catalog_id,
            "source_id": source_id,
            "source_line_number": 1,
            "source_line_sha256": FIXTURE.sha("source-line"),
            "synthetic": False,
        }
    )
    exclusion_ledger = root / "exclusions.jsonl"
    write_jsonl(exclusion_ledger, [exclusion])
    frozen_split = root / "split-map.json"
    FIXTURE.write_json(frozen_split, {"schema_version": 1})

    catalogs = []
    for catalog_id, source_kind, included in (
        ("fixture-base", "base", 0),
        ("fixture-hard", "hard", 1),
        ("fixture-delta", "hard", 1),
    ):
        catalog_root = root / catalog_id
        catalog_root.mkdir()
        catalog_manifest = catalog_root / "manifest.jsonl"
        write_jsonl(catalog_manifest, [{"id": f"{catalog_id}-source"}])
        catalogs.append(
            {
                "catalog_id": catalog_id,
                "expected_included_rows": included,
                "expected_physical_rows": 1,
                "manifest_name": "manifest.jsonl",
                "manifest_sha256": EXPORT.sha256_file(catalog_manifest),
                "root": str(catalog_root),
                "source_kind": source_kind,
            }
        )
    registry = master_seal(
        {
            "catalogs": catalogs,
            "exclusion_ledgers": [
                {
                    "expected_rows": 1,
                    "path": str(exclusion_ledger),
                    "sha256": EXPORT.sha256_file(exclusion_ledger),
                }
            ],
            "frozen_split_map": {
                "path": str(frozen_split),
                "sha256": EXPORT.sha256_file(frozen_split),
            },
            "parent_master": {
                "manifest": str(parent_manifest),
                "manifest_sha256": EXPORT.sha256_file(parent_manifest),
            },
            "record_type": EXPORT.master_builder.CATALOG_REGISTRY_RECORD_TYPE,
            "schema_version": EXPORT.master_builder.CATALOG_REGISTRY_SCHEMA_VERSION,
        }
    )
    registry_path = root / "catalog-registry.json"
    FIXTURE.write_json(registry_path, registry)
    return registry_path, parent_id


def projection_registry_contract(
    *,
    parent_master: Path,
    current_rows: list[dict],
    invalidated_ids: set[str],
) -> EXPORT.RegistryContract:
    catalog_source_kinds = {
        "fixture-base": "base",
        "fixture-delta": "hard",
        "fixture-hard": "hard",
    }
    counts = Counter(row["provenance"]["source_catalog_id"] for row in current_rows)
    expected_counts = {
        catalog_id: counts[catalog_id] for catalog_id in sorted(catalog_source_kinds)
    }
    return EXPORT.RegistryContract(
        catalog_source_kinds=catalog_source_kinds,
        expected_counts=expected_counts,
        expected_total=len(current_rows),
        excluded_parent_ids=frozenset(invalidated_ids),
        invalidated_parent_ids=frozenset(invalidated_ids),
        input_attestation={"fixture": "registry-attestation"},
        parent_master_manifest_sha256=EXPORT.sha256_file(parent_master),
        record_sha256=FIXTURE.sha("registry-record"),
        registry_sha256=FIXTURE.sha("registry-file"),
        source_configuration=mock.Mock(),
    )


def body_dialogue_sample(
    sample_id: str,
    *,
    page_id: str,
    split: str = "train",
    role: str = "dialogue",
    manual_recrop: bool = False,
    handwritten: float = 0.0,
    irregularity: float = 0.0,
    override: bool = False,
    outline: str = "none",
    geometry_width: int = 80,
    resolution_confidence: float = 0.9,
) -> dict:
    decision = copy.deepcopy(FIXTURE.core_decision(list(FIXTURE.ALIASES.values())))
    decision["role"] = {"confidence": 0.95, "primary": role}
    decision["source_style"]["handwritten"] = handwritten
    decision["source_style"]["irregularity"] = irregularity
    decision["treatment"]["outline"] = outline
    if override:
        decision["consistency"] = {
            "policy": "intentional_override",
            "reason_code": "emphasis",
        }
    return EXPORT.seal(
        {
            "chapter_id": "chapter-shared",
            "consistency": decision["consistency"],
            "font_judgment": decision["font_judgment"],
            "manual_recrop": manual_recrop,
            "page_id": page_id,
            "review_provenance": {
                "resolution": {"confidence": resolution_confidence, "flags": []},
                "source_reviews": [],
            },
            "role": decision["role"],
            "sample_id": sample_id,
            "source": {
                "geometry": {
                    "bbox_px": [0, 0, geometry_width, 100],
                    "page_size_px": [1000, 1400],
                }
            },
            "source_style": decision["source_style"],
            "split": split,
            "treatment": decision["treatment"],
            "work_id": "work-shared",
        }
    )


def chapter_pair_sample(
    sample_id: str,
    *,
    page_id: str,
    positive: str = "font-a",
    action: str = "inherit_anchor",
    split: str = "train",
    work_id: str = "work-pair",
    chapter_id: str = "chapter-pair",
    role: str = "dialogue",
    confidence: float = 0.95,
    human_final: bool = True,
    handwritten: float = 0.0,
) -> dict:
    candidates = ["font-a", "font-b", "font-c"]
    label_id = f"label-{sample_id}"
    consistency = (
        {"policy": "intentional_override", "reason_code": "emphasis"}
        if action == "local_override"
        else {"policy": "inherit_work_anchor", "reason_code": "ordinary_dialogue"}
    )
    return EXPORT.seal(
        {
            "chapter_id": chapter_id,
            "consistency": consistency,
            "font_judgment": {
                "acceptable": [],
                "marginal": [],
                "none_acceptable": False,
                "not_reviewed": [],
                "preferred": [positive],
                "unacceptable": [value for value in candidates if value != positive],
                "unrenderable": [],
            },
            "manual_recrop": False,
            "page_id": page_id,
            "provenance": {
                "approval": (
                    "completed_human_final_label" if human_final else "automatic"
                ),
                "qa_overlay": False,
                "synthetic": False,
            },
            "review_provenance": {
                "final_record_sha256": FIXTURE.sha(f"final-{sample_id}"),
                "resolution": {
                    "confidence": confidence,
                    "kind": "primary",
                    "source_label_ids": [label_id],
                },
                "source_reviews": [
                    {
                        "label_id": label_id,
                        "record_sha256": FIXTURE.sha(f"review-{sample_id}"),
                        "reviewer": f"reviewer-{sample_id}",
                        "stage": "primary",
                    }
                ],
            },
            "role": {"confidence": confidence, "primary": role},
            "sample_id": sample_id,
            "source": {
                "geometry": {
                    "bbox_px": [0, 0, 80, 100],
                    "page_size_px": [1000, 1400],
                }
            },
            "source_style": {
                "angularity": 0.25,
                "energy": 0.25,
                "handwritten": handwritten,
                "irregularity": 0.0,
                "roundness": 0.25,
                "serifness": 0.25,
                "slant": 0.0,
                "stroke_contrast": 0.25,
                "unknown_fields": [],
                "weight": 0.5,
                "width": 0.5,
            },
            "split": split,
            "treatment": {
                "distortion": "none",
                "fill": "solid",
                "orientation": "vertical",
                "outline": "none",
                "shadow": "none",
            },
            "work_id": work_id,
        }
    )


class TrainingExampleExportTest(unittest.TestCase):
    def test_chapter_pair_selection_is_bounded_human_confirmed_and_variant_safe(
        self,
    ) -> None:
        samples = [
            chapter_pair_sample(f"ordinary-{index}", page_id=f"page-{index}")
            for index in range(4)
        ]
        samples.append(
            chapter_pair_sample(
                "override",
                page_id="page-override",
                positive="font-b",
                action="local_override",
            )
        )
        samples.extend(
            [
                chapter_pair_sample("variant-anchor", page_id="page-v1", role="shout"),
                chapter_pair_sample("variant-member", page_id="page-v2", role="shout"),
                chapter_pair_sample(
                    "variant-override",
                    page_id="page-v3",
                    positive="font-b",
                    action="local_override",
                    role="shout",
                ),
                chapter_pair_sample(
                    "test-a",
                    page_id="test-page-a",
                    split="test",
                    work_id="work-test",
                    chapter_id="chapter-test",
                ),
                chapter_pair_sample(
                    "test-b",
                    page_id="test-page-b",
                    split="test",
                    work_id="work-test",
                    chapter_id="chapter-test",
                ),
            ]
        )

        first = EXPORT.build_chapter_pair_rows(samples)
        second = EXPORT.build_chapter_pair_rows(copy.deepcopy(samples))
        self.assertEqual(first, second)
        EXPORT.validate_chapter_pair_rows(samples, first)
        ordinary = [
            row for row in first if row["pair_kind"] == "ordinary_consistency_positive"
        ]
        overrides = [
            row for row in first if row["pair_kind"] == "local_override_margin"
        ]
        self.assertEqual(2, len(ordinary))
        self.assertEqual(2, len(overrides))
        self.assertEqual(
            2,
            sum(
                row["split"] == "train" and row["role"] == "dialogue"
                for row in ordinary
            ),
        )
        self.assertFalse(any(row["role"] == "shout" for row in ordinary))
        self.assertTrue(any(row["role"] == "shout" for row in overrides))
        self.assertTrue(all(row["split"] in {"train", "val"} for row in first))
        self.assertTrue(
            all(
                next(
                    sample["page_id"]
                    for sample in samples
                    if sample["sample_id"] == row["anchor_sample_id"]
                )
                != next(
                    sample["page_id"]
                    for sample in samples
                    if sample["sample_id"] == row["target_sample_id"]
                )
                for row in first
            )
        )
        self.assertTrue(all(row["human_confirmed"] for row in first))
        self.assertTrue(
            all(
                set(row)
                == {
                    "anchor_label_record_sha256",
                    "anchor_sample_id",
                    "anchor_training_sample_record_sha256",
                    "chapter_id",
                    "human_confirmed",
                    "pair_id",
                    "pair_kind",
                    "record_sha256",
                    "role",
                    "schema_version",
                    "split",
                    "target_label_record_sha256",
                    "target_sample_id",
                    "target_training_sample_record_sha256",
                }
                for row in first
            )
        )
        contract = EXPORT.build_chapter_pair_contract(first)
        self.assertEqual("enabled", contract["status"])
        self.assertEqual(4, contract["development_pair_count"])
        self.assertEqual({"train": 4}, contract["by_split"])
        self.assertEqual(
            {"local_override_margin": 2, "ordinary_consistency_positive": 2},
            contract["by_kind"],
        )
        self.assertEqual(0, contract["test_pair_rows_emitted"])
        self.assertEqual(0, contract["test_pair_rows_used"])
        self.assertFalse(contract["test_rows_available_to_development"])
        self.assertEqual(
            "separate_hidden_evaluator_only", contract["test_pair_generation"]
        )

        artifact_payload = b"".join(EXPORT.canonical_jsonl_record(row) for row in first)
        descriptor_payload = EXPORT.canonical_json_bytes(
            EXPORT.digest_records(EXPORT.CHAPTER_PAIR_FILE, first).as_dict()
        )
        for hidden_test_sample in samples[-2:]:
            hidden_values = {
                hidden_test_sample["sample_id"],
                hidden_test_sample["record_sha256"],
                hidden_test_sample["review_provenance"]["final_record_sha256"],
            }
            for hidden_value in hidden_values:
                encoded = hidden_value.encode("utf-8")
                self.assertNotIn(encoded, artifact_payload)
                self.assertNotIn(encoded, descriptor_payload)

        forbidden_test_pair = EXPORT._make_chapter_pair_row(
            kind="ordinary_consistency_positive",
            anchor=samples[-2],
            target=samples[-1],
        )
        with self.assertRaisesRegex(
            EXPORT.TrainingExportError, "test chapter pairs are forbidden"
        ):
            EXPORT.validate_chapter_pair_rows(samples, [forbidden_test_pair])

    def test_chapter_pair_validation_rejects_leakage_duplicates_drift_and_low_quality(
        self,
    ) -> None:
        samples = [
            chapter_pair_sample(f"ordinary-{index}", page_id=f"page-{index}")
            for index in range(4)
        ]
        rows = EXPORT.build_chapter_pair_rows(samples)
        self.assertEqual(2, len(rows))

        with self.assertRaisesRegex(EXPORT.TrainingExportError, "duplicate pair ID"):
            EXPORT.validate_chapter_pair_rows(samples, [*rows, copy.deepcopy(rows[0])])

        duplicate_endpoint = copy.deepcopy(rows[0])
        duplicate_endpoint["pair_id"] = "fmcp-duplicate-endpoints"
        duplicate_endpoint = EXPORT.seal(duplicate_endpoint)
        with self.assertRaisesRegex(
            EXPORT.TrainingExportError, "duplicate endpoint pair"
        ):
            EXPORT.validate_chapter_pair_rows(samples, [*rows, duplicate_endpoint])

        drifted = copy.deepcopy(rows)
        drifted[0]["anchor_label_record_sha256"] = FIXTURE.sha("drifted-label")
        drifted[0] = EXPORT.seal(drifted[0])
        with self.assertRaisesRegex(EXPORT.TrainingExportError, "SHA binding drifted"):
            EXPORT.validate_chapter_pair_rows(samples, drifted)

        leaked_samples = copy.deepcopy(samples)
        target_id = rows[0]["target_sample_id"]
        leaked_target = next(
            sample for sample in leaked_samples if sample["sample_id"] == target_id
        )
        leaked_target["chapter_id"] = "another-chapter"
        leaked_target = EXPORT.seal(leaked_target)
        leaked_samples = [
            leaked_target if sample["sample_id"] == target_id else sample
            for sample in leaked_samples
        ]
        with self.assertRaisesRegex(EXPORT.TrainingExportError, "leakage"):
            EXPORT.validate_chapter_pair_rows(leaked_samples, rows)

        low_quality_samples = copy.deepcopy(samples)
        anchor_id = rows[0]["anchor_sample_id"]
        low_quality_anchor = next(
            sample for sample in low_quality_samples if sample["sample_id"] == anchor_id
        )
        low_quality_anchor["role"]["confidence"] = 0.5
        low_quality_anchor = EXPORT.seal(low_quality_anchor)
        low_quality_samples = [
            low_quality_anchor if sample["sample_id"] == anchor_id else sample
            for sample in low_quality_samples
        ]
        low_quality_rows = copy.deepcopy(rows)
        low_quality_row = next(
            row for row in low_quality_rows if row["anchor_sample_id"] == anchor_id
        )
        low_quality_row["anchor_training_sample_record_sha256"] = low_quality_anchor[
            "record_sha256"
        ]
        low_quality_rows[low_quality_rows.index(low_quality_row)] = EXPORT.seal(
            low_quality_row
        )
        with self.assertRaisesRegex(EXPORT.TrainingExportError, "low-quality"):
            EXPORT.validate_chapter_pair_rows(low_quality_samples, low_quality_rows)

        nonhuman_samples = copy.deepcopy(samples)
        nonhuman_anchor = next(
            sample for sample in nonhuman_samples if sample["sample_id"] == anchor_id
        )
        nonhuman_anchor["provenance"]["approval"] = "automatic"
        nonhuman_anchor = EXPORT.seal(nonhuman_anchor)
        nonhuman_samples = [
            nonhuman_anchor if sample["sample_id"] == anchor_id else sample
            for sample in nonhuman_samples
        ]
        nonhuman_rows = copy.deepcopy(rows)
        nonhuman_row = next(
            row for row in nonhuman_rows if row["anchor_sample_id"] == anchor_id
        )
        nonhuman_row["anchor_training_sample_record_sha256"] = nonhuman_anchor[
            "record_sha256"
        ]
        nonhuman_rows[nonhuman_rows.index(nonhuman_row)] = EXPORT.seal(nonhuman_row)
        with self.assertRaisesRegex(EXPORT.TrainingExportError, "nonhuman"):
            EXPORT.validate_chapter_pair_rows(nonhuman_samples, nonhuman_rows)

        with self.assertRaisesRegex(EXPORT.TrainingExportError, "deterministic"):
            EXPORT.validate_chapter_pair_rows(samples, list(reversed(rows)))

    def test_body_dialogue_cap_keeps_variant_and_consistency_evidence(self) -> None:
        ordinary_ids = {f"ordinary-{index:02d}" for index in range(8)}
        samples = [
            body_dialogue_sample(
                sample_id,
                page_id=f"page-{index:02d}",
                geometry_width=40 + index * 35,
                resolution_confidence=0.99 if index == 0 else 0.9,
            )
            for index, sample_id in enumerate(sorted(ordinary_ids))
        ]
        protected_ids = {
            "protected-manual",
            "protected-handwritten",
            "protected-irregular",
            "protected-override",
            "protected-treatment",
            "protected-variant",
            "protected-val",
        }
        samples.extend(
            [
                body_dialogue_sample(
                    "protected-manual",
                    page_id="page-manual",
                    manual_recrop=True,
                ),
                body_dialogue_sample(
                    "protected-handwritten",
                    page_id="page-handwritten",
                    handwritten=0.5,
                ),
                body_dialogue_sample(
                    "protected-irregular",
                    page_id="page-irregular",
                    irregularity=0.75,
                ),
                body_dialogue_sample(
                    "protected-override",
                    page_id="page-override",
                    override=True,
                ),
                body_dialogue_sample(
                    "protected-treatment",
                    page_id="page-treatment",
                    outline="single",
                ),
                body_dialogue_sample(
                    "protected-variant",
                    page_id="page-variant",
                    role="aside_balloon_edge",
                ),
                body_dialogue_sample("protected-val", page_id="page-val", split="val"),
            ]
        )

        retained, statistics = EXPORT.deduplicate_body_dialogue_samples(samples)
        retained_by_id = {row["sample_id"]: row for row in retained}

        self.assertEqual(3, len(ordinary_ids & set(retained_by_id)))
        self.assertTrue(protected_ids <= set(retained_by_id))
        self.assertEqual(15, statistics["before_sample_count"])
        self.assertEqual(10, statistics["after_sample_count"])
        self.assertEqual(5, statistics["dropped_sample_count"])
        self.assertEqual(0, statistics["cap_violation_count"])
        self.assertTrue(statistics["cap_excludes_protected_samples"])
        self.assertTrue(statistics["evaluation_splits_unchanged"])
        self.assertEqual(3, statistics["max_cap_eligible_retained_per_group"])
        self.assertEqual(1, statistics["evaluation_sample_count_unchanged"])
        self.assertEqual(1, statistics["protection_signal_counts"]["manual_recrop"])
        self.assertEqual(1, statistics["protection_signal_counts"]["handwritten"])
        self.assertEqual(1, statistics["protection_signal_counts"]["irregular"])
        self.assertEqual(
            1, statistics["protection_signal_counts"]["source_family_override"]
        )
        self.assertEqual(
            1, statistics["protection_signal_counts"]["noncanonical_treatment"]
        )
        self.assertEqual(1, statistics["protection_signal_counts"]["variant_role"])
        self.assertEqual(
            {
                "canonical_quality",
                "chapter_consistency_positive",
                "geometry_treatment_control",
            },
            set(statistics["selection_slot_counts"]),
        )
        canonical = next(
            row
            for row in retained
            if row["training_selection"]["retention_reason"] == "canonical_quality"
        )
        self.assertEqual("ordinary-00", canonical["sample_id"])
        consistency_positive = next(
            row
            for row in retained
            if row["training_selection"]["retention_reason"]
            == "chapter_consistency_positive"
        )
        self.assertNotEqual(canonical["page_id"], consistency_positive["page_id"])
        for row in retained:
            EXPORT.validate_seal(row, location=str(row["sample_id"]))
            self.assertEqual(
                EXPORT.SOURCE_STYLE_CLUSTER_ALGORITHM,
                row["source_style_cluster"]["algorithm"],
            )
            self.assertRegex(
                row["source_style_cluster"]["fingerprint_sha256"],
                r"^[0-9a-f]{64}$",
            )

    def test_source_style_cluster_is_deterministic_and_unknown_aware(self) -> None:
        style = FIXTURE.core_decision(list(FIXTURE.ALIASES.values()))["source_style"]
        first = EXPORT._source_style_cluster(style)
        second = EXPORT._source_style_cluster(copy.deepcopy(style))
        self.assertEqual(first, second)

        changed = copy.deepcopy(style)
        changed["weight"] = 1.0
        self.assertNotEqual(
            first["cluster_id"], EXPORT._source_style_cluster(changed)["cluster_id"]
        )
        unknown = copy.deepcopy(style)
        unknown["weight"] = None
        unknown["unknown_fields"] = ["weight"]
        unknown_cluster = EXPORT._source_style_cluster(unknown)
        self.assertIsNone(unknown_cluster["axis_bins"]["weight"])
        self.assertNotEqual(first["cluster_id"], unknown_cluster["cluster_id"])

    def test_sealed_registry_loader_accepts_third_catalog_and_rejects_tamper(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry_path, parent_id = write_registry_fixture(root)
            contract = EXPORT.load_registry_contract(registry_path)
            self.assertEqual(
                {"fixture-base", "fixture-hard", "fixture-delta"},
                set(contract.catalog_source_kinds),
            )
            self.assertEqual(frozenset({parent_id}), contract.invalidated_parent_ids)
            self.assertEqual(
                EXPORT.sha256_file(registry_path), contract.registry_sha256
            )

            registry = read_json(registry_path)
            registry["tampered"] = True
            FIXTURE.write_json(registry_path, registry)
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "catalog registry is not complete"
            ):
                EXPORT.load_registry_contract(registry_path)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry_path, _parent_id = write_registry_fixture(
                root, unknown_exclusion=True
            )
            with self.assertRaisesRegex(EXPORT.TrainingExportError, "unknown catalog"):
                EXPORT.load_registry_contract(registry_path)

    def test_parent_workspace_projection_exports_1189_shape_with_explicit_exclusions(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(
                root,
                sample_count=12,
                secondary_count=2,
                master_v2_fields=True,
            )
            parent_rows = read_jsonl(fixture.master)
            card_manifest = read_json(fixture.card_manifest)
            card_manifest["input_hashes"]["catalog_registry_sha256"] = FIXTURE.sha(
                "registry-file"
            )
            FIXTURE.write_json(fixture.card_manifest, card_manifest)
            complete_fixture(fixture)
            invalidated_ids = {row["id"] for row in parent_rows[:11]}
            current_rows = [parent_rows[11]]
            master_dir = root / "master-v2"
            master_dir.mkdir()
            current_master = master_dir / "manifest.jsonl"
            write_jsonl(current_master, current_rows)
            registry_path = root / "catalog-registry.json"
            FIXTURE.write_json(registry_path, {"fixture": True})
            contract = projection_registry_contract(
                parent_master=fixture.master,
                current_rows=current_rows,
                invalidated_ids=invalidated_ids,
            )
            kwargs = build_kwargs(root, fixture, None)
            kwargs.update(
                {
                    "catalog_registry": registry_path,
                    "master_manifest": current_master,
                }
            )
            with (
                mock.patch.object(
                    EXPORT, "load_registry_contract", return_value=contract
                ),
                mock.patch.object(
                    EXPORT,
                    "validate_registry_master_report",
                    return_value=(
                        FIXTURE.sha("master-report"),
                        FIXTURE.sha("split-map"),
                    ),
                ),
            ):
                report = EXPORT.build_output(**kwargs)
                self.assertEqual("valid", EXPORT.validate_output(**kwargs)["status"])

            self.assertEqual(12, report["summary"]["completed_final_count"])
            self.assertEqual(11, report["summary"]["excluded_final_count"])
            self.assertEqual(1, report["summary"]["sample_count"])
            self.assertEqual(
                "registry_parent_workspace_projection",
                report["summary"]["migration_mode"],
            )
            self.assertEqual(
                EXPORT.sorted_ids_sha256(invalidated_ids),
                report["registry_exclusions"]["excluded_final_ids_sha256"],
            )
            self.assertEqual(
                contract.registry_sha256,
                report["registry_exclusions"]["catalog_registry_sha256"],
            )
            self.assertEqual(0, report["checks"]["successor_label_inheritance_count"])
            sample = read_jsonl(kwargs["output_dir"] / "samples.jsonl")[0]
            self.assertEqual(current_rows[0]["id"], sample["sample_id"])
            self.assertEqual(
                current_rows[0]["groups"]["split_component"],
                sample["groups"]["split_component"],
            )
            self.assertEqual(
                current_rows[0]["work_balance_weight"],
                sample["work_balance_weight"],
            )
            self.assertEqual("fixture-delta", sample["provenance"]["source_catalog_id"])
            self.assertEqual("hard", sample["provenance"]["source_kind"])
            self.assertEqual(
                "fixture-delta", sample["source"]["views"]["glyph_224"]["catalog_id"]
            )
            manifest = read_json(kwargs["output_dir"] / "manifest.json")
            self.assertEqual(
                contract.registry_sha256,
                manifest["input_hashes"]["catalog_registry_sha256"],
            )
            self.assertEqual(
                contract.input_attestation,
                manifest["master_registry_binding"]["attestation"],
            )
            self.assertFalse(
                manifest["master_registry_binding"][
                    "successor_label_inheritance_allowed"
                ]
            )
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "requires --catalog-registry"
            ):
                EXPORT.validate_output(
                    **{
                        key: value
                        for key, value in kwargs.items()
                        if key != "catalog_registry"
                    }
                )

            incomplete_contract = replace(
                contract,
                invalidated_parent_ids=frozenset(sorted(invalidated_ids)[:-1]),
            )
            unknown_kwargs = dict(kwargs)
            unknown_kwargs["output_dir"] = root / "unknown-exclusion-export"
            with (
                mock.patch.object(
                    EXPORT,
                    "load_registry_contract",
                    return_value=incomplete_contract,
                ),
                mock.patch.object(
                    EXPORT,
                    "validate_registry_master_report",
                    return_value=(
                        FIXTURE.sha("master-report"),
                        FIXTURE.sha("split-map"),
                    ),
                ),
                self.assertRaisesRegex(EXPORT.TrainingExportError, "unapproved reason"),
            ):
                EXPORT.build_output(**unknown_kwargs)

            tampered_rows = read_jsonl(current_master)
            tampered_rows[0]["sample_crop_sha256"] = FIXTURE.sha("tampered-crop")
            write_jsonl(current_master, tampered_rows)
            tampered_kwargs = dict(kwargs)
            tampered_kwargs["output_dir"] = root / "tampered-projection-export"
            tampered_contract = replace(
                contract,
                parent_master_manifest_sha256=EXPORT.sha256_file(fixture.master),
            )
            with (
                mock.patch.object(
                    EXPORT,
                    "load_registry_contract",
                    return_value=tampered_contract,
                ),
                mock.patch.object(
                    EXPORT,
                    "validate_registry_master_report",
                    return_value=(
                        FIXTURE.sha("master-report"),
                        FIXTURE.sha("split-map"),
                    ),
                ),
                self.assertRaisesRegex(
                    EXPORT.TrainingExportError, "sample_crop_sha256 differs"
                ),
            ):
                EXPORT.build_output(**tampered_kwargs)

    def test_staged_pilot_exports_only_completed_workspace_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            selected = ["sample-002", "sample-000", "sample-001"]
            inventory, card_manifest, secondary_count = fixture.pilot_stage(selected)
            workspace = fixture.root / "pilot-workspace"
            FIXTURE.LEDGER.initialize_workspace(
                workspace=workspace,
                master_manifest=fixture.master,
                card_manifest=card_manifest,
                font_catalog=fixture.catalog,
                render_bank=fixture.render_bank,
                catalog_version=FIXTURE.CATALOG_VERSION,
                allocation_seed=FIXTURE.ALLOCATION_SEED,
                priority_inventory=inventory,
                canonical_assignments=fixture.canonical_assignments,
                batch="pilot",
                expected_primary=fixture.sample_count,
                expected_secondary=fixture.secondary_count,
                expected_batch_primary=len(selected),
                expected_batch_secondary=secondary_count,
                expected_candidates=len(FIXTURE.CANDIDATES),
            )
            finish_workspace(
                fixture,
                workspace=workspace,
                primary_count=len(selected),
                secondary_count=secondary_count,
            )
            kwargs = build_kwargs(root, fixture, None)
            kwargs["review_workspace"] = workspace
            report = EXPORT.build_output(**kwargs)
            self.assertEqual(len(selected), report["summary"]["sample_count"])
            rows = read_jsonl(kwargs["output_dir"] / "samples.jsonl")
            self.assertEqual(set(selected), {row["sample_id"] for row in rows})
            manifest = read_json(kwargs["output_dir"] / "manifest.json")
            self.assertEqual("pilot", manifest["review_scope"]["batch"])
            self.assertEqual(
                FIXTURE.LEDGER.sha256_file(fixture.canonical_assignments),
                manifest["input_hashes"]["canonical_assignments_sha256"],
            )
            self.assertEqual(
                FIXTURE.LEDGER.sha256_file(inventory),
                manifest["input_hashes"]["priority_inventory_sha256"],
            )

    def test_build_validate_check_and_deterministic_training_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            complete_fixture(fixture)
            augmentation = write_augmentation(root, fixture)
            kwargs = build_kwargs(root, fixture, augmentation)

            report = EXPORT.build_output(**kwargs)
            self.assertEqual(4, report["summary"]["sample_count"])
            self.assertEqual(1, report["summary"]["augmentation_count"])
            self.assertEqual({"train": 2, "val": 2}, report["summary"]["by_split"])
            self.assertEqual(1, report["summary"]["abstain_sample_count"])
            self.assertEqual(0, report["checks"]["body_dialogue_cap_violation_count"])
            self.assertEqual(
                4,
                report["body_dialogue_deduplication"]["before_sample_count"],
            )
            self.assertEqual(
                4,
                report["body_dialogue_deduplication"]["after_sample_count"],
            )

            output = kwargs["output_dir"]
            manifest = read_json(output / "manifest.json")
            self.assertEqual(
                "disabled_no_safe_human_confirmed_pairs",
                manifest["contracts"]["chapter_pairs"]["status"],
            )
            self.assertEqual(
                0,
                manifest["contracts"]["chapter_pairs"]["test_pair_rows_emitted"],
            )
            self.assertIsNone(
                manifest["contracts"]["examples"]["chapter_pairs"]["file"]
            )
            self.assertNotIn(EXPORT.CHAPTER_PAIR_FILE, manifest["artifacts"])
            self.assertFalse((output / EXPORT.CHAPTER_PAIR_FILE).exists())
            self.assertEqual(0, report["summary"]["chapter_pair_count"])
            self.assertEqual(
                report["body_dialogue_deduplication"],
                manifest["contracts"]["body_dialogue_deduplication"],
            )
            samples = read_jsonl(output / "samples.jsonl")
            listwise = read_jsonl(output / "listwise.jsonl")
            pairwise = read_jsonl(output / "pairwise.jsonl")
            retrieval = read_jsonl(output / "retrieval.jsonl")
            prototypes = read_jsonl(output / "font-prototypes.jsonl")
            augmentations = read_jsonl(output / "augmentations.jsonl")
            self.assertEqual(4, len(samples))
            self.assertEqual(4, len(listwise))
            self.assertEqual(9, len(pairwise))
            self.assertEqual(4, len(retrieval))
            self.assertEqual(3, len(prototypes))
            self.assertEqual(1, len(augmentations))

            by_id = {row["sample_id"]: row for row in samples}
            sample = by_id["sample-001"]
            self.assertEqual(
                {"raw_224", "context_224", "glyph_224"},
                set(sample["source"]["views"]),
            )
            self.assertEqual("dialogue", sample["role"]["primary"])
            self.assertIn("serifness", sample["source_style"])
            self.assertEqual("vertical", sample["treatment"]["orientation"])
            self.assertEqual("inherit_work_anchor", sample["consistency"]["policy"])
            self.assertFalse(sample["provenance"]["synthetic"])
            self.assertFalse(sample["provenance"]["qa_overlay"])
            self.assertFalse(
                sample["review_provenance"]["review_card_used_as_training_input"]
            )
            self.assertTrue(sample["review_provenance"]["source_reviews"])
            self.assertTrue(
                all(
                    review["reviewer"] in {"reviewer-a", "reviewer-b"}
                    for review in sample["review_provenance"]["source_reviews"]
                )
            )
            abstain = next(row for row in retrieval if row["sample_id"] == "sample-000")
            self.assertTrue(abstain["abstain_target"])
            self.assertFalse(abstain["eligible_for_contrastive_loss"])
            self.assertEqual([], abstain["positive_candidate_ids"])
            multipositive = next(
                row for row in retrieval if row["sample_id"] == "sample-001"
            )
            self.assertEqual(
                ["family-a", "family-b"],
                multipositive["positive_candidate_ids"],
            )
            generated = augmentations[0]
            self.assertEqual("train", generated["split"])
            self.assertFalse(generated["evaluation_eligible"])
            self.assertTrue(generated["provenance"]["synthetic"])
            self.assertTrue(all(row["split"] == "train" for row in augmentations))
            self.assertTrue(
                all(
                    row["render_style"] == "normal"
                    and row["render_weight"] == 400
                    and row["render_prototypes"]
                    for row in prototypes
                )
            )

            first_bytes = {
                path.name: path.read_bytes()
                for path in output.iterdir()
                if path.is_file()
            }
            EXPORT.build_output(**kwargs)
            second_bytes = {
                path.name: path.read_bytes()
                for path in output.iterdir()
                if path.is_file()
            }
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual("valid", EXPORT.validate_output(**kwargs)["status"])
            self.assertEqual(
                0,
                EXPORT.main(
                    [
                        "build",
                        "--master-manifest",
                        str(fixture.master),
                        "--review-workspace",
                        str(fixture.workspace),
                        "--render-bank-manifest",
                        str(fixture.render_bank),
                        "--augmentation-manifest",
                        str(augmentation),
                        "--output-dir",
                        str(output),
                        "--check",
                    ]
                ),
            )

    def test_build_binds_nonempty_chapter_pair_artifact_in_manifest_and_report(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root, sample_count=6, secondary_count=2)
            master_rows = read_jsonl(fixture.master)
            for row in master_rows:
                if row["work"]["id"] == "work-00":
                    row["chapter"]["id"] = "chapter-shared"
            write_jsonl(fixture.master, master_rows)
            card_manifest = read_json(fixture.card_manifest)
            card_manifest["input_hashes"]["master_manifest_sha256"] = (
                FIXTURE.LEDGER.sha256_file(fixture.master)
            )
            FIXTURE.write_json(fixture.card_manifest, card_manifest)
            complete_fixture(fixture)
            kwargs = build_kwargs(root, fixture, None)

            report = EXPORT.build_output(**kwargs)
            self.assertEqual("valid", EXPORT.validate_output(**kwargs)["status"])
            output = kwargs["output_dir"]
            pairs = read_jsonl(output / EXPORT.CHAPTER_PAIR_FILE)
            self.assertEqual(1, len(pairs))
            self.assertEqual("ordinary_consistency_positive", pairs[0]["pair_kind"])
            manifest = read_json(output / EXPORT.MANIFEST_FILE)
            descriptor = manifest["artifacts"][EXPORT.CHAPTER_PAIR_FILE]
            self.assertEqual(1, descriptor["record_count"])
            self.assertEqual(
                EXPORT.sha256_file(output / EXPORT.CHAPTER_PAIR_FILE),
                descriptor["sha256"],
            )
            self.assertEqual(
                descriptor,
                report["outputs"][EXPORT.CHAPTER_PAIR_FILE],
            )
            self.assertEqual(
                "enabled", manifest["contracts"]["chapter_pairs"]["status"]
            )
            self.assertEqual(
                0,
                manifest["contracts"]["chapter_pairs"]["test_pair_rows_emitted"],
            )
            self.assertEqual(0, report["chapter_pairs"]["test_pair_rows_emitted"])
            self.assertEqual(0, report["chapter_pairs"]["test_pair_rows_used"])
            self.assertEqual(0, report["checks"]["chapter_pair_leakage_count"])

    def test_tampered_artifact_and_unowned_output_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            complete_fixture(fixture)
            kwargs = build_kwargs(root, fixture, None)
            EXPORT.build_output(**kwargs)
            with (kwargs["output_dir"] / "pairwise.jsonl").open("ab") as handle:
                handle.write(b"{}\n")
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "deterministic artifact mismatch"
            ):
                EXPORT.validate_output(**kwargs)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            complete_fixture(fixture)
            kwargs = build_kwargs(root, fixture, None)
            kwargs["output_dir"].mkdir()
            (kwargs["output_dir"] / "user-file.txt").write_text(
                "preserve me", encoding="utf-8"
            )
            with self.assertRaisesRegex(EXPORT.TrainingExportError, "refusing unowned"):
                EXPORT.build_output(**kwargs)

    def test_incomplete_and_unresolved_ledgers_hard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            fixture.init()
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "not complete and valid"
            ):
                EXPORT.build_output(**build_kwargs(root, fixture, None))

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            complete_fixture(fixture, adjudicate=False)
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "not complete and valid"
            ):
                EXPORT.build_output(**build_kwargs(root, fixture, None))

    def test_work_split_leakage_hard_fails_after_completed_review(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            rows = read_jsonl(fixture.master)
            next(row for row in rows if row["id"] == "sample-002")["split"] = "val"
            write_jsonl(fixture.master, rows)
            cards = read_json(fixture.card_manifest)
            cards["input_hashes"]["master_manifest_sha256"] = (
                FIXTURE.LEDGER.sha256_file(fixture.master)
            )
            FIXTURE.write_json(fixture.card_manifest, cards)
            complete_fixture(fixture)
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "work-disjoint split violation"
            ):
                EXPORT.build_output(**build_kwargs(root, fixture, None))

    def test_generated_data_is_train_only_and_qa_overlay_free(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            complete_fixture(fixture)
            validation_parent = write_augmentation(
                root, fixture, parent_sample_id="sample-001"
            )
            with self.assertRaisesRegex(EXPORT.TrainingExportError, "train-only"):
                EXPORT.build_output(**build_kwargs(root, fixture, validation_parent))

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            complete_fixture(fixture)
            overlay = write_augmentation(root, fixture, qa_overlay=True)
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "invalid train-only provenance"
            ):
                EXPORT.build_output(**build_kwargs(root, fixture, overlay))

    def test_master_and_render_qa_or_synthetic_inputs_hard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            rows = read_jsonl(fixture.master)
            rows[0]["provenance"]["synthetic"] = True
            write_jsonl(fixture.master, rows)
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "synthetic or QA-overlay"
            ):
                EXPORT.read_master_rows(fixture.master)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = prepare_fixture(root)
            bank = read_json(fixture.render_bank)
            bank["renders"][0]["artifact"]["qa_overlay"] = True
            FIXTURE.write_json(fixture.render_bank, bank)
            with self.assertRaisesRegex(
                EXPORT.TrainingExportError, "QA-overlay render"
            ):
                EXPORT.read_render_bank_rows(
                    fixture.render_bank,
                    expected_candidate_count=len(FIXTURE.CANDIDATES),
                )


if __name__ == "__main__":
    unittest.main()
