from __future__ import annotations

import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping
from unittest import mock

import numpy as np
import torch
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str, path: Path) -> Any:
    specification = importlib.util.spec_from_file_location(name, path)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


TRAINER = load_script(
    "train_font_matching_siglip_baseline_tested",
    SCRIPTS / "train_font_matching_siglip_baseline.py",
)
EVALUATOR_FIXTURE = load_script(
    "evaluate_font_matching_v2_fixture_for_siglip",
    Path(__file__).with_name("test_evaluate_font_matching_v2.py"),
)
FONT_SIGNAL_FINALIZER_FIXTURE = load_script(
    "font_signal_audit_finalizer_fixture_for_siglip",
    Path(__file__).with_name("test_finalize_font_matching_font_signal_audit.py"),
)


SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64


def fake_font_signal_audit(
    *,
    records: Mapping[str, Any] | None = None,
    review_ready_sample_ids: frozenset[str] = frozenset(),
) -> Any:
    records = dict(records or {})
    audited_ids = set(records)
    excluded_ids = {
        sample_id
        for sample_id, record in records.items()
        if record.outcome != "font_signal_present"
    }
    return TRAINER.FontSignalAuditSnapshot(
        root=Path("fake-font-signal-audit"),
        marker_sha256=SHA_A,
        ledger_sha256=SHA_B,
        report_sha256=SHA_C,
        records_by_sample_id=records,
        outcome_counts={
            outcome: sum(record.outcome == outcome for record in records.values())
            for outcome in TRAINER.FONT_SIGNAL_AUDIT_OUTCOMES
        },
        audited_sample_ids_sha256=TRAINER._sorted_ids_sha256(audited_ids),
        excluded_sample_ids_sha256=TRAINER._sorted_ids_sha256(excluded_ids),
        review_ready_sample_ids=review_ready_sample_ids,
        review_ready_sample_ids_sha256=TRAINER._sorted_ids_sha256(
            review_ready_sample_ids
        ),
    )


def make_example(
    sample_id: str,
    *,
    split: str,
    work_id: str,
    candidate_count: int = 3,
    none_target: float = 0.0,
    work_weight: float = 1.0,
    priority: int = 2,
    role_index: int = 0,
    chapter_id: str = "chapter-a",
    consistency_action: str = "undetermined",
    label_quality_weight: float = 1.0,
) -> Any:
    gains = tuple(
        float(max(0, candidate_count - index)) for index in range(candidate_count)
    )
    mask = tuple(index < candidate_count - 1 for index in range(candidate_count))
    return TRAINER.TrainingExample(
        sample_id=sample_id,
        work_id=work_id,
        split=split,
        sample_record_sha256=TRAINER.sha256_bytes(f"sample:{sample_id}".encode()),
        listwise_record_sha256=TRAINER.sha256_bytes(f"listwise:{sample_id}".encode()),
        candidate_gains=gains,
        candidate_loss_mask=mask,
        pairwise_indices=((0, 1, 1),),
        none_target=none_target,
        role_index=role_index,
        style_values=tuple(index / 10 for index in range(len(TRAINER.STYLE_FIELDS))),
        style_mask=tuple(index % 2 == 0 for index in range(len(TRAINER.STYLE_FIELDS))),
        treatment_indices=tuple(0 for _ in TRAINER.TREATMENT_VALUES),
        work_balance_weight=work_weight,
        chapter_id=chapter_id,
        page_id=f"page-{sample_id}",
        variant_class=TRAINER.PRIORITY_NAMES[priority],
        priority=priority,
        consistency_action=consistency_action,
        label_quality_weight=label_quality_weight,
    )


class FakeResolvedImage:
    def __init__(
        self,
        *,
        color: tuple[int, int, int],
        size: tuple[int, int] = (224, 224),
        sample_id: str = "sample",
        view_name: str = "view",
    ) -> None:
        self.image = Image.new("RGB", size, color)
        self.mode = self.image.mode
        self.size = self.image.size
        self.pixel_sha256 = TRAINER.catalog_assets.pixel_sha256(self.image)
        self.source_file_sha256 = TRAINER.sha256_bytes(
            f"{sample_id}:{view_name}:{color}:{size}".encode()
        )
        self.sample_id = sample_id
        self.view_name = view_name
        self.materialized = False
        self.status = "available"

    def __enter__(self) -> FakeResolvedImage:
        return self

    def __exit__(self, *_: object) -> None:
        self.image.close()

    def evidence(self) -> dict[str, Any]:
        return {
            "catalog_id": "catalog-a",
            "materialized": self.materialized,
            "pixel_sha256": self.pixel_sha256,
            "source_file_sha256": self.source_file_sha256,
            "status": self.status,
        }


class FakeResolver:
    registry_sha256 = SHA_A

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def resolve_sample_view(
        self, sample: Mapping[str, Any], view_name: str
    ) -> FakeResolvedImage:
        split = str(sample["split"])
        sample_id = str(sample["sample_id"])
        self.calls.append((sample_id, split, view_name))
        view_index = TRAINER.VIEW_NAMES.index(view_name)
        split_index = {"train": 1, "val": 2, "test": 3}[split]
        return FakeResolvedImage(
            color=(20 * split_index, 30 * (view_index + 1), 40),
            sample_id=sample_id,
            view_name=view_name,
        )


class FakePrototype(FakeResolvedImage):
    def __init__(
        self,
        *,
        render_id: str,
        font_id: str,
        writing_mode: str,
    ) -> None:
        size = (448, 224) if writing_mode == "horizontal" else (224, 480)
        super().__init__(
            color=(235, 230, 225),
            size=size,
            sample_id=render_id,
            view_name=writing_mode,
        )
        self.render_id = render_id
        self.font_id = font_id
        self.candidate_display_id = f"display-{font_id}"
        self.blind_alias = f"blind-{font_id}"
        self.probe_id = f"probe-{writing_mode}"
        self.writing_mode = writing_mode
        self.image_file = f"images/{render_id}.png"
        self.source_font_sha256 = SHA_B


class FakeRenderBank:
    manifest_sha256 = SHA_B
    specification_sha256 = SHA_C

    def __init__(self) -> None:
        self.prototype_evidence = (
            {"render_id": "render-a"},
            {"render_id": "render-b"},
        )
        self.calls: list[str] = []

    def resolve_prototype(self, render_id: str) -> FakePrototype:
        self.calls.append(render_id)
        if render_id == "render-a":
            return FakePrototype(
                render_id=render_id,
                font_id="font-a",
                writing_mode="horizontal",
            )
        return FakePrototype(
            render_id=render_id,
            font_id="font-b",
            writing_mode="vertical",
        )


class FakeExtractor:
    feature_dim = 4

    def __init__(self) -> None:
        self.sizes: list[tuple[int, int]] = []

    def encode(self, images: list[Image.Image]) -> np.ndarray:
        rows = []
        for image in images:
            self.sizes.append(image.size)
            pixels = np.asarray(image, dtype=np.float32)
            rows.append(
                [
                    float(pixels[..., 0].mean() / 255.0),
                    float(pixels[..., 1].mean() / 255.0),
                    float(pixels[..., 2].mean() / 255.0),
                    float(pixels.std() / 255.0),
                ]
            )
        return np.asarray(rows, dtype=np.float32)


def fake_corpus() -> Any:
    samples = {
        sample_id: {
            "sample_id": sample_id,
            "split": split,
            "record_sha256": TRAINER.sha256_bytes(f"record:{sample_id}".encode()),
        }
        for sample_id, split in (
            ("sample-train", "train"),
            ("sample-val", "val"),
            ("sample-test", "test"),
        )
    }
    examples = {
        sample_id: make_example(
            sample_id,
            split=str(sample["split"]),
            work_id=f"work-{sample_id}",
            candidate_count=2,
        )
        for sample_id, sample in samples.items()
    }
    return TRAINER.TrainingCorpus(
        export=SimpleNamespace(
            samples_sha256=SHA_A,
            manifest_sha256=SHA_B,
        ),
        samples_by_id=samples,
        examples_by_id=examples,
        candidate_ids=("font-a", "font-b"),
        font_catalog_sha256=SHA_C,
        listwise_sha256=SHA_A,
        pairwise_sha256=SHA_B,
        retrieval_sha256=SHA_C,
        prototype_sha256=TRAINER.sha256_bytes(b"prototypes"),
        font_signal_audit=fake_font_signal_audit(),
    )


