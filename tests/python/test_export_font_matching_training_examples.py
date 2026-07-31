from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path


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


def prepare_fixture(root: Path) -> object:
    inputs = root / "inputs"
    inputs.mkdir(parents=True)
    fixture = FIXTURE.Fixture(inputs)

    master_rows = read_jsonl(fixture.master)
    for row in master_rows:
        row["split"] = "train" if row["work"]["id"] == "work-00" else "val"
        for view_name, descriptor in row["views"].items():
            descriptor.update(
                {
                    "catalog_id": "fixture-source",
                    "expected_size_px": [224, 224],
                    "path": f"assets/{row['id']}/{view_name}.png",
                }
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


class TrainingExampleExportTest(unittest.TestCase):
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

            output = kwargs["output_dir"]
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