class FrozenSiglipBaselineTests(unittest.TestCase):
    def test_encoder_pin_is_exact_and_transformers_import_is_lazy(self) -> None:
        self.assertEqual(TRAINER.ENCODER_ID, "google/siglip2-base-patch16-224")
        self.assertEqual(
            TRAINER.ENCODER_REVISION,
            "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2",
        )
        self.assertEqual(TRAINER.ENCODER_CLASS, "SiglipVisionModel")
        self.assertFalse(TRAINER.PROCESSOR_USE_FAST)
        self.assertNotIn("transformers", TRAINER.__dict__)
        self.assertEqual(
            TRAINER.EXPORTED_AUGMENTATION_SCHEMA_VERSION,
            "font-matching-train-only-augmentation-v1",
        )

    def test_frozen_test_manifest_is_deterministic_and_binds_every_authority(
        self,
    ) -> None:
        corpus = fake_corpus()
        first = TRAINER.build_frozen_test_manifest(corpus)
        second = TRAINER.build_frozen_test_manifest(corpus)
        self.assertEqual(first, second)
        self.assertEqual(first["boundary"]["split"], "test")
        self.assertEqual(first["test_row_count"], 1)
        self.assertEqual(
            TRAINER.frozen_test_manifest_sha256(corpus), first["record_sha256"]
        )

        test_example = corpus.examples_by_id["sample-test"]
        mutations = (
            TRAINER.replace(
                corpus,
                examples_by_id={
                    **corpus.examples_by_id,
                    "sample-test": TRAINER.replace(
                        test_example, listwise_record_sha256="d" * 64
                    ),
                },
            ),
            TRAINER.replace(corpus, candidate_ids=("font-a", "font-c")),
            TRAINER.replace(corpus, font_catalog_sha256="d" * 64),
            TRAINER.replace(
                corpus,
                export=SimpleNamespace(
                    samples_sha256=SHA_A,
                    manifest_sha256="d" * 64,
                ),
            ),
        )
        for mutated in mutations:
            self.assertNotEqual(
                TRAINER.frozen_test_manifest_sha256(mutated),
                first["record_sha256"],
            )

        resolver = SimpleNamespace(registry_sha256=SHA_A)
        render_bank = SimpleNamespace(
            manifest_sha256=SHA_B, specification_sha256=SHA_C
        )
        contract = TRAINER._input_contract(
            resolver=resolver,
            render_bank=render_bank,
            corpus=corpus,
            asset_validation_report_sha256=None,
        )
        self.assertEqual(
            contract["frozen_test_manifest_sha256"], first["record_sha256"]
        )

    def test_frozen_test_manifest_rejects_missing_or_leaking_test_split(self) -> None:
        corpus = fake_corpus()
        without_test = TRAINER.replace(
            corpus,
            examples_by_id={
                key: value
                for key, value in corpus.examples_by_id.items()
                if value.split != "test"
            },
        )
        with self.assertRaisesRegex(TRAINER.TrainerError, "at least one test"):
            TRAINER.build_frozen_test_manifest(without_test)
        leaking = TRAINER.replace(
            corpus,
            examples_by_id={
                **corpus.examples_by_id,
                "sample-test": TRAINER.replace(
                    corpus.examples_by_id["sample-test"],
                    work_id=corpus.examples_by_id["sample-val"].work_id,
                ),
            },
        )
        with self.assertRaisesRegex(TRAINER.TrainerError, "work leakage"):
            TRAINER.build_frozen_test_manifest(leaking)

    def _full22_successor_fixture(self) -> tuple[Any, dict, Any]:
        parent_sha = "d" * 64
        identity = {
            "chapter_id": "chapter-a",
            "page_id": "page-a",
            "sample_id": "sample-a",
            "source_page_sha256": "e" * 64,
            "work_id": "work-a",
        }
        successor = {
            "parent_identity": copy.deepcopy(identity),
            "parent_training_sample_record_sha256": parent_sha,
            "relationship": TRAINER.FONT_SIGNAL_SUCCESSOR_RELATIONSHIP,
            "schema_version": TRAINER.FONT_SIGNAL_SUCCESSOR_SCHEMA_VERSION,
        }
        authority = {
            "all_22_candidates_retained_for_utility_audit": True,
            "candidate_count": 22,
            "catalog_disposition_record_sha256": None,
            "eligibility_exceptions_excluded": True,
            "formal_calibration_gate_passed": False,
            "old_tier_mutation_allowed": False,
            "provisional_catalog_record_sha256": None,
            "resolved_label_file": "resolved-labels-full22.jsonl",
            "schema_version": TRAINER.FULL22_AUTHORITY_SCHEMA_VERSION,
            "selection_mode": "unfinalized_exact_independent_consensus_only",
            "tier_merge": "immutable_prior15_plus_exact_resolved_delta7",
            "top1_synthesis_allowed": False,
            "training_only": True,
            "training_quarantine_excluded": True,
        }
        sample = TRAINER.seal_record(
            {
                "chapter_id": identity["chapter_id"],
                "page_id": identity["page_id"],
                "provenance": {
                    "font_signal_audit_successor": copy.deepcopy(successor),
                    "full22_release_state": "provisional_training_only",
                    "qa_overlay": False,
                    "synthetic": False,
                },
                "review_provenance": {
                    "authority": {
                        **copy.deepcopy(authority),
                        "font_signal_audit_successor": copy.deepcopy(successor),
                    }
                },
                "sample_id": identity["sample_id"],
                "source": {"source_page_sha256": identity["source_page_sha256"]},
                "work_id": identity["work_id"],
            }
        )
        export = SimpleNamespace(
            candidate_count=22,
            manifest={
                "candidate_count": 22,
                "contracts": {"provisional_full22": copy.deepcopy(authority)},
            },
        )
        audited = TRAINER.FontSignalAuditRecord(
            sample_id=identity["sample_id"],
            work_id=identity["work_id"],
            chapter_id=identity["chapter_id"],
            page_id=identity["page_id"],
            source_page_sha256=identity["source_page_sha256"],
            training_sample_record_sha256=parent_sha,
            outcome="font_signal_present",
        )
        return export, sample, audited

    def test_font_signal_binding_accepts_direct_sha_or_exact_full22_successor(
        self,
    ) -> None:
        export, successor, audited = self._full22_successor_fixture()
        TRAINER._validate_font_signal_training_sample_binding(
            export=export,
            sample=successor,
            audited=audited,
            location="samples[0]",
        )
        direct_audit = TRAINER.replace(
            audited,
            training_sample_record_sha256=successor["record_sha256"],
        )
        ordinary_export = SimpleNamespace(manifest={"contracts": {}})
        TRAINER._validate_font_signal_training_sample_binding(
            export=ordinary_export,
            sample=successor,
            audited=direct_audit,
            location="samples[0]",
        )

    def test_font_signal_successor_rejects_missing_or_tampered_parent_binding(
        self,
    ) -> None:
        export, sample, audited = self._full22_successor_fixture()
        missing = copy.deepcopy(sample)
        missing["provenance"].pop("font_signal_audit_successor")
        missing = TRAINER.seal_record(missing)
        tampered = copy.deepcopy(sample)
        tampered_binding = tampered["provenance"]["font_signal_audit_successor"]
        tampered_binding["parent_training_sample_record_sha256"] = "f" * 64
        tampered["review_provenance"]["authority"]["font_signal_audit_successor"] = (
            copy.deepcopy(tampered_binding)
        )
        tampered = TRAINER.seal_record(tampered)
        identity_tampered = copy.deepcopy(sample)
        for binding in (
            identity_tampered["provenance"]["font_signal_audit_successor"],
            identity_tampered["review_provenance"]["authority"][
                "font_signal_audit_successor"
            ],
        ):
            binding["parent_identity"]["page_id"] = "page-tampered"
        identity_tampered = TRAINER.seal_record(identity_tampered)

        for changed in (missing, tampered, identity_tampered):
            with (
                self.subTest(changed=changed),
                self.assertRaisesRegex(
                    TRAINER.TrainerError,
                    "font-signal audit/training sample binding mismatch",
                ),
            ):
                TRAINER._validate_font_signal_training_sample_binding(
                    export=export,
                    sample=changed,
                    audited=audited,
                    location="samples[0]",
                )

    def test_general_export_cannot_claim_successor_sha_bypass(self) -> None:
        _export, sample, audited = self._full22_successor_fixture()
        ordinary_export = SimpleNamespace(
            candidate_count=22,
            manifest={"candidate_count": 22, "contracts": {}},
        )
        with self.assertRaisesRegex(
            TRAINER.TrainerError, "font-signal audit/training sample binding mismatch"
        ):
            TRAINER._validate_font_signal_training_sample_binding(
                export=ordinary_export,
                sample=sample,
                audited=audited,
                location="samples[0]",
            )

    def _full22_projection_fixture(self) -> tuple[Any, Any, set[str]]:
        authority_export, _sample, present_record = self._full22_successor_fixture()
        selected_ids = {present_record.sample_id}
        omitted_ready_id = "sample-ready-omitted"
        excluded_record = TRAINER.FontSignalAuditRecord(
            sample_id="sample-blocked",
            work_id="work-blocked",
            chapter_id="chapter-blocked",
            page_id="page-blocked",
            source_page_sha256="f" * 64,
            training_sample_record_sha256="1" * 64,
            outcome="font_signal_absent",
        )
        audit = fake_font_signal_audit(
            records={
                present_record.sample_id: present_record,
                excluded_record.sample_id: excluded_record,
            },
            review_ready_sample_ids=frozenset(
                {present_record.sample_id, omitted_ready_id}
            ),
        )
        parent_ids = set(audit.review_ready_sample_ids) | set(audit.excluded_sample_ids)
        projection = {
            "audit_inventory_reconciliation": (
                TRAINER.FONT_SIGNAL_AUDIT_PROJECTION_RECONCILIATION
            ),
            "excluded_audit_outcomes_must_be_absent": True,
            "omitted_parent_sample_count": len(parent_ids - selected_ids),
            "omitted_parent_sample_ids_sha256": TRAINER._sorted_ids_sha256(
                parent_ids - selected_ids
            ),
            "parent_training_sample_count": len(parent_ids),
            "parent_training_sample_ids_sha256": TRAINER._sorted_ids_sha256(parent_ids),
            "review_ready_subset_required": True,
            "schema_version": TRAINER.FONT_SIGNAL_AUDIT_PROJECTION_SCHEMA_VERSION,
            "selected_training_sample_count": len(selected_ids),
            "selected_training_sample_ids_sha256": TRAINER._sorted_ids_sha256(
                selected_ids
            ),
            "selection_authority_schema_version": (
                TRAINER.FULL22_AUTHORITY_SCHEMA_VERSION
            ),
            "selection_mode": "unfinalized_exact_independent_consensus_only",
        }
        export = SimpleNamespace(
            candidate_count=22,
            manifest={
                **copy.deepcopy(authority_export.manifest),
                "review_scope": {"source_selected_count": len(parent_ids)},
            },
        )
        export.manifest["contracts"]["font_signal_audit_projection"] = projection
        return export, audit, selected_ids

    def test_full22_projection_accepts_exact_review_ready_subset(self) -> None:
        export, audit, selected_ids = self._full22_projection_fixture()
        TRAINER._validate_full22_font_signal_audit_projection(
            export=export,
            font_signal_audit=audit,
            selected_sample_ids=selected_ids,
        )

    def test_full22_projection_rejects_blocked_or_tampered_subset(self) -> None:
        export, audit, selected_ids = self._full22_projection_fixture()
        blocked_ids = {"sample-blocked"}
        with self.assertRaisesRegex(TRAINER.TrainerError, "digest mismatch"):
            TRAINER._validate_full22_font_signal_audit_projection(
                export=export,
                font_signal_audit=audit,
                selected_sample_ids=blocked_ids,
            )

        chain_valid_blocked = copy.deepcopy(export)
        parent_ids = set(audit.review_ready_sample_ids) | set(audit.excluded_sample_ids)
        projection = chain_valid_blocked.manifest["contracts"][
            "font_signal_audit_projection"
        ]
        projection["selected_training_sample_count"] = len(blocked_ids)
        projection["selected_training_sample_ids_sha256"] = TRAINER._sorted_ids_sha256(
            blocked_ids
        )
        projection["omitted_parent_sample_count"] = len(parent_ids - blocked_ids)
        projection["omitted_parent_sample_ids_sha256"] = TRAINER._sorted_ids_sha256(
            parent_ids - blocked_ids
        )
        with self.assertRaisesRegex(
            TRAINER.TrainerError, "not an exact subset of the review-ready inventory"
        ):
            TRAINER._validate_full22_font_signal_audit_projection(
                export=chain_valid_blocked,
                font_signal_audit=audit,
                selected_sample_ids=blocked_ids,
            )

        changed = copy.deepcopy(export)
        changed.manifest["contracts"]["font_signal_audit_projection"][
            "parent_training_sample_ids_sha256"
        ] = ("0" * 64)
        with self.assertRaisesRegex(TRAINER.TrainerError, "digest mismatch"):
            TRAINER._validate_full22_font_signal_audit_projection(
                export=changed,
                font_signal_audit=audit,
                selected_sample_ids=selected_ids,
            )

    def test_required_font_signal_audit_loader_accepts_only_sealed_projection(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = FONT_SIGNAL_FINALIZER_FIXTURE.Fixture(root)
            output = root / "sealed-font-signal-audit"
            finalizer = FONT_SIGNAL_FINALIZER_FIXTURE.FINALIZER
            args = finalizer.build_argument_parser().parse_args(
                [
                    "finalize",
                    "--rescue-inputs",
                    str(fixture.source),
                    "--decisions",
                    str(fixture.decisions_path),
                    "--output",
                    str(output),
                ]
            )
            self.assertEqual(finalizer.finalize(args), 0)
            audit = TRAINER.load_font_signal_audit(output)
            expected_excluded = {
                row["sample_id"]
                for row in fixture.decisions
                if row["outcome"] != "font_signal_present"
            }
            self.assertEqual(audit.excluded_sample_ids, expected_excluded)
            self.assertEqual(
                audit.ledger_sha256,
                TRAINER.sha256_file(output / finalizer.LEDGER_FILE),
            )
            self.assertEqual(
                audit.report_sha256,
                TRAINER.sha256_file(output / finalizer.REPORT_FILE),
            )
            self.assertEqual(
                len(audit.review_ready_sample_ids),
                len(fixture.selections) - len(expected_excluded),
            )

            report_path = output / finalizer.REPORT_FILE
            report_path.write_bytes(report_path.read_bytes() + b" ")
            with self.assertRaisesRegex(TRAINER.TrainerError, "file binding"):
                TRAINER.load_font_signal_audit(output)

    def test_multitask_loss_backpropagates_and_candidate_bags_expand(self) -> None:
        TRAINER.seed_everything(91)
        model = TRAINER.build_ranker(
            feature_dim=8,
            hidden_dim=6,
            view_dropout=0.25,
            head_dropout=0.0,
        )
        model.train()
        views = torch.randn(2, 3, 8)
        prototypes = torch.randn(5, 8)
        bags = (
            torch.tensor([0, 1]),
            torch.tensor([2]),
            torch.tensor([3, 4]),
        )
        examples = (
            make_example("a", split="train", work_id="work-a", work_weight=0.5),
            make_example(
                "b",
                split="train",
                work_id="work-b",
                none_target=1.0,
                work_weight=1.5,
            ),
        )
        outputs = model(views, prototypes, bags)
        loss, components = TRAINER.compute_multitask_loss(
            outputs=outputs,
            examples=examples,
            hyperparameters=TRAINER.TrainingHyperparameters(),
        )
        scaled_examples = tuple(
            TRAINER.replace(item, work_balance_weight=item.work_balance_weight * 10.0)
            for item in examples
        )
        scaled_loss, scaled_components = TRAINER.compute_multitask_loss(
            outputs=outputs,
            examples=scaled_examples,
            hyperparameters=TRAINER.TrainingHyperparameters(),
        )
        self.assertTrue(torch.allclose(loss, scaled_loss))
        for name in components:
            self.assertTrue(
                torch.allclose(components[name], scaled_components[name]), name
            )
        self.assertTrue(torch.isfinite(loss))
        self.assertEqual(
            set(components),
            {"listwise", "pairwise", "none", "role", "style", "treatment", "total"},
        )
        loss.backward()
        self.assertTrue(
            all(parameter.grad is not None for parameter in model.parameters())
        )
        self.assertFalse(
            any(
                "candidate_id" in name or "embedding" in name
                for name, _ in model.named_parameters()
            )
        )

        expanded = model(
            views,
            torch.randn(6, 8),
            (*bags, torch.tensor([5])),
        )
        self.assertEqual(tuple(expanded["candidate_scores"].shape), (2, 4))

    def test_train_only_priority_sampler_hits_60_15_25_mix_deterministically(
        self,
    ) -> None:
        examples = tuple(
            make_example(
                f"sample-{index}",
                split="train",
                work_id=f"work-{index % 4}",
                priority=(0 if index < 2 else 1 if index < 5 else 2),
                role_index=index % 4,
                work_weight=1.0 / (1 + index % 4),
                label_quality_weight=0.8 + (index % 3) * 0.1,
            )
            for index in range(20)
        )
        weighted, contract = TRAINER.prepare_variant_training_examples(examples)
        self.assertAlmostEqual(
            sum(item.training_weight for item in weighted) / len(weighted), 1.0
        )
        self.assertLessEqual(
            max(item.training_weight for item in weighted),
            TRAINER.MAX_TRAINING_EXAMPLE_WEIGHT,
        )
        self.assertEqual(
            contract["formula"],
            "work_balance_x_role_effective_number_x_label_quality",
        )
        self.assertEqual(
            contract["variant_priority_application"],
            "sampler_only_no_duplicate_per_sample_multiplier",
        )
        self.assertEqual(
            contract["loss_batch_weight_normalization"],
            "mean_one_capped_reprojection",
        )
        first, first_contract = TRAINER.build_priority_epoch_batches(
            weighted, batch_size=6, seed=771
        )
        second, second_contract = TRAINER.build_priority_epoch_batches(
            weighted, batch_size=6, seed=771
        )
        self.assertEqual(
            [batch.tolist() for batch in first],
            [batch.tolist() for batch in second],
        )
        self.assertEqual(first_contract, second_contract)
        self.assertEqual(first_contract["priority_counts"], {"0": 3, "1": 12, "2": 5})
        self.assertTrue(first_contract["replacement_used"])
        self.assertTrue(all(item.training_weight is None for item in examples))

        neutral = tuple(
            make_example(
                f"neutral-{priority}",
                split="train",
                work_id=f"neutral-work-{priority}",
                priority=priority,
                role_index=0,
                work_weight=1.0,
                label_quality_weight=1.0,
            )
            for priority in (0, 1, 2)
        )
        neutral_weighted, _ = TRAINER.prepare_variant_training_examples(neutral)
        self.assertEqual(
            [item.training_weight for item in neutral_weighted], [1.0, 1.0, 1.0]
        )

    def test_chapter_pair_losses_are_directional_and_reject_test_pairs(self) -> None:
        anchor = TRAINER.replace(
            make_example(
                "anchor",
                split="train",
                work_id="work-a",
                chapter_id="chapter-a",
                consistency_action="inherit_anchor",
            ),
            candidate_gains=(3.0, 0.0, 0.0),
            candidate_loss_mask=(True, True, True),
        )
        local = TRAINER.replace(
            make_example(
                "local",
                split="train",
                work_id="work-a",
                priority=1,
                chapter_id="chapter-a",
                consistency_action="local_override",
            ),
            candidate_gains=(0.0, 0.0, 3.0),
            candidate_loss_mask=(True, True, True),
        )
        scores = torch.tensor([[5.0, 0.0, -1.0], [5.0, 0.0, -1.0]], requires_grad=True)
        pair = TRAINER.ChapterPair(
            pair_id="pair-a",
            kind="local_override_margin",
            split="train",
            chapter_id="chapter-a",
            role="dialogue",
            anchor_sample_id="anchor",
            target_sample_id="local",
            record_sha256=SHA_A,
        )
        total, components = TRAINER.compute_chapter_pair_losses(
            outputs={"candidate_scores": scores},
            examples=(anchor, local),
            pairs=(pair,),
            hyperparameters=TRAINER.TrainingHyperparameters(),
        )
        self.assertGreater(float(components["local_override"].detach().cpu()), 0.0)
        total.backward()
        self.assertIsNotNone(scores.grad)

        test_pair = TRAINER.replace(pair, split="test")
        with self.assertRaisesRegex(TRAINER.TrainerError, "test chapter pair"):
            TRAINER.compute_chapter_pair_losses(
                outputs={"candidate_scores": scores.detach()},
                examples=(anchor, local),
                pairs=(test_pair,),
                hyperparameters=TRAINER.TrainingHyperparameters(),
            )

    def test_variant_validation_metrics_drive_checkpoint_with_ordinary_gate(
        self,
    ) -> None:
        examples = (
            make_example(
                "p1-shout",
                split="val",
                work_id="work-a",
                priority=1,
                role_index=TRAINER.ROLE_VALUES.index("shout"),
            ),
            make_example(
                "p1-sfx",
                split="val",
                work_id="work-b",
                priority=1,
                role_index=TRAINER.ROLE_VALUES.index("sfx_impact"),
            ),
            make_example(
                "ordinary",
                split="val",
                work_id="work-c",
                priority=2,
            ),
            make_example(
                "none",
                split="val",
                work_id="work-d",
                priority=0,
                none_target=1.0,
            ),
        )
        baseline = TRAINER.compute_validation_metrics(
            candidate_scores=np.asarray(
                [[3.0, 2.0, 0.0], [0.0, 1.0, 3.0], [3.0, 2.0, 0.0], [0.0, 1.0, 3.0]],
                dtype=np.float32,
            ),
            none_logits=np.asarray([-3.0, -3.0, -3.0, 3.0], dtype=np.float32),
            examples=examples,
            chapter_pairs=(),
        )
        regressed = TRAINER.compute_validation_metrics(
            candidate_scores=np.asarray(
                [[4.0, 1.0, 0.0], [4.0, 1.0, 0.0], [0.0, 1.0, 4.0], [0.0, 1.0, 3.0]],
                dtype=np.float32,
            ),
            none_logits=np.asarray([-3.0, -3.0, -3.0, 3.0], dtype=np.float32),
            examples=examples,
            chapter_pairs=(),
        )
        gate = TRAINER.ordinary_regression_gate(
            metrics=regressed, baseline_metrics=baseline
        )
        self.assertFalse(gate["passed"])
        self.assertEqual(
            set(regressed["role_recall_at_3"]),
            {"dialogue", "shout", "sfx_impact"},
        )
        self.assertEqual(regressed["none_at_fixed_0_5"]["overall"]["f1"], 1.0)
        self.assertIsNone(
            regressed["chapter"]["unnecessary_body_font_switches_per_100"]
        )
        self.assertGreater(
            TRAINER.checkpoint_selection_key(metrics=regressed, val_loss=2.0),
            TRAINER.checkpoint_selection_key(metrics=baseline, val_loss=1.0),
        )

    def test_production_ordinary_gate_requires_twenty_priority2_samples(
        self,
    ) -> None:
        def metrics(count: int) -> dict[str, Any]:
            return {"priority": {"2": {"acceptable_at_1": 1.0, "sample_count": count}}}

        nineteen = TRAINER.ordinary_regression_gate(
            metrics=metrics(19),
            baseline_metrics=metrics(19),
            production_reference_required=True,
        )
        self.assertFalse(nineteen["passed"])
        self.assertFalse(nineteen["sample_count_requirement_met"])
        self.assertEqual(nineteen["minimum_sample_count"], 20)
        diagnostic_nineteen = TRAINER.ordinary_regression_gate(
            metrics=metrics(19), baseline_metrics=metrics(19)
        )
        self.assertTrue(diagnostic_nineteen["passed"])
        self.assertFalse(diagnostic_nineteen["production_reference_required"])

        twenty = TRAINER.ordinary_regression_gate(
            metrics=metrics(20),
            baseline_metrics=metrics(20),
            production_reference_required=True,
        )
        self.assertTrue(twenty["passed"])
        self.assertTrue(twenty["sample_count_requirement_met"])
        self.assertEqual(twenty["baseline_sample_count"], 20)
        self.assertEqual(twenty["current_sample_count"], 20)

        with self.assertRaisesRegex(TRAINER.TrainerError, "sample_count drifted"):
            TRAINER.ordinary_regression_gate(
                metrics=metrics(20),
                baseline_metrics=metrics(21),
                production_reference_required=True,
            )

        safety = {
            "baseline_status": "production_reference",
            "best_ordinary_regression_gate": twenty,
            "optimizer_seeded_from_ordinary_reference": False,
            "ordinary_acceptable_at_1_regression_limit": (
                TRAINER.ORDINARY_TOP1_REGRESSION_LIMIT
            ),
            "ordinary_reference_argument_seeded_optimizer": False,
            "reference": {
                "checkpoint_sha256": SHA_A,
                "model_contract_sha256": SHA_B,
                "optimizer_seed_allowed": False,
                "output_marker_sha256": SHA_C,
                "report_sha256": SHA_A,
                "source_code_sha256": SHA_B,
                "source_inputs_sha256": SHA_C,
                "test_pixels_opened_from_reference": 0,
                "usage": "evaluation_only_ordinary_regression_baseline",
            },
            "resume_requires_separate_resume_from_argument": True,
        }
        TRAINER._validate_ordinary_regression_safety(
            safety, expected_priority2_sample_count=20
        )
        tampered = copy.deepcopy(safety)
        tampered["best_ordinary_regression_gate"]["current_sample_count"] = 19
        with self.assertRaisesRegex(TRAINER.TrainerError, "sample_count contract"):
            TRAINER._validate_ordinary_regression_safety(
                tampered, expected_priority2_sample_count=20
            )
        with self.assertRaisesRegex(TRAINER.TrainerError, "contract is missing"):
            TRAINER._validate_ordinary_regression_safety(
                None, expected_priority2_sample_count=20
            )

    def test_missing_chapter_pair_artifact_is_explicitly_disabled(self) -> None:
        corpus = fake_corpus()
        self.assertEqual(corpus.chapter_pair_contract["status"], "disabled")
        self.assertEqual(
            corpus.chapter_pair_contract["losses"],
            {
                "chapter_anchor_consistency": "disabled",
                "local_override_margin": "disabled",
            },
        )
        self.assertEqual(corpus.chapter_pair_contract["test_pair_rows_used"], 0)

    def test_sealed_chapter_pair_contract_keeps_test_rows_out_of_development(
        self,
    ) -> None:
        examples = {
            "anchor": make_example(
                "anchor",
                split="train",
                work_id="work-a",
                chapter_id="chapter-a",
                consistency_action="inherit_anchor",
            ),
            "member": make_example(
                "member",
                split="train",
                work_id="work-a",
                chapter_id="chapter-a",
                consistency_action="inherit_anchor",
            ),
            "local": make_example(
                "local",
                split="train",
                work_id="work-a",
                chapter_id="chapter-a",
                priority=1,
                consistency_action="local_override",
            ),
            "test-anchor": make_example(
                "test-anchor",
                split="test",
                work_id="work-test",
                chapter_id="chapter-test",
                consistency_action="inherit_anchor",
            ),
            "test-member": make_example(
                "test-member",
                split="test",
                work_id="work-test",
                chapter_id="chapter-test",
                consistency_action="inherit_anchor",
            ),
        }
        samples = {}
        for sample_id, example in examples.items():
            samples[sample_id] = {
                "record_sha256": example.sample_record_sha256,
                "review_provenance": {"final_record_sha256": SHA_B},
            }

        def pair_row(
            pair_id: str,
            kind: str,
            split: str,
            chapter_id: str,
            anchor_id: str,
            target_id: str,
        ) -> dict[str, Any]:
            return TRAINER.seal_record(
                {
                    "anchor_label_record_sha256": SHA_B,
                    "anchor_sample_id": anchor_id,
                    "anchor_training_sample_record_sha256": examples[
                        anchor_id
                    ].sample_record_sha256,
                    "chapter_id": chapter_id,
                    "human_confirmed": True,
                    "pair_id": pair_id,
                    "pair_kind": kind,
                    "role": "dialogue",
                    "schema_version": TRAINER.CHAPTER_PAIR_SCHEMA_VERSION,
                    "split": split,
                    "target_label_record_sha256": SHA_B,
                    "target_sample_id": target_id,
                    "target_training_sample_record_sha256": examples[
                        target_id
                    ].sample_record_sha256,
                }
            )

        rows = (
            pair_row(
                "positive",
                "ordinary_consistency_positive",
                "train",
                "chapter-a",
                "anchor",
                "member",
            ),
            pair_row(
                "override",
                "local_override_margin",
                "train",
                "chapter-a",
                "anchor",
                "local",
            ),
            pair_row(
                "test-positive",
                "ordinary_consistency_positive",
                "test",
                "chapter-test",
                "test-anchor",
                "test-member",
            ),
        )
        export = SimpleNamespace(
            manifest={"artifacts": {TRAINER.CHAPTER_PAIR_FILE: {}}}
        )
        with mock.patch.object(
            TRAINER,
            "_validate_jsonl_artifact",
            return_value=(rows, SHA_C),
        ):
            pairs, contract = TRAINER._load_chapter_pairs(
                export=export,
                samples_by_id=samples,
                examples_by_id=examples,
            )
        self.assertEqual({pair.pair_id for pair in pairs}, {"positive", "override"})
        self.assertEqual(contract["split_counts"], {"test": 1, "train": 2})
        self.assertEqual(contract["development_pair_count"], 2)
        self.assertEqual(contract["test_pair_rows_used"], 0)
        self.assertEqual(
            contract["losses"],
            {
                "chapter_anchor_consistency": "enabled",
                "local_override_margin": "enabled",
            },
        )

    def test_font_signal_gate_filters_labels_before_parsing_and_pixels_before_scan(
        self,
    ) -> None:
        candidate_ids = ("font-a", "font-b")

        def sample_row(sample_id: str, split: str, *, invalid_label: bool) -> dict:
            judgment: Any = "excluded-label-must-not-be-parsed"
            if not invalid_label:
                judgment = {
                    "preferred": ["font-a"],
                    "acceptable": [],
                    "marginal": [],
                    "unacceptable": ["font-b"],
                    "unrenderable": [],
                    "not_reviewed": [],
                    "none_acceptable": False,
                }
            core = {
                "sample_id": sample_id,
                "work_id": f"work-{sample_id}",
                "chapter_id": f"chapter-{sample_id}",
                "page_id": f"page-{sample_id}",
                "split": split,
                "groups": {"split_component": f"component-{sample_id}"},
                "provenance": {"synthetic": False, "qa_overlay": False},
                "input_bindings": {
                    "catalog_registry_sha256": SHA_A,
                    "render_bank_manifest_sha256": SHA_B,
                    "render_specification_sha256": SHA_C,
                },
                "source": {
                    "source_page_sha256": TRAINER.sha256_bytes(
                        f"page:{sample_id}".encode()
                    ),
                    "views": {name: {} for name in TRAINER.VIEW_NAMES},
                },
                "font_judgment": judgment,
                "role": {"primary": "dialogue", "confidence": 1.0},
                "source_style": {
                    **{field: 0.5 for field in TRAINER.STYLE_FIELDS},
                    "unknown_fields": [],
                },
                "treatment": {
                    field: values[0]
                    for field, values in TRAINER.TREATMENT_VALUES.items()
                },
                "work_balance_weight": 1.0,
            }
            return TRAINER.seal_record(core)

        train = sample_row("eligible-train", "train", invalid_label=False)
        val = sample_row("eligible-val", "val", invalid_label=False)
        excluded = sample_row("audited-absent", "train", invalid_label=True)
        samples = (train, val, excluded)

        def listwise(sample: Mapping[str, Any]) -> dict:
            return TRAINER.seal_record(
                {
                    "schema_version": TRAINER.LISTWISE_SCHEMA_VERSION,
                    "sample_id": sample["sample_id"],
                    "work_id": sample["work_id"],
                    "split": sample["split"],
                    "training_sample_record_sha256": sample["record_sha256"],
                    "candidate_targets": [
                        {
                            "candidate_id": "font-a",
                            "tier": "preferred",
                            "loss_eligible": True,
                            "relevance_gain": 3.0,
                        },
                        {
                            "candidate_id": "font-b",
                            "tier": "unacceptable",
                            "loss_eligible": True,
                            "relevance_gain": 0.0,
                        },
                    ],
                }
            )

        def retrieval(sample: Mapping[str, Any]) -> dict:
            return TRAINER.seal_record(
                {
                    "schema_version": TRAINER.RETRIEVAL_SCHEMA_VERSION,
                    "sample_id": sample["sample_id"],
                    "work_id": sample["work_id"],
                    "split": sample["split"],
                    "training_sample_record_sha256": sample["record_sha256"],
                    "positive_candidate_ids": ["font-a"],
                    "negative_candidate_ids": ["font-b"],
                    "excluded_unrenderable_candidate_ids": [],
                    "abstain_target": False,
                    "eligible_for_contrastive_loss": True,
                }
            )

        def pairwise(sample: Mapping[str, Any]) -> dict:
            return TRAINER.seal_record(
                {
                    "schema_version": TRAINER.PAIRWISE_SCHEMA_VERSION,
                    "sample_id": sample["sample_id"],
                    "work_id": sample["work_id"],
                    "split": sample["split"],
                    "training_sample_record_sha256": sample["record_sha256"],
                    "better_candidate_id": "font-a",
                    "worse_candidate_id": "font-b",
                    "tier_distance": 3,
                }
            )

        prototype_rows = []
        prototype_evidence = []
        for index, font_id in enumerate(candidate_ids):
            render_id = f"render-{font_id}"
            artifact_sha = TRAINER.sha256_bytes(f"render:{font_id}".encode())
            prototype_rows.append(
                TRAINER.seal_record(
                    {
                        "schema_version": TRAINER.PROTOTYPE_SCHEMA_VERSION,
                        "font_id": font_id,
                        "production_400_normal_canonical": True,
                        "render_weight": 400,
                        "render_style": "normal",
                        "source_font_sha256": SHA_C,
                        "render_prototypes": [
                            {
                                "artifact_path": f"images/{render_id}.png",
                                "artifact_sha256": artifact_sha,
                                "render_id": render_id,
                                "writing_mode": (
                                    "horizontal" if index == 0 else "vertical"
                                ),
                            }
                        ],
                    }
                )
            )
            prototype_evidence.append(
                {
                    "font_id": font_id,
                    "render_id": render_id,
                    "artifact_sha256": artifact_sha,
                    "writing_mode": "horizontal" if index == 0 else "vertical",
                }
            )

        audit_record = TRAINER.FontSignalAuditRecord(
            sample_id=str(excluded["sample_id"]),
            work_id=str(excluded["work_id"]),
            chapter_id=str(excluded["chapter_id"]),
            page_id=str(excluded["page_id"]),
            source_page_sha256=str(excluded["source"]["source_page_sha256"]),
            training_sample_record_sha256=str(excluded["record_sha256"]),
            outcome="font_signal_absent",
        )
        audit = fake_font_signal_audit(
            records={audit_record.sample_id: audit_record},
            review_ready_sample_ids=frozenset(
                {str(train["sample_id"]), str(val["sample_id"])}
            ),
        )
        export = SimpleNamespace(
            samples=samples,
            root=Path("fake-export"),
            samples_sha256=SHA_A,
            manifest_sha256=SHA_B,
            manifest={
                "contracts": {
                    "split": {
                        "development_component_key": "groups.split_component",
                        "group_key": "work_id",
                        "work_disjoint": True,
                    }
                },
                "work_split": {
                    str(sample["work_id"]): str(sample["split"]) for sample in samples
                },
                "renderer_bindings": {"font_catalog_sha256": SHA_C},
                "candidate_count": len(candidate_ids),
            },
        )
        render_bank = SimpleNamespace(
            candidate_ids=candidate_ids,
            manifest_sha256=SHA_B,
            specification_sha256=SHA_C,
            prototype_evidence=tuple(prototype_evidence),
        )
        rows_by_file = {
            "listwise.jsonl": (
                listwise(train),
                listwise(val),
                {"sample_id": excluded["sample_id"], "schema_version": "invalid"},
            ),
            "retrieval.jsonl": (
                retrieval(train),
                retrieval(val),
                {"sample_id": excluded["sample_id"], "schema_version": "invalid"},
            ),
            "pairwise.jsonl": (
                pairwise(train),
                pairwise(val),
                {"sample_id": excluded["sample_id"], "schema_version": "invalid"},
            ),
            "font-prototypes.jsonl": tuple(prototype_rows),
            "augmentations.jsonl": (),
        }

        def fake_artifact(_export: Any, file_name: str) -> Any:
            return rows_by_file[file_name], TRAINER.sha256_bytes(file_name.encode())

        with mock.patch.object(
            TRAINER, "_validate_jsonl_artifact", side_effect=fake_artifact
        ):
            corpus = TRAINER.load_training_corpus(
                export=export,
                render_bank=render_bank,
                catalog_registry_sha256=SHA_A,
                font_signal_audit=audit,
            )
        self.assertEqual(set(corpus.samples_by_id), {"eligible-train", "eligible-val"})
        self.assertEqual(set(corpus.examples_by_id), {"eligible-train", "eligible-val"})

        resolver = FakeResolver()
        scan = TRAINER.scan_model_assets(
            resolver=resolver,
            render_bank=FakeRenderBank(),
            corpus=corpus,
        )
        self.assertEqual(set(scan.sample_ids), {"eligible-train", "eligible-val"})
        self.assertNotIn(
            "audited-absent", {sample_id for sample_id, _, _ in resolver.calls}
        )

    def test_scan_and_extraction_never_open_test_and_letterbox_prototypes(self) -> None:
        resolver = FakeResolver()
        render_bank = FakeRenderBank()
        corpus = fake_corpus()
        scan = TRAINER.scan_model_assets(
            resolver=resolver,
            render_bank=render_bank,
            corpus=corpus,
        )
        self.assertEqual([row["split"] for row in scan.sample_rows], ["train", "val"])
        self.assertNotIn("test", {split for _, split, _ in resolver.calls})
        self.assertEqual(
            {tuple(row["source_size_px"]) for row in scan.prototype_rows},
            {(448, 224), (224, 480)},
        )

        extractor = FakeExtractor()
        sample_features, prototype_features = TRAINER.extract_feature_arrays(
            resolver=resolver,
            render_bank=render_bank,
            corpus=corpus,
            scan=scan,
            extractor=extractor,
            image_batch_size=3,
        )
        self.assertEqual(sample_features.shape, (2, 3, 4))
        self.assertEqual(prototype_features.shape, (2, 4))
        self.assertEqual(set(extractor.sizes), {(224, 224)})
        self.assertNotIn("test", {split for _, split, _ in resolver.calls})

    def test_feature_cache_is_deterministic_and_stale_rebuild_is_explicit(self) -> None:
        resolver = FakeResolver()
        render_bank = FakeRenderBank()
        corpus = fake_corpus()
        scan = TRAINER.scan_model_assets(
            resolver=resolver,
            render_bank=render_bank,
            corpus=corpus,
        )
        old_contract = {
            "inventory": {
                "sample_count": len(scan.sample_rows),
                "prototype_count": len(scan.prototype_rows),
                "sample_index_sha256": TRAINER._records_digest(
                    TRAINER._cache_sample_index(scan)
                ),
                "prototype_index_sha256": TRAINER._records_digest(
                    TRAINER._cache_prototype_index(scan)
                ),
            },
            "revision": "old",
        }
        new_contract = copy.deepcopy(old_contract)
        new_contract["revision"] = "new"
        sample_features = np.arange(24, dtype=np.float32).reshape(2, 3, 4)
        prototype_features = np.arange(8, dtype=np.float32).reshape(2, 4)
        processor_sha = TRAINER.sha256_bytes(b"fake-processor")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "cache-first"
            second = root / "cache-second"
            TRAINER.write_feature_cache(
                cache_dir=first,
                contract=old_contract,
                scan=scan,
                sample_features=sample_features,
                prototype_features=prototype_features,
                processor_config_sha256=processor_sha,
            )
            TRAINER.write_feature_cache(
                cache_dir=second,
                contract=old_contract,
                scan=scan,
                sample_features=sample_features,
                prototype_features=prototype_features,
                processor_config_sha256=processor_sha,
            )
            self.assertEqual(
                (first / "manifest.json").read_bytes(),
                (second / "manifest.json").read_bytes(),
            )
            self.assertEqual(
                (first / "sample-features.npy").read_bytes(),
                (second / "sample-features.npy").read_bytes(),
            )
            tampered_manifest = TRAINER._read_json(
                second / "manifest.json", location="tampered cache"
            )
            tampered_manifest["sample_index"][0]["view_order"] = list(
                reversed(TRAINER.VIEW_NAMES)
            )
            tampered_manifest = TRAINER.seal_record(tampered_manifest)
            tampered_payload = TRAINER.json_bytes(tampered_manifest, pretty=True)
            (second / "manifest.json").write_bytes(tampered_payload)
            tampered_marker = TRAINER._read_json(
                TRAINER._cache_owner_marker_path(second),
                location="tampered cache marker",
            )
            tampered_marker["manifest_sha256"] = TRAINER.sha256_bytes(tampered_payload)
            TRAINER._cache_owner_marker_path(second).write_bytes(
                TRAINER.json_bytes(tampered_marker, pretty=True)
            )
            with self.assertRaisesRegex(
                TRAINER.TrainerError, "inventory index drifted"
            ):
                TRAINER.load_feature_cache(
                    cache_dir=second, expected_contract=old_contract
                )
            with self.assertRaises(TRAINER.StaleFeatureCacheError):
                TRAINER.get_or_build_feature_cache(
                    cache_dir=first,
                    contract=new_contract,
                    scan=scan,
                    resolver=resolver,
                    render_bank=render_bank,
                    corpus=corpus,
                    stale_policy="fail",
                    image_batch_size=3,
                    extractor_factory=FakeExtractor,
                )
            rebuilt, status = TRAINER.get_or_build_feature_cache(
                cache_dir=first,
                contract=new_contract,
                scan=scan,
                resolver=resolver,
                render_bank=render_bank,
                corpus=corpus,
                stale_policy="rebuild",
                image_batch_size=3,
                extractor_factory=FakeExtractor,
            )
            self.assertEqual(status, "rebuilt")
            self.assertEqual(rebuilt.manifest["contract"], new_contract)

    def test_fake_embedding_training_is_byte_deterministic(self) -> None:
        validation_ids = tuple(f"val-{index:02d}" for index in range(20))
        sample_ids = ("train-a", "train-b", *validation_ids)
        splits = ("train", "train", *("val" for _ in validation_ids))
        examples = {
            sample_id: make_example(
                sample_id,
                split=split,
                work_id=f"work-{sample_id}",
                none_target=float(index % 2),
            )
            for index, (sample_id, split) in enumerate(zip(sample_ids, splits))
        }
        corpus = TRAINER.TrainingCorpus(
            export=SimpleNamespace(),
            samples_by_id={},
            examples_by_id=examples,
            candidate_ids=("font-a", "font-b", "font-c"),
            font_catalog_sha256=SHA_A,
            listwise_sha256=SHA_A,
            pairwise_sha256=SHA_A,
            retrieval_sha256=SHA_A,
            prototype_sha256=SHA_A,
            font_signal_audit=fake_font_signal_audit(),
            chapter_pairs=(
                TRAINER.ChapterPair(
                    pair_id="train-positive",
                    kind="ordinary_consistency_positive",
                    split="train",
                    chapter_id="chapter-a",
                    role="dialogue",
                    anchor_sample_id="train-a",
                    target_sample_id="train-b",
                    record_sha256=SHA_B,
                ),
                TRAINER.ChapterPair(
                    pair_id="val-positive",
                    kind="ordinary_consistency_positive",
                    split="val",
                    chapter_id="chapter-a",
                    role="dialogue",
                    anchor_sample_id=validation_ids[0],
                    target_sample_id=validation_ids[1],
                    record_sha256=SHA_C,
                ),
            ),
            chapter_pair_contract={
                "artifact_sha256": SHA_A,
                "losses": {
                    "chapter_anchor_consistency": "enabled",
                    "local_override_margin": "disabled_no_development_pairs",
                },
                "status": "enabled",
                "test_pair_rows_used": 0,
            },
        )
        generator = np.random.default_rng(777)
        cache = TRAINER.FeatureCache(
            root=Path("unused-cache"),
            manifest={
                "sample_index": [
                    {"row_index": index, "sample_id": sample_id, "split": split}
                    for index, (sample_id, split) in enumerate(zip(sample_ids, splits))
                ],
                "prototype_index": [
                    {
                        "row_index": index,
                        "font_id": font_id,
                        "render_id": f"render-{index}",
                        "probe_id": "body",
                        "writing_mode": "horizontal",
                    }
                    for index, font_id in enumerate(corpus.candidate_ids)
                ],
            },
            manifest_sha256=SHA_A,
            sample_features=generator.normal(size=(len(sample_ids), 3, 8)).astype(
                np.float32
            ),
            prototype_features=generator.normal(size=(3, 8)).astype(np.float32),
        )
        hyperparameters = TRAINER.TrainingHyperparameters(
            seed=1234,
            hidden_dim=7,
            epochs=3,
            batch_size=2,
            patience=3,
            view_dropout=0.2,
            head_dropout=0.1,
        )
        first_model, first_summary = TRAINER.train_ranker(
            cache=cache,
            corpus=corpus,
            hyperparameters=hyperparameters,
            device="cpu",
        )
        second_model, second_summary = TRAINER.train_ranker(
            cache=cache,
            corpus=corpus,
            hyperparameters=hyperparameters,
            device="cpu",
        )
        ordinary_reference = TRAINER.OrdinaryReference(
            root=Path("validated-prior-output"),
            state={
                name: value.detach().cpu().clone()
                for name, value in first_model.state_dict().items()
            },
            binding={
                "checkpoint_sha256": SHA_A,
                "model_contract_sha256": SHA_B,
                "optimizer_seed_allowed": False,
                "output_marker_sha256": SHA_C,
                "report_sha256": SHA_C,
                "source_code_sha256": SHA_A,
                "source_inputs_sha256": SHA_B,
                "test_pixels_opened_from_reference": 0,
                "usage": "evaluation_only_ordinary_regression_baseline",
            },
        )
        referenced_model, referenced_summary = TRAINER.train_ranker(
            cache=cache,
            corpus=corpus,
            hyperparameters=hyperparameters,
            device="cpu",
            ordinary_reference=ordinary_reference,
        )
        self.assertEqual(first_summary, second_summary)
        self.assertEqual(
            first_summary["checkpoint_selection"]["baseline_status"],
            "non_production_safety_baseline",
        )
        self.assertEqual(
            first_summary["checkpoint_selection"]["ordinary_baseline_source"],
            "fresh_initial_ranker",
        )
        self.assertEqual(
            first_summary["history"][0]["train"]["chapter_consistency_pair_count"],
            1,
        )
        self.assertEqual(
            first_summary["best_validation_metrics"]["chapter"]["positive_pair_count"],
            1,
        )
        for name, value in first_model.state_dict().items():
            self.assertTrue(torch.equal(value, second_model.state_dict()[name]), name)
            self.assertTrue(
                torch.equal(value, referenced_model.state_dict()[name]), name
            )
        selection = referenced_summary["checkpoint_selection"]
        self.assertEqual(selection["baseline_status"], "production_reference")
        self.assertEqual(
            selection["ordinary_baseline_source"],
            "validated_owned_prior_checkpoint_evaluation_only",
        )
        self.assertFalse(selection["optimizer_seeded_from_ordinary_reference"])
        self.assertEqual(selection["reference"], ordinary_reference.binding)
        self.assertGreaterEqual(referenced_summary["best_epoch"], 0)
        TRAINER._validate_ordinary_regression_safety(selection)

    def test_predictions_are_evaluator_accepted_and_never_copy_ground_truth(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = EVALUATOR_FIXTURE.Fixture(Path(temporary))
            sample = next(row for row in fixture.sample_rows if row["split"] == "val")
            listwise = next(
                row
                for row in fixture.listwise_rows
                if row["sample_id"] == sample["sample_id"]
            )
            role_logits = np.full((1, len(TRAINER.ROLE_VALUES)), -5.0, dtype=np.float32)
            predicted_role = "sfx_comic"
            role_logits[0, TRAINER.ROLE_VALUES.index(predicted_role)] = 5.0
            treatment_logits = {}
            for field, values in TRAINER.TREATMENT_VALUES.items():
                logits = np.full((1, len(values)), -4.0, dtype=np.float32)
                logits[0, values.index("unknown")] = 4.0
                treatment_logits[field] = logits
            inference = TRAINER.InferenceOutput(
                candidate_scores=np.asarray([[0.1, 0.4, 0.2, -0.3]], dtype=np.float32),
                none_logits=np.asarray([2.0], dtype=np.float32),
                role_logits=role_logits,
                style_logits=np.full(
                    (1, len(TRAINER.STYLE_FIELDS)), 3.0, dtype=np.float32
                ),
                treatment_logits=treatment_logits,
            )
            rows = TRAINER.build_prediction_rows(
                bindings=(
                    TRAINER.PredictionBinding(
                        sample_id=sample["sample_id"],
                        work_id=sample["work_id"],
                        split="val",
                        sample_record_sha256=sample["record_sha256"],
                        listwise_record_sha256=listwise["record_sha256"],
                    ),
                ),
                inference=inference,
                candidate_ids=EVALUATOR_FIXTURE.CANDIDATES,
                font_catalog_sha256=EVALUATOR_FIXTURE.FONT_CATALOG_SHA,
                training_export_manifest_sha256=EVALUATOR_FIXTURE.EVAL.sha256_file(
                    fixture.manifest
                ),
                checkpoint_sha256=EVALUATOR_FIXTURE.MODEL_SHA,
                calibration=TRAINER.Calibration(temperature=1.0, none_threshold=0.5),
            )
            prediction_path = Path(temporary) / "predictions-val.jsonl"
            prediction_path.write_bytes(TRAINER.prediction_jsonl_bytes(rows))
            TRAINER.validate_predictions_with_evaluator(
                prediction_path=prediction_path,
                export_root=fixture.export_root,
            )
            row = rows[0]
            self.assertEqual(row["role"]["primary"], predicted_role)
            self.assertNotEqual(row["role"]["primary"], sample["role"]["primary"])
            self.assertEqual(set(row["treatment"].values()), {"unknown"})
            decision = {
                "confidence": row["confidence"],
                "none_probability": row["none_probability"],
                "ranked_candidate_ids": row["ranked_candidate_ids"],
            }
            self.assertEqual(row["variants"]["no_genre"], decision)
            self.assertEqual(row["variants"]["swapped_genre"], decision)

            test_rows = TRAINER.build_prediction_rows(
                bindings=(
                    TRAINER.PredictionBinding(
                        sample_id=sample["sample_id"],
                        work_id=sample["work_id"],
                        split="test",
                        sample_record_sha256=sample["record_sha256"],
                        listwise_record_sha256=listwise["record_sha256"],
                    ),
                ),
                inference=inference,
                candidate_ids=EVALUATOR_FIXTURE.CANDIDATES,
                font_catalog_sha256=EVALUATOR_FIXTURE.FONT_CATALOG_SHA,
                training_export_manifest_sha256=EVALUATOR_FIXTURE.EVAL.sha256_file(
                    fixture.manifest
                ),
                checkpoint_sha256=EVALUATOR_FIXTURE.MODEL_SHA,
                calibration=TRAINER.Calibration(temperature=1.0, none_threshold=0.5),
            )
            self.assertEqual(test_rows[0]["split"], "test")

    def test_output_bundle_is_sealed_and_rejects_cache_binding_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = EVALUATOR_FIXTURE.Fixture(root)
            sample = next(row for row in fixture.sample_rows if row["split"] == "val")
            test_sample = next(
                row for row in fixture.sample_rows if row["split"] == "test"
            )
            listwise = next(
                row
                for row in fixture.listwise_rows
                if row["sample_id"] == sample["sample_id"]
            )
            manifest_sha = EVALUATOR_FIXTURE.EVAL.sha256_file(fixture.manifest)
            corpus = TRAINER.TrainingCorpus(
                export=SimpleNamespace(
                    root=fixture.export_root,
                    manifest_sha256=manifest_sha,
                    samples_sha256=EVALUATOR_FIXTURE.EVAL.sha256_file(fixture.samples),
                ),
                samples_by_id={
                    sample["sample_id"]: sample,
                    test_sample["sample_id"]: test_sample,
                },
                examples_by_id={
                    sample["sample_id"]: make_example(
                        sample["sample_id"],
                        split="val",
                        work_id=sample["work_id"],
                        candidate_count=len(EVALUATOR_FIXTURE.CANDIDATES),
                    ),
                    test_sample["sample_id"]: make_example(
                        test_sample["sample_id"],
                        split="test",
                        work_id=test_sample["work_id"],
                        candidate_count=len(EVALUATOR_FIXTURE.CANDIDATES),
                    ),
                },
                candidate_ids=EVALUATOR_FIXTURE.CANDIDATES,
                font_catalog_sha256=EVALUATOR_FIXTURE.FONT_CATALOG_SHA,
                listwise_sha256=EVALUATOR_FIXTURE.EVAL.sha256_file(fixture.listwise),
                pairwise_sha256=SHA_A,
                retrieval_sha256=SHA_B,
                prototype_sha256=SHA_C,
                font_signal_audit=fake_font_signal_audit(),
            )
            resolver = SimpleNamespace(registry_sha256=SHA_A)
            render_bank = SimpleNamespace(
                manifest_sha256=SHA_B,
                specification_sha256=SHA_C,
            )
            cache = TRAINER.FeatureCache(
                root=root / "cache",
                manifest={"processor_config_sha256": SHA_A},
                manifest_sha256=SHA_B,
                sample_features=np.zeros((1, 3, 8), dtype=np.float32),
                prototype_features=np.zeros((4, 8), dtype=np.float32),
            )
            role_logits = np.zeros((1, len(TRAINER.ROLE_VALUES)), dtype=np.float32)
            inference = TRAINER.InferenceOutput(
                candidate_scores=np.asarray([[4.0, 3.0, 2.0, 1.0]], dtype=np.float32),
                none_logits=np.asarray([-2.0], dtype=np.float32),
                role_logits=role_logits,
                style_logits=np.zeros((1, len(TRAINER.STYLE_FIELDS)), dtype=np.float32),
                treatment_logits={
                    field: np.zeros((1, len(values)), dtype=np.float32)
                    for field, values in TRAINER.TREATMENT_VALUES.items()
                },
            )
            binding = TRAINER.PredictionBinding(
                sample_id=sample["sample_id"],
                work_id=sample["work_id"],
                split="val",
                sample_record_sha256=sample["record_sha256"],
                listwise_record_sha256=listwise["record_sha256"],
            )
            TRAINER.seed_everything(77)
            model = TRAINER.build_ranker(
                feature_dim=8,
                hidden_dim=6,
                view_dropout=0.0,
                head_dropout=0.0,
            )
            reference_hyperparameters = TRAINER.TrainingHyperparameters(
                hidden_dim=6,
                view_dropout=0.0,
                head_dropout=0.0,
            )
            output = root / "baseline-output"
            non_production_gate = TRAINER.ordinary_regression_gate(
                metrics={
                    "priority": {"2": {"acceptable_at_1": None, "sample_count": 1}}
                },
                baseline_metrics={
                    "priority": {"2": {"acceptable_at_1": None, "sample_count": 1}}
                },
            )
            checkpoint_selection = {
                "baseline_status": "non_production_safety_baseline",
                "best_ordinary_regression_gate": non_production_gate,
                "optimizer_seeded_from_ordinary_reference": False,
                "ordinary_acceptable_at_1_regression_limit": (
                    TRAINER.ORDINARY_TOP1_REGRESSION_LIMIT
                ),
                "ordinary_reference_argument_seeded_optimizer": False,
                "reference": None,
                "resume_requires_separate_resume_from_argument": True,
            }
            result = TRAINER.write_training_output(
                output_dir=output,
                replace_owned_output=False,
                model=model,
                bindings=(binding,),
                inference=inference,
                calibration=TRAINER.Calibration(temperature=1.0, none_threshold=0.5),
                cache=cache,
                cache_status="built",
                corpus=corpus,
                resolver=resolver,
                render_bank=render_bank,
                hyperparameters=reference_hyperparameters,
                training_summary={
                    "best_epoch": 0,
                    "best_val_loss": 1.0,
                    "checkpoint_selection": checkpoint_selection,
                },
                asset_validation_report_sha256=None,
            )
            self.assertEqual(result["status"], "valid")
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {
                    ".font-matching-siglip-baseline-owned.json",
                    "checkpoint.safetensors",
                    "model-contract.json",
                    "predictions-val.jsonl",
                    "report.json",
                },
            )
            changed_test = TRAINER.replace(
                corpus,
                examples_by_id={
                    **corpus.examples_by_id,
                    test_sample["sample_id"]: TRAINER.replace(
                        corpus.examples_by_id[test_sample["sample_id"]],
                        listwise_record_sha256="d" * 64,
                    ),
                },
            )
            with self.assertRaisesRegex(
                TRAINER.TrainerError, "stale or different inputs"
            ):
                TRAINER.validate_training_output(
                    output_dir=output,
                    corpus=changed_test,
                    resolver=resolver,
                    render_bank=render_bank,
                    cache=cache,
                    asset_validation_report_sha256=None,
                )
            stale_cache = TRAINER.FeatureCache(
                root=cache.root,
                manifest=cache.manifest,
                manifest_sha256=SHA_C,
                sample_features=cache.sample_features,
                prototype_features=cache.prototype_features,
            )
            with self.assertRaisesRegex(TRAINER.TrainerError, "another feature cache"):
                TRAINER.validate_training_output(
                    output_dir=output,
                    corpus=corpus,
                    resolver=resolver,
                    render_bank=render_bank,
                    cache=stale_cache,
                    asset_validation_report_sha256=None,
                )

            successor_cache = TRAINER.FeatureCache(
                root=stale_cache.root,
                manifest=stale_cache.manifest,
                manifest_sha256=SHA_C,
                sample_features=stale_cache.sample_features,
                prototype_features=np.zeros((7, 8), dtype=np.float32),
            )
            reference = TRAINER.load_ordinary_reference(
                output_dir=output,
                cache=successor_cache,
                hyperparameters=reference_hyperparameters,
            )
            self.assertEqual(
                reference.binding["usage"],
                "evaluation_only_ordinary_regression_baseline",
            )
            self.assertEqual(reference.binding["optimizer_seed_allowed"], False)
            self.assertEqual(
                reference.binding["source_candidate_count"],
                len(EVALUATOR_FIXTURE.CANDIDATES),
            )
            self.assertEqual(
                reference.binding["checkpoint_sha256"],
                TRAINER.sha256_file(output / "checkpoint.safetensors"),
            )
            with self.assertRaisesRegex(TRAINER.TrainerError, "architecture"):
                TRAINER.load_ordinary_reference(
                    output_dir=output,
                    cache=successor_cache,
                    hyperparameters=TRAINER.replace(
                        reference_hyperparameters, hidden_dim=7
                    ),
                )

            report_path = output / "report.json"
            report = TRAINER._read_json(report_path, location="test report")
            report["checks"]["test_pixels_opened_or_cached"] = 1
            report_path.write_bytes(
                TRAINER.json_bytes(TRAINER.seal_record(report), pretty=True)
            )
            marker_path = TRAINER._output_marker_path(output)
            marker = TRAINER._read_json(marker_path, location="test marker")
            marker["artifacts"]["report.json"] = TRAINER.sha256_file(report_path)
            marker_path.write_bytes(TRAINER.json_bytes(marker, pretty=True))
            with self.assertRaisesRegex(TRAINER.TrainerError, "unsafe"):
                TRAINER.load_ordinary_reference(
                    output_dir=output,
                    cache=successor_cache,
                    hyperparameters=reference_hyperparameters,
                )

    def test_resume_rejects_hyperparameter_drift_before_loading_weights(self) -> None:
        current = TRAINER.TrainingHyperparameters()
        drifted = copy.deepcopy(current.as_dict())
        drifted["hidden_dim"] += 1
        runtime = SimpleNamespace(
            corpus=object(),
            resolver=object(),
            render_bank=object(),
            asset_validation_report_sha256=None,
        )
        with (
            mock.patch.object(TRAINER, "validate_training_output"),
            mock.patch.object(
                TRAINER, "_read_json", return_value={"hyperparameters": drifted}
            ),
            mock.patch.object(TRAINER, "load_checkpoint") as load_checkpoint,
            self.assertRaisesRegex(TRAINER.TrainerError, "hyperparameters differ"),
        ):
            TRAINER.load_resume_state(
                resume_dir=Path("resume-output"),
                runtime=runtime,
                cache=object(),
                hyperparameters=current,
            )
        load_checkpoint.assert_not_called()


if __name__ == "__main__":
    unittest.main()
