from __future__ import annotations

import copy
import dataclasses
import hashlib
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]


def load_script(name: str, relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BUILDER = load_script(
    "build_bubble_fit_gate_dataset_train_test_dependency",
    "scripts/build_bubble_fit_gate_dataset.py",
)
TRAIN = load_script(
    "train_bubble_fit_gate_test_target",
    "scripts/train_bubble_fit_gate.py",
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def rewrite_manifest_and_seal(
    output: Path,
    *,
    manifest: dict[str, Any] | None = None,
    seal: dict[str, Any] | None = None,
) -> None:
    manifest_path = output / "artifact-manifest.json"
    seal_path = output / "artifact-seal.json"
    if manifest is None:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if seal is None:
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        artifact = output / entry["path"]
        entry["sha256"] = sha256_file(artifact)
        entry["sizeBytes"] = artifact.stat().st_size
    manifest["filesBindingSha256"] = TRAIN._sha256_json(manifest["files"])
    write_json(manifest_path, manifest)
    seal["manifestSha256"] = sha256_file(manifest_path)
    write_json(seal_path, seal)


def coherently_rebind_oof(output: Path) -> None:
    report_path = output / "evaluation-report.json"
    manifest_path = output / "artifact-manifest.json"
    seal_path = output / "artifact-seal.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    seal = json.loads(seal_path.read_text(encoding="utf-8"))
    oof_sha = sha256_file(output / "oof-predictions.jsonl")
    bindings = copy.deepcopy(report["authorityBindings"])
    bindings["oofPredictionsSha256"] = oof_sha
    unbound = dict(bindings)
    unbound.pop("bindingSha256", None)
    bindings["bindingSha256"] = TRAIN._sha256_json(unbound)
    report["oofPredictionsSha256"] = oof_sha
    direct_keys = (
        TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS
        if TRAIN._is_pack_set_source_kind(report["source"].get("sourceKind"))
        else TRAIN.AUTHORITY_DIRECT_KEYS
    )
    for payload in (report, manifest, seal):
        payload["authorityBindings"] = bindings
        for key in direct_keys:
            payload[key] = bindings[key]
    write_json(report_path, report)
    rewrite_manifest_and_seal(output, manifest=manifest, seal=seal)


def coherently_rebind_split_plan(output: Path) -> None:
    report_path = output / "evaluation-report.json"
    manifest_path = output / "artifact-manifest.json"
    seal_path = output / "artifact-seal.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    seal = json.loads(seal_path.read_text(encoding="utf-8"))
    split_sha = sha256_file(output / "split-plan.json")
    bindings = copy.deepcopy(report["authorityBindings"])
    bindings["splitPlanSha256"] = split_sha
    unbound = dict(bindings)
    unbound.pop("bindingSha256", None)
    bindings["bindingSha256"] = TRAIN._sha256_json(unbound)
    report["splitPlanSha256"] = split_sha
    direct_keys = (
        TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS
        if TRAIN._is_pack_set_source_kind(report["source"].get("sourceKind"))
        else TRAIN.AUTHORITY_DIRECT_KEYS
    )
    for payload in (report, manifest, seal):
        payload["authorityBindings"] = bindings
        for key in direct_keys:
            payload[key] = bindings[key]
    write_json(report_path, report)
    rewrite_manifest_and_seal(output, manifest=manifest, seal=seal)


def coherently_rebind_cross_plan(output: Path) -> None:
    report_path = output / "evaluation-report.json"
    manifest_path = output / "artifact-manifest.json"
    seal_path = output / "artifact-seal.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    seal = json.loads(seal_path.read_text(encoding="utf-8"))
    cross_plan_sha = sha256_file(output / "cross-pack-plan.json")
    bindings = copy.deepcopy(report["authorityBindings"])
    bindings["crossPackPlanSha256"] = cross_plan_sha
    unbound = dict(bindings)
    unbound.pop("bindingSha256", None)
    bindings["bindingSha256"] = TRAIN._sha256_json(unbound)
    report["crossPackPlanSha256"] = cross_plan_sha
    for payload in (report, manifest, seal):
        payload["authorityBindings"] = bindings
        for key in TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS:
            payload[key] = bindings[key]
    write_json(report_path, report)
    rewrite_manifest_and_seal(output, manifest=manifest, seal=seal)


def downgrade_pack_output_to_legacy_v5(output: Path, snapshot: Any) -> None:
    report_path = output / "evaluation-report.json"
    split_path = output / "split-plan.json"
    oof_path = output / "oof-predictions.jsonl"
    cross_plan_path = output / "cross-pack-plan.json"
    cross_rows_path = output / "cross-pack-predictions.jsonl"
    manifest_path = output / "artifact-manifest.json"
    seal_path = output / "artifact-seal.json"
    schema_version = TRAIN.LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION

    split = json.loads(split_path.read_text(encoding="utf-8"))
    split["schemaVersion"] = schema_version
    write_json(split_path, split)
    oof_rows = [
        json.loads(line) for line in oof_path.read_text(encoding="utf-8").splitlines()
    ]
    for row in oof_rows:
        row["schemaVersion"] = schema_version
    oof_path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
            for row in oof_rows
        ),
        encoding="utf-8",
    )
    write_json(
        cross_plan_path,
        TRAIN.build_cross_pack_plan(snapshot, schema_version=schema_version),
    )
    cross_rows = [
        json.loads(line)
        for line in cross_rows_path.read_text(encoding="utf-8").splitlines()
    ]
    for row in cross_rows:
        row["schemaVersion"] = schema_version
    cross_rows_path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
            for row in cross_rows
        ),
        encoding="utf-8",
    )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["schemaVersion"] = schema_version
    for key in TRAIN.PREDICTION_EVIDENCE_LIMITATIONS:
        report.pop(key, None)
    report.pop("predictionEvidenceInterpretation", None)
    report.pop("schemaCompatibility", None)
    report["rankingStatus"] = TRAIN._ranking_status(schema_version)
    for model in report["models"]:
        model.pop("thresholdFreeCombinedOofMetrics", None)
        for fold in model["folds"]:
            fold.pop("thresholdSelectionSafeProbabilities", None)
            fold.pop("thresholdSelectionEvidenceRole", None)
    for model in report["crossPackEvaluation"]["models"]:
        for direction in model["directions"]:
            direction.pop("sourceThresholdSelectionSafeProbabilities", None)
            direction.pop("sourceThresholdSelectionEvidenceRole", None)
    config = TRAIN.evaluation_config_from_payload(report["config"])
    confirmatory = TRAIN.confirmatory_audit_contract(
        current_source_work_count=report["cohortCounts"]["sourceWorkCount"],
        target=config.unsafe_false_accept_target,
        schema_version=schema_version,
    )
    run_configuration = TRAIN.run_configuration_payload(
        config_payload=report["config"],
        model_kinds=report["modelKinds"],
        export_final_model=None,
        input_contract=report["inputContract"],
        schema_version=schema_version,
        input_pack_set_canonical_sha256=snapshot.pack_set_canonical_sha256,
        input_pack_set_schema_version=snapshot.input_schema_version,
        cross_pack_evaluation=True,
    )
    bindings = TRAIN._expected_authority_bindings(
        source=report["source"],
        config_payload=report["config"],
        input_contract=report["inputContract"],
        run_configuration=run_configuration,
        confirmatory_contract=confirmatory,
        split_plan_sha256=sha256_file(split_path),
        oof_predictions_sha256=sha256_file(oof_path),
        authority=report["executionAuthority"],
        cross_pack_plan_sha256=sha256_file(cross_plan_path),
        cross_pack_predictions_sha256=sha256_file(cross_rows_path),
    )
    report["runConfiguration"] = run_configuration
    report["confirmatoryAuditContract"] = confirmatory
    report["authorityBindings"] = bindings
    report["splitPlanSha256"] = sha256_file(split_path)
    report["oofPredictionsSha256"] = sha256_file(oof_path)
    report["crossPackPlanSha256"] = sha256_file(cross_plan_path)
    report["crossPackPredictionsSha256"] = sha256_file(cross_rows_path)
    for key in TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS:
        report[key] = bindings[key]
    write_json(report_path, report)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    seal = json.loads(seal_path.read_text(encoding="utf-8"))
    for payload in (manifest, seal):
        payload["schemaVersion"] = schema_version
        for key in TRAIN.PREDICTION_EVIDENCE_LIMITATIONS:
            payload.pop(key, None)
        payload.pop("predictionEvidenceInterpretation", None)
        payload.pop("schemaCompatibility", None)
        payload["confirmatoryAuditContract"] = confirmatory
        payload["authorityBindings"] = bindings
        for key in TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS:
            payload[key] = bindings[key]
    artifact_files = [
        {
            "path": path.relative_to(output).as_posix(),
            "sha256": sha256_file(path),
            "sizeBytes": path.stat().st_size,
        }
        for path in sorted(
            (
                path
                for path in output.rglob("*")
                if path.is_file()
                and path.name not in {manifest_path.name, seal_path.name}
            ),
            key=lambda path: path.relative_to(output).as_posix(),
        )
    ]
    manifest["files"] = artifact_files
    manifest["filesBindingSha256"] = TRAIN._sha256_json(artifact_files)
    write_json(manifest_path, manifest)
    seal["manifestSha256"] = sha256_file(manifest_path)
    write_json(seal_path, seal)


def rewrite_final_contract_and_seal(output: Path, contract: dict[str, Any]) -> None:
    contract_path = output / "final-candidate-contract.json"
    report_path = output / "evaluation-report.json"
    write_json(contract_path, contract)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["optionalFinalCandidate"]["contractSha256"] = sha256_file(contract_path)
    write_json(report_path, report)
    rewrite_manifest_and_seal(output)


class FakeDetector:
    def __init__(self) -> None:
        self.inference_count = 0

    def detect(self, _image: Image.Image) -> list[Any]:
        self.inference_count += 1
        return [
            BUILDER.Detection("bubble", 0.94, (12, 18, 82, 94)),
            BUILDER.Detection("text_bubble", 0.88, (28, 36, 65, 74)),
            BUILDER.Detection("text_free", 0.91, (4, 100, 40, 118)),
        ]


class CrudeProbeFixture:
    def __init__(
        self,
        root: Path,
        work_count: int = 4,
        *,
        work_ids: list[str] | None = None,
        page_prefix: str = "",
    ) -> None:
        self.root = root
        if work_ids is None:
            work_ids = [f"work-{index + 1}" for index in range(work_count)]
        if len(work_ids) != work_count or len(set(work_ids)) != len(work_ids):
            raise ValueError("fixture work ids must be unique and match work_count")
        self.work_ids = work_ids
        self.page_prefix = page_prefix
        self.run_dir = root / "run"
        self.report_path = self.run_dir / "run-report.json"
        self.dataset_dir = root / "dataset"
        self.labels_path = root / "labels" / "manual-labels.json"
        self.model_path = root / "model" / "detector-v4-s_int8.onnx"
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        self.model_path.write_bytes(b"synthetic-rtdetr")
        pages = [self._page(index) for index in range(work_count)]
        report = {
            "schemaVersion": 1,
            "status": "completed",
            "startedAt": "2026-08-18T00:00:00.000Z",
            "finishedAt": "2026-08-18T00:01:00.000Z",
            "runId": f"synthetic-crude-probe-{page_prefix or 'default'}",
            "cohort": "synthetic",
            "cohortDigest": "d" * 64,
            "candidateId": "synthetic",
            "pageCount": work_count,
            "pages": pages,
        }
        write_json(self.report_path, report)
        BUILDER.build_dataset(
            BUILDER.BuildOptions(
                report_path=self.report_path,
                output_dir=self.dataset_dir,
                model_path=self.model_path,
                expected_model_sha256=sha256_file(self.model_path),
                quiet=True,
            ),
            detector_factory=lambda _path, _threshold: FakeDetector(),
        )
        self.manifest_path = self.dataset_dir / "manifest.json"
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        annotations = []
        unsafe_labels = [
            "unsafe_translucent",
            "unsafe_open_or_illusory",
            "unsafe_mask_leak_or_clip",
            "unsafe_merged_or_wrong_region",
        ]
        for index, candidate in enumerate(self.manifest["candidates"]):
            safe = index % 2 == 1
            annotations.append(
                {
                    "ordinal": index + 1,
                    "page": int(candidate["selectionIndex"]) + 1,
                    "candidateId": candidate["id"],
                    "label": "safe_opaque" if safe else unsafe_labels[index % 4],
                    "safeForBubbleFit": safe,
                    "confidence": "high",
                    "notes": "Synthetic contract fixture only.",
                }
            )
        self.labels = {
            "schemaVersion": 1,
            "purpose": "Synthetic manual labels",
            "sourceDataset": {
                "path": str(self.dataset_dir),
                "manifestSha256": sha256_file(self.manifest_path),
                "manifestBindingSha256": self.manifest["manifestBindingSha256"],
            },
            "review": {
                "reviewer": "unit-test",
                "reviewedAt": "2026-08-18",
                "protocol": ["synthetic"],
                "safePolicy": "Only synthetic safe_opaque is true.",
            },
            "classes": list(TRAIN.ALLOWED_LABELS),
            "annotations": annotations,
        }
        write_json(self.labels_path, self.labels)

    def _page(self, index: int) -> dict[str, Any]:
        page_dir = self.run_dir / "pages" / f"{index + 1:02d}"
        original = page_dir / "original.png"
        cleaned = page_dir / "cleaned.png"
        page_dir.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (96, 128), (210, 208, 200))
        draw = ImageDraw.Draw(image)
        fill = (250, 250, 248) if index % 2 else (180, 180, 180)
        draw.ellipse((12, 18, 81, 93), fill=fill, outline=(25, 25, 25), width=2)
        draw.line((28, 48, 66, 48), fill=(15, 15, 15), width=4)
        image.save(original, format="PNG")
        draw.rectangle((28, 40, 66, 60), fill=fill)
        image.save(cleaned, format="PNG")
        image.close()
        source_page_id = f"{self.page_prefix}page-{index + 1}"
        work_id = self.work_ids[index]
        return {
            "selectionIndex": index,
            "sourcePageId": source_page_id,
            "sourcePageName": f"{source_page_id}.png",
            "sourcePageSha256": sha256_file(original),
            "workId": work_id,
            "workTitle": f"Work {work_id}",
            "chapterId": f"chapter-{index + 1}",
            "chapterTitle": f"Chapter {index + 1}",
            "status": "completed",
            "stage": "done",
            "mode": "full",
            "blockCount": 1,
            "stagedOriginalImagePath": str(original.resolve()),
            "cleanedImagePath": cleaned.relative_to(self.run_dir).as_posix(),
        }

    def load(self) -> Any:
        return TRAIN.load_training_snapshot(
            self.dataset_dir,
            self.labels_path,
            expected_candidate_count=len(self.manifest["candidates"]),
        )


def write_input_pack_set(
    repository_root: Path,
    packs: list[tuple[str, str, CrudeProbeFixture]],
    *,
    schema_version: int = TRAIN.LEGACY_INPUT_PACK_SET_SCHEMA_VERSION,
    identifier: str | None = None,
) -> Path:
    children = []
    ordered_packs = (
        sorted(packs, key=lambda item: item[0])
        if schema_version == TRAIN.LEGACY_INPUT_PACK_SET_SCHEMA_VERSION
        else packs
    )
    for pack_id, role, fixture in ordered_packs:
        snapshot = fixture.load()
        children.append(
            {
                "packId": pack_id,
                "role": role,
                "datasetDir": fixture.dataset_dir.relative_to(
                    repository_root
                ).as_posix(),
                "labelsFile": fixture.labels_path.relative_to(
                    repository_root
                ).as_posix(),
                "expectedCandidates": len(snapshot.samples),
                "datasetManifestSha256": snapshot.dataset_manifest_sha256,
                "datasetManifestBindingSha256": (
                    snapshot.dataset_manifest_binding_sha256
                ),
                "datasetSealSha256": snapshot.dataset_seal_sha256,
                "artifactInventorySha256": snapshot.artifact_inventory_sha256,
                "labelsSha256": snapshot.labels_sha256,
            }
        )
    payload = {
        "schemaVersion": schema_version,
        "toolId": TRAIN.INPUT_PACK_SET_TOOL_ID,
        "identifier": identifier
        or (
            "synthetic-old-new-v1"
            if schema_version == TRAIN.LEGACY_INPUT_PACK_SET_SCHEMA_VERSION
            else "synthetic-cumulative-v2"
        ),
        "packs": children,
    }
    payload["bindingSha256"] = TRAIN._sha256_json(payload)
    path = repository_root / "input-pack-set.json"
    write_json(path, payload)
    return path


class BubbleFitGateTrainingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "bubble gate training test"
        self.fixture = CrudeProbeFixture(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_pack_set(self) -> tuple[Any, Path, CrudeProbeFixture, CrudeProbeFixture]:
        old = CrudeProbeFixture(
            self.root / "old pack",
            work_ids=["shared-a", "shared-b", "old-a", "old-b"],
            page_prefix="old-",
        )
        new = CrudeProbeFixture(
            self.root / "new pack",
            work_ids=["shared-a", "shared-b", "new-a", "new-b"],
            page_prefix="new-",
        )
        pack_set_path = write_input_pack_set(
            self.root,
            [("old-pack", "old", old), ("new-pack", "new", new)],
        )
        snapshot = TRAIN.load_training_pack_set_snapshot(
            pack_set_path, repository_root=self.root
        )
        return snapshot, pack_set_path, old, new

    def make_pack_set_v2(
        self,
    ) -> tuple[
        Any,
        Path,
        CrudeProbeFixture,
        CrudeProbeFixture,
        CrudeProbeFixture,
    ]:
        first_base = CrudeProbeFixture(
            self.root / "v2 first base",
            work_ids=["shared-all", "base-a", "duplicate-base", "base-b"],
            page_prefix="v2-first-",
        )
        second_base = CrudeProbeFixture(
            self.root / "v2 second base",
            work_ids=["shared-all", "base-c", "duplicate-base", "base-d"],
            page_prefix="v2-second-",
        )
        incremental = CrudeProbeFixture(
            self.root / "v2 incremental",
            work_ids=["shared-all", "duplicate-base", "new-a", "new-b"],
            page_prefix="v2-new-",
        )
        pack_set_path = write_input_pack_set(
            self.root,
            [
                ("existing-z", "base", first_base),
                ("existing-a", "base", second_base),
                ("new-pack", "incremental", incremental),
            ],
            schema_version=TRAIN.INPUT_PACK_SET_SCHEMA_VERSION,
        )
        snapshot = TRAIN.load_training_pack_set_snapshot(
            pack_set_path, repository_root=self.root
        )
        return snapshot, pack_set_path, first_base, second_base, incremental

    def make_linear_final_output(self, name: str) -> tuple[Any, Path]:
        snapshot = self.fixture.load()
        output = self.root / name

        def deterministic_fit_predict(
            _model_kind,
            _train_indices,
            predict_indices,
            _inputs,
            active_labels,
            _config,
            _weight_bundle,
            seed,
            _class_targets=None,
        ):
            probabilities = np.asarray(
                [
                    (int(index) + 1) / (len(active_labels) + 2)
                    for index in predict_indices
                ],
                dtype=np.float64,
            )
            return probabilities, {
                "status": "deterministic-test-fit",
                "seed": seed,
            }

        linear_model = TRAIN.build_mobilenet_v3_small_gate(
            mode=TRAIN.LINEAR_BINARY_MODEL_KIND,
            seed=101,
            pretrained_state_dict=None,
        )
        fake_bundle = TRAIN.MobileNetWeightBundle(
            state_dict={}, provenance={"fixture": True}
        )
        with (
            mock.patch.object(
                TRAIN,
                "load_official_mobilenet_weights",
                return_value=fake_bundle,
            ),
            mock.patch.object(
                TRAIN,
                "_fit_predict_split",
                side_effect=deterministic_fit_predict,
            ),
            mock.patch.object(
                TRAIN,
                "_fit_mobile_model",
                return_value=(
                    linear_model,
                    {
                        "status": "deterministic-final-test-fit",
                        "trainableScope": "new final Linear only",
                        "trainableParameterCount": 1_025,
                    },
                ),
            ),
        ):
            TRAIN.run_evaluation(
                snapshot=snapshot,
                output_dir=output,
                model_kinds=(TRAIN.LINEAR_BINARY_MODEL_KIND,),
                config=TRAIN.EvaluationConfig(seed=101),
                allow_official_weight_download=False,
                export_final_model=TRAIN.LINEAR_BINARY_MODEL_KIND,
            )
        return snapshot, output

    def make_five_class_pack_set(self) -> Any:
        old = CrudeProbeFixture(
            self.root / "five class old pack",
            work_count=8,
            work_ids=[
                "shared-a",
                "shared-b",
                "old-a",
                "old-b",
                "old-c",
                "old-d",
                "old-e",
                "old-f",
            ],
            page_prefix="five-old-",
        )
        new = CrudeProbeFixture(
            self.root / "five class new pack",
            work_count=8,
            work_ids=[
                "shared-a",
                "shared-b",
                "new-a",
                "new-b",
                "new-c",
                "new-d",
                "new-e",
                "new-f",
            ],
            page_prefix="five-new-",
        )
        pack_set_path = write_input_pack_set(
            self.root,
            [("old-pack", "old", old), ("new-pack", "new", new)],
        )
        snapshot = TRAIN.load_training_pack_set_snapshot(
            pack_set_path, repository_root=self.root
        )
        labels_by_work_and_role = {
            ("shared-a", "old"): "safe_opaque",
            ("shared-b", "old"): "unsafe_translucent",
            ("old-a", "old"): "safe_opaque",
            ("old-b", "old"): "unsafe_open_or_illusory",
            ("old-c", "old"): "unsafe_mask_leak_or_clip",
            ("old-d", "old"): "unsafe_mask_leak_or_clip",
            ("old-e", "old"): "unsafe_merged_or_wrong_region",
            ("old-f", "old"): "unsafe_merged_or_wrong_region",
            ("shared-a", "new"): "unsafe_translucent",
            ("shared-b", "new"): "unsafe_open_or_illusory",
            ("new-a", "new"): "safe_opaque",
            ("new-b", "new"): "unsafe_translucent",
            ("new-c", "new"): "unsafe_open_or_illusory",
            ("new-d", "new"): "unsafe_mask_leak_or_clip",
            ("new-e", "new"): "unsafe_merged_or_wrong_region",
            ("new-f", "new"): "unsafe_merged_or_wrong_region",
        }
        samples = tuple(
            dataclasses.replace(
                sample,
                label=labels_by_work_and_role[(sample.work_id, sample.pack_role)],
                safe=(
                    labels_by_work_and_role[(sample.work_id, sample.pack_role)]
                    == "safe_opaque"
                ),
            )
            for sample in snapshot.samples
        )
        return dataclasses.replace(snapshot, samples=samples)

    def test_snapshot_is_bijective_and_production_input_excludes_cleaned(self) -> None:
        snapshot = self.fixture.load()
        self.assertEqual(len(snapshot.samples), 4)
        self.assertEqual(len(snapshot.work_ids), 4)
        self.assertNotIn("cleaned_path", TRAIN.TrainingSample.__dataclass_fields__)
        self.assertEqual(
            TRAIN.production_input_contract()["sourceArtifacts"],
            ["originalNative", "candidateCoreMask"],
        )
        self.assertFalse(TRAIN.production_input_contract()["cleanedPixelsUsed"])
        self.assertFalse(TRAIN.production_input_contract()["runtimePreprocessorParity"])
        self.assertFalse(
            TRAIN.production_input_contract()["exactProductionFloodParity"]
        )
        self.assertEqual(snapshot.source_page_count, 4)
        self.assertEqual(len(snapshot.source_work_ids), 4)

        real_hash = TRAIN._sha256_file
        hashed_paths: list[Path] = []

        def tracking_hash(path: Path) -> str:
            hashed_paths.append(Path(path))
            return real_hash(path)

        with mock.patch.object(TRAIN, "_sha256_file", side_effect=tracking_hash):
            tensor = TRAIN.load_production_input(snapshot.samples[0])
        self.assertEqual(tensor.shape, (4, 224, 224))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertEqual(set(np.unique(tensor[3])), {0.0, 1.0})
        self.assertEqual(
            hashed_paths,
            [snapshot.samples[0].original_path, snapshot.samples[0].core_mask_path],
        )
        self.assertFalse(any("cleaned" in path.name.lower() for path in hashed_paths))

    def test_pack_set_composes_strict_children_and_groups_shared_works(self) -> None:
        snapshot, pack_set_path, _old, _new = self.make_pack_set()
        self.assertEqual(len(snapshot.samples), 8)
        self.assertEqual(snapshot.source_page_count, 8)
        self.assertEqual(len(snapshot.source_work_ids), 6)
        self.assertEqual(len(snapshot.work_ids), 6)
        self.assertEqual(
            [sample.combined_ordinal for sample in snapshot.samples],
            list(range(1, 9)),
        )
        self.assertEqual(
            [sample.ordinal for sample in snapshot.samples], [1, 2, 3, 4] * 2
        )
        self.assertEqual(snapshot.pack_set_file_sha256, sha256_file(pack_set_path))
        self.assertEqual(
            snapshot.source_packs_canonical_sha256,
            TRAIN._sha256_json([pack.provenance() for pack in snapshot.packs]),
        )
        provenance_text = json.dumps(snapshot.provenance(), sort_keys=True)
        self.assertNotIn(str(self.root), provenance_text)
        self.assertNotIn("datasetDir", provenance_text)
        self.assertNotIn("labelsFile", provenance_text)

        folds = TRAIN.build_grouped_folds(snapshot.samples)
        self.assertEqual(len(folds), 6)
        for shared_work in ("shared-a", "shared-b"):
            fold = next(fold for fold in folds if shared_work in fold.holdout_work_ids)
            held_out = [snapshot.samples[index] for index in fold.test_indices]
            self.assertEqual({sample.pack_role for sample in held_out}, {"old", "new"})
            self.assertTrue(all(sample.work_id == shared_work for sample in held_out))

        plan = TRAIN.build_cross_pack_plan(snapshot)
        self.assertEqual(
            plan["directions"][0]["excludedOverlapWorkIds"],
            ["shared-a", "shared-b"],
        )
        by_id = {row["directionId"]: row for row in plan["directions"]}
        self.assertEqual(by_id["old_to_new"]["trainCandidateCount"], 2)
        self.assertEqual(by_id["old_to_new"]["targetCandidateCount"], 2)
        self.assertEqual(by_id["new_to_old"]["trainCandidateCount"], 2)
        self.assertEqual(by_id["new_to_old"]["targetCandidateCount"], 2)
        self.assertTrue(
            all(not row["trainTargetWorkIntersection"] for row in plan["directions"])
        )

    def test_pack_set_v2_is_ordered_bound_and_source_work_unseen(self) -> None:
        snapshot, pack_set_path, _first, _second, _incremental = self.make_pack_set_v2()
        reloaded = TRAIN.load_training_pack_set_snapshot(
            pack_set_path, repository_root=self.root
        )
        self.assertEqual(snapshot, reloaded)
        self.assertEqual(
            [pack.pack_id for pack in snapshot.packs],
            ["existing-z", "existing-a", "new-pack"],
        )
        self.assertEqual(
            [pack.role for pack in snapshot.packs],
            ["base", "base", "incremental"],
        )
        self.assertEqual(snapshot.input_schema_version, 2)
        self.assertEqual(
            snapshot.provenance()["sourceKind"], "strict_input_pack_set_v2"
        )
        self.assertEqual(snapshot.provenance()["inputPackSetSchemaVersion"], 2)
        self.assertEqual(
            snapshot.pack_set_canonical_sha256,
            TRAIN._sha256_json(json.loads(pack_set_path.read_text(encoding="utf-8"))),
        )
        self.assertEqual(
            [sample.combined_ordinal for sample in snapshot.samples],
            list(range(1, 13)),
        )

        plan = TRAIN.build_cross_pack_plan(snapshot)
        self.assertEqual(plan["inputPackSetSchemaVersion"], 2)
        self.assertEqual(
            plan["externalEvaluationView"],
            {
                "viewId": "base_to_incremental_source_work_unseen",
                "existingPackIds": ["existing-z", "existing-a"],
                "newPackId": "new-pack",
                "sourceWorkIdentity": "raw workId across every child pack",
                "existingSourceWorkIdsSha256": TRAIN._sha256_json(
                    [
                        "base-a",
                        "base-b",
                        "base-c",
                        "base-d",
                        "duplicate-base",
                        "shared-all",
                    ]
                ),
                "newSourceWorkIdsSha256": TRAIN._sha256_json(
                    ["duplicate-base", "new-a", "new-b", "shared-all"]
                ),
                "unseenTargetSourceWorkIdsSha256": TRAIN._sha256_json(
                    ["new-a", "new-b"]
                ),
                "overlapSourceWorkIdsSha256": TRAIN._sha256_json(
                    ["duplicate-base", "shared-all"]
                ),
                "overlapNewPackPagesGroupedOofOnly": True,
                "targetLabelsUsedForFit": False,
                "promotionAuthority": False,
            },
        )
        self.assertEqual(len(plan["directions"]), 1)
        direction = plan["directions"][0]
        self.assertEqual(
            direction["directionId"], "base_to_incremental_source_work_unseen"
        )
        self.assertEqual(direction["trainPackIds"], ["existing-z", "existing-a"])
        self.assertEqual(
            direction["excludedOverlapWorkIds"],
            ["duplicate-base", "shared-all"],
        )
        self.assertEqual(direction["targetWorkIds"], ["new-a", "new-b"])
        train_indices, target_indices = TRAIN._cross_pack_indices(snapshot, direction)
        self.assertEqual(len(train_indices), 8)
        self.assertEqual(len(target_indices), 2)
        self.assertEqual(
            {snapshot.samples[index].work_id for index in target_indices},
            {"new-a", "new-b"},
        )
        self.assertTrue(
            all(snapshot.samples[index].pack_role == "base" for index in train_indices)
        )

    def test_pack_set_v2_source_inventory_blocks_zero_candidate_seen_work(self) -> None:
        snapshot, _pack_set_path, _first, _second, _incremental = (
            self.make_pack_set_v2()
        )
        first_pack = snapshot.packs[0]
        source_only_snapshot = dataclasses.replace(
            first_pack.snapshot,
            source_work_ids=tuple(
                sorted((*first_pack.snapshot.source_work_ids, "new-a"))
            ),
        )
        source_only_pack_set = dataclasses.replace(
            snapshot,
            packs=(
                dataclasses.replace(first_pack, snapshot=source_only_snapshot),
                *snapshot.packs[1:],
            ),
        )

        plan = TRAIN.build_cross_pack_plan(source_only_pack_set)
        direction = plan["directions"][0]
        self.assertIn("new-a", direction["existingSourceWorkIds"])
        self.assertIn("new-a", direction["excludedOverlapWorkIds"])
        self.assertEqual(direction["targetWorkIds"], ["new-b"])
        _train_indices, target_indices = TRAIN._cross_pack_indices(
            source_only_pack_set, direction
        )
        self.assertEqual(
            [source_only_pack_set.samples[index].work_id for index in target_indices],
            ["new-b"],
        )

    def test_pack_set_v2_never_splits_one_work_across_children(self) -> None:
        snapshot, _pack_set_path, _first, _second, _incremental = (
            self.make_pack_set_v2()
        )
        folds = TRAIN.build_grouped_folds(snapshot.samples)
        shared_fold = next(
            fold for fold in folds if fold.holdout_work_ids == ("shared-all",)
        )
        self.assertEqual(len(shared_fold.test_indices), 3)
        self.assertEqual(
            {snapshot.samples[index].pack_id for index in shared_fold.test_indices},
            {"existing-z", "existing-a", "new-pack"},
        )
        self.assertNotIn(
            "shared-all",
            {snapshot.samples[index].work_id for index in shared_fold.train_indices},
        )

        direction = TRAIN.build_cross_pack_plan(snapshot)["directions"][0]
        source_indices, _target_indices = TRAIN._cross_pack_indices(snapshot, direction)
        source_samples = tuple(snapshot.samples[index] for index in source_indices)
        source_inputs = np.zeros((len(source_samples), 1), dtype=np.float32)
        source_labels = np.asarray(
            [sample.safe for sample in source_samples], dtype=np.int64
        )
        observed: list[tuple[set[str], set[str], set[str]]] = []

        def deterministic_fit_predict(
            _model_kind,
            train_indices,
            predict_indices,
            _inputs,
            _labels,
            _config,
            _weight_bundle,
            _seed,
            _class_targets=None,
        ):
            train_samples = [source_samples[index] for index in train_indices]
            validation_samples = [source_samples[index] for index in predict_indices]
            observed.append(
                (
                    {sample.work_id for sample in train_samples},
                    {sample.work_id for sample in validation_samples},
                    {sample.pack_id or "" for sample in validation_samples},
                )
            )
            return np.full(len(predict_indices), 0.5, dtype=np.float64), {
                "status": "deterministic-test-fit"
            }

        pseudo_fold = TRAIN.GroupFold(
            fold_id="external-base-threshold",
            holdout_work_ids=(),
            train_indices=tuple(range(len(source_samples))),
            test_indices=(),
        )
        with mock.patch.object(
            TRAIN, "_fit_predict_split", side_effect=deterministic_fit_predict
        ):
            probabilities, records = TRAIN._inner_cross_fitted_probabilities(
                "heuristic_original_core_v1",
                pseudo_fold,
                source_samples,
                source_inputs,
                source_labels,
                TRAIN.EvaluationConfig(seed=73),
                None,
            )
        self.assertTrue(np.all(np.isfinite(probabilities)))
        self.assertEqual(len(records), 6)
        duplicate_holdout = next(
            entry for entry in observed if entry[1] == {"duplicate-base"}
        )
        self.assertNotIn("duplicate-base", duplicate_holdout[0])
        self.assertEqual(duplicate_holdout[2], {"existing-z", "existing-a"})

    def test_pack_set_v2_binding_and_child_tamper_fail_closed(self) -> None:
        _snapshot, pack_set_path, _first, _second, _incremental = (
            self.make_pack_set_v2()
        )
        original = json.loads(pack_set_path.read_text(encoding="utf-8"))

        tampered = copy.deepcopy(original)
        tampered["packs"][0], tampered["packs"][1] = (
            tampered["packs"][1],
            tampered["packs"][0],
        )
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "canonical binding mismatch"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"][1]["datasetSealSha256"] = "0" * 64
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "child binding mismatch"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"][1]["packId"] = tampered["packs"][0]["packId"]
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "packId order/uniqueness"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"] = tampered["packs"][:2]
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "requires at least three ordered packs"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"][1]["role"] = "incremental"
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "ordered base packs followed by exactly one incremental pack",
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        for name, roles in {
            "all-base": ["base", "base", "base"],
            "legacy-role": ["base", "base", "new"],
        }.items():
            with self.subTest(malformed_v2_roles=name):
                tampered = copy.deepcopy(original)
                for child, role in zip(tampered["packs"], roles, strict=True):
                    child["role"] = role
                unbound = dict(tampered)
                unbound.pop("bindingSha256")
                tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
                write_json(pack_set_path, tampered)
                with self.assertRaisesRegex(
                    TRAIN.BubbleFitTrainingError,
                    "ordered base packs followed by exactly one incremental pack",
                ):
                    TRAIN.load_training_pack_set_snapshot(
                        pack_set_path, repository_root=self.root
                    )

    def test_pack_set_v2_empty_unseen_target_fails_before_model_work(self) -> None:
        first_base = CrudeProbeFixture(
            self.root / "empty target first",
            work_count=2,
            work_ids=["seen-a", "seen-b"],
            page_prefix="empty-first-",
        )
        second_base = CrudeProbeFixture(
            self.root / "empty target second",
            work_count=2,
            work_ids=["seen-c", "seen-d"],
            page_prefix="empty-second-",
        )
        incremental = CrudeProbeFixture(
            self.root / "empty target incremental",
            work_count=2,
            work_ids=["seen-a", "seen-d"],
            page_prefix="empty-new-",
        )
        pack_set_path = write_input_pack_set(
            self.root,
            [
                ("base-one", "base", first_base),
                ("base-two", "base", second_base),
                ("new-pack", "incremental", incremental),
            ],
            schema_version=TRAIN.INPUT_PACK_SET_SCHEMA_VERSION,
            identifier="synthetic-empty-unseen-v2",
        )
        snapshot = TRAIN.load_training_pack_set_snapshot(
            pack_set_path, repository_root=self.root
        )
        output = self.root / "must-not-start-model-work"
        with (
            mock.patch.object(
                TRAIN,
                "evaluate_model",
                side_effect=AssertionError("model evaluation must not start"),
            ),
            self.assertRaisesRegex(
                TRAIN.BubbleFitTrainingError,
                "no source-work-unseen target candidates",
            ),
        ):
            TRAIN.run_evaluation(
                snapshot=snapshot,
                output_dir=output,
                model_kinds=("heuristic_original_core_v1",),
                config=TRAIN.EvaluationConfig(seed=79),
                allow_official_weight_download=False,
            )
        self.assertFalse(output.exists())

    def test_pack_set_path_order_and_child_hash_tamper_fail_closed(self) -> None:
        _snapshot, pack_set_path, _old, _new = self.make_pack_set()
        original = json.loads(pack_set_path.read_text(encoding="utf-8"))

        tampered = copy.deepcopy(original)
        tampered["packs"][0]["datasetManifestSha256"] = "f" * 64
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "child binding mismatch"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"].reverse()
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "packId order/uniqueness"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"][0]["datasetDir"] = str(self.root.resolve())
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "canonical POSIX separators|unsafe repository-relative",
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

        tampered = copy.deepcopy(original)
        tampered["packs"][1]["datasetDir"] = tampered["packs"][0]["datasetDir"]
        unbound = dict(tampered)
        unbound.pop("bindingSha256")
        tampered["bindingSha256"] = TRAIN._sha256_json(unbound)
        write_json(pack_set_path, tampered)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "reuses a child dataset or labels file"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

    def test_pack_set_source_page_collision_fails_closed(self) -> None:
        first_base = CrudeProbeFixture(
            self.root / "collision first base",
            work_count=2,
            work_ids=["base-a", "base-b"],
            page_prefix="same-",
        )
        second_base = CrudeProbeFixture(
            self.root / "collision second base",
            work_count=2,
            work_ids=["base-c", "base-d"],
            page_prefix="same-",
        )
        incremental = CrudeProbeFixture(
            self.root / "collision incremental",
            work_count=2,
            work_ids=["new-a", "new-b"],
            page_prefix="collision-new-",
        )
        pack_set_path = write_input_pack_set(
            self.root,
            [
                ("base-one", "base", first_base),
                ("base-two", "base", second_base),
                ("new-pack", "incremental", incremental),
            ],
            schema_version=TRAIN.INPUT_PACK_SET_SCHEMA_VERSION,
        )
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "source page id collision"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

    def test_pack_set_candidate_id_collision_fails_closed(self) -> None:
        first_base = CrudeProbeFixture(
            self.root / "candidate collision first base",
            work_count=2,
            work_ids=["base-a", "base-b"],
            page_prefix="first-candidate-",
        )
        second_base = CrudeProbeFixture(
            self.root / "candidate collision second base",
            work_count=2,
            work_ids=["base-c", "base-d"],
            page_prefix="second-candidate-",
        )
        incremental = CrudeProbeFixture(
            self.root / "candidate collision incremental",
            work_count=2,
            work_ids=["new-a", "new-b"],
            page_prefix="incremental-candidate-",
        )
        first_id = first_base.manifest["candidates"][0]["id"]
        manifest = json.loads(second_base.manifest_path.read_text(encoding="utf-8"))
        manifest["candidates"][0]["id"] = first_id
        unbound_manifest = dict(manifest)
        unbound_manifest.pop("manifestBindingSha256")
        manifest["manifestBindingSha256"] = TRAIN._sha256_json(unbound_manifest)
        write_json(second_base.manifest_path, manifest)
        seal_path = second_base.dataset_dir / "dataset-seal.json"
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
        seal["manifestSha256"] = sha256_file(second_base.manifest_path)
        seal["manifestBindingSha256"] = manifest["manifestBindingSha256"]
        write_json(seal_path, seal)
        labels = json.loads(second_base.labels_path.read_text(encoding="utf-8"))
        labels["sourceDataset"]["manifestSha256"] = sha256_file(
            second_base.manifest_path
        )
        labels["sourceDataset"]["manifestBindingSha256"] = manifest[
            "manifestBindingSha256"
        ]
        labels["annotations"][0]["candidateId"] = first_id
        write_json(second_base.labels_path, labels)
        pack_set_path = write_input_pack_set(
            self.root,
            [
                ("base-one", "base", first_base),
                ("base-two", "base", second_base),
                ("new-pack", "incremental", incremental),
            ],
            schema_version=TRAIN.INPUT_PACK_SET_SCHEMA_VERSION,
        )
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "candidate id collision"
        ):
            TRAIN.load_training_pack_set_snapshot(
                pack_set_path, repository_root=self.root
            )

    def test_core_mask_must_be_byte_exact_metadata_filled_rectangle(self) -> None:
        mask = Image.new("L", (12, 10), 0)
        draw = ImageDraw.Draw(mask)
        draw.rectangle((2, 3, 8, 7), fill=255)
        TRAIN._assert_exact_filled_rectangle_mask(mask, (2, 3, 9, 8), "candidate")
        mask.putpixel((4, 5), 0)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "exact metadata-bbox filled rectangle"
        ):
            TRAIN._assert_exact_filled_rectangle_mask(mask, (2, 3, 9, 8), "candidate")
        mask.close()

    def test_label_semantic_tamper_and_missing_candidate_fail_closed(self) -> None:
        labels = json.loads(self.fixture.labels_path.read_text(encoding="utf-8"))
        labels["annotations"][0]["safeForBubbleFit"] = True
        write_json(self.fixture.labels_path, labels)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "label/safeForBubbleFit"
        ):
            self.fixture.load()

        write_json(self.fixture.labels_path, self.fixture.labels)
        labels = json.loads(self.fixture.labels_path.read_text(encoding="utf-8"))
        labels["annotations"].pop()
        write_json(self.fixture.labels_path, labels)
        with self.assertRaisesRegex(TRAIN.BubbleFitTrainingError, "cover every"):
            self.fixture.load()

    def test_even_cleaned_artifact_tamper_fails_source_validation(self) -> None:
        candidate = self.fixture.manifest["candidates"][0]
        cleaned = (
            self.fixture.dataset_dir / candidate["artifacts"]["cleanedNative"]["path"]
        )
        Image.new("RGB", (8, 8), (255, 0, 0)).save(cleaned, format="PNG")
        with self.assertRaisesRegex(TRAIN.BubbleFitTrainingError, "SHA-256 mismatch"):
            self.fixture.load()

    def test_grouped_folds_hold_out_every_work_once_and_reject_leakage(self) -> None:
        snapshot = self.fixture.load()
        folds = TRAIN.build_grouped_folds(snapshot.samples)
        self.assertEqual(len(folds), 4)
        self.assertEqual(
            sorted(work for fold in folds for work in fold.holdout_work_ids),
            list(snapshot.work_ids),
        )
        for fold in folds:
            train_works = {
                snapshot.samples[index].work_id for index in fold.train_indices
            }
            test_works = {
                snapshot.samples[index].work_id for index in fold.test_indices
            }
            self.assertFalse(train_works & test_works)

        leaked_samples = list(snapshot.samples)
        leaked_samples[1] = dataclasses.replace(
            leaked_samples[1], work_id=leaked_samples[0].work_id
        )
        bad = TRAIN.GroupFold(
            fold_id="bad",
            holdout_work_ids=(leaked_samples[0].work_id,),
            train_indices=(0,),
            test_indices=(1,),
        )
        with self.assertRaisesRegex(TRAIN.BubbleFitTrainingError, "leaks a work"):
            TRAIN.assert_work_disjoint_fold(bad, leaked_samples)

    def test_heuristic_oof_is_work_disjoint_and_output_is_nonpromotable(self) -> None:
        snapshot = self.fixture.load()
        output = self.root / "heuristic evaluation"
        result = TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=output,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=19),
            allow_official_weight_download=False,
        )
        self.assertFalse(result["promotionEligible"])
        report = json.loads(
            (output / "evaluation-report.json").read_text(encoding="utf-8")
        )
        self.assertFalse(report["promotionEligible"])
        self.assertEqual(report["schemaVersion"], TRAIN.SCHEMA_VERSION)
        self.assertNotIn("inputPackSetCanonicalSha256", report)
        self.assertNotIn("crossPackEvaluation", report)
        self.assertTrue(report["productionUseForbidden"])
        self.assertEqual(report["artifactStage"], "crude_probe_4_pages_4_candidates")
        self.assertEqual(
            report["cohortCounts"],
            {
                "candidateBearingWorkCount": 4,
                "candidateCount": 4,
                "sourcePageCount": 4,
                "sourceWorkCount": 4,
            },
        )
        self.assertFalse(report["inputContract"]["cleanedPixelsUsed"])
        self.assertIsNone(report["bestCrudeProbeOnly"])
        self.assertFalse(
            report["safetyEvidenceLimits"]["candidateIndependenceAsserted"]
        )
        self.assertGreater(
            report["safetyEvidenceLimits"][
                "candidateLevelDiagnosticZeroFailureUpper95"
            ],
            report["safetyEvidenceLimits"]["unsafeFalseAcceptTarget"],
        )
        self.assertFalse(report["productionSafetyEstablished"])
        self.assertFalse(report["confirmatory"])
        confirmatory = report["confirmatoryAuditContract"]
        self.assertFalse(confirmatory["productionSafetyEstablished"])
        self.assertEqual(confirmatory["referenceLibraryInventoryWorkCount"], 38)
        self.assertIsNone(confirmatory["eligibleUntouchedWorkClusterCount"])
        self.assertEqual(
            confirmatory["minimumZeroFailureWorkClustersForFivePercent"], 59
        )
        self.assertFalse(
            confirmatory[
                "theoreticalBestCaseAssumingEveryInventoryWorkIsEligibleUntouchedAndHasZeroFailures"
            ]["meetsTarget"]
        )
        self.assertFalse(
            confirmatory["precommittedExposureProtocol"]["currentlySealed"]
        )
        self.assertNotIn("datasetDir", report["source"])
        self.assertNotIn("labelsPath", report["source"])
        self.assertTrue(result["artifactValidation"]["ok"])
        model = report["models"][0]
        self.assertEqual(len(model["folds"]), 4)
        self.assertTrue(
            all(fold["thresholdSelectionExcludesHoldout"] for fold in model["folds"])
        )
        self.assertFalse(model["outerOofMetrics"]["allOuterDecisionsAvailable"])
        self.assertFalse(model["outerOofMetrics"]["outerExploratoryTargetMet"])
        self.assertEqual(
            model["outerOofMetrics"]["innerThresholdUnavailableOuterFoldCount"],
            4,
        )
        self.assertTrue(
            all(
                fold["thresholdSelection"]["status"] == "noInnerThresholdAvailable"
                for fold in model["folds"]
            )
        )
        self.assertIsNone(
            model["foldThresholdAggregationForOptionalFinalCandidate"][
                "operationalThreshold"
            ]
        )
        rows = [
            json.loads(line)
            for line in (output / "oof-predictions.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertEqual(len(rows), 4)
        self.assertEqual(
            {row["candidateId"] for row in rows},
            {s.candidate_id for s in snapshot.samples},
        )
        self.assertTrue(all(row["promotionEligible"] is False for row in rows))
        self.assertTrue(all(row["decisionAvailable"] is False for row in rows))
        self.assertTrue(all(row["threshold"] is None for row in rows))
        self.assertTrue(all(row["predictedSafe"] is None for row in rows))
        with (
            mock.patch.object(
                TRAIN,
                "execution_authority",
                return_value={"changedProducerAuthority": True},
            ),
            self.assertRaisesRegex(
                TRAIN.BubbleFitTrainingError,
                "legacy v4/v5 structural reader compatibility",
            ),
        ):
            TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_pack_set_evaluation_is_v6_bound_and_cross_pack_is_exploratory(
        self,
    ) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        output = self.root / "pack-set evaluation"
        result = TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=output,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=53),
            allow_official_weight_download=False,
        )
        self.assertEqual(
            result["artifactValidation"]["schemaVersion"],
            TRAIN.PACK_SET_OUTPUT_SCHEMA_VERSION,
        )
        report = json.loads(
            (output / "evaluation-report.json").read_text(encoding="utf-8")
        )
        manifest = json.loads(
            (output / "artifact-manifest.json").read_text(encoding="utf-8")
        )
        seal = json.loads((output / "artifact-seal.json").read_text(encoding="utf-8"))
        self.assertEqual(report["schemaVersion"], TRAIN.PACK_SET_OUTPUT_SCHEMA_VERSION)
        self.assertNotIn("inputPackSetSchemaVersion", report["crossPackEvaluation"])
        legacy_plan = TRAIN.build_cross_pack_plan(
            snapshot,
            schema_version=TRAIN.LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        )
        self.assertEqual(
            legacy_plan["schemaVersion"],
            TRAIN.LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        )
        self.assertNotIn("inputPackSetSchemaVersion", legacy_plan)
        self.assertEqual(report["source"], snapshot.provenance())
        self.assertFalse(report["crossPackEvaluation"]["affectsCombinedModelRanking"])
        self.assertFalse(report["crossPackEvaluation"]["promotionAuthority"])
        self.assertEqual(
            report["runConfiguration"]["inputMode"], "strict_input_pack_set_v1"
        )
        for payload in (report, manifest, seal):
            for key in TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS:
                self.assertEqual(payload[key], seal["authorityBindings"][key])
            for key, value in TRAIN.PREDICTION_EVIDENCE_LIMITATIONS.items():
                self.assertEqual(payload[key], value)
            self.assertEqual(
                payload["schemaCompatibility"]["legacyCompatibilityScope"],
                "structural reader compatibility only",
            )
            self.assertIn(
                "malicious coherent reseal",
                payload["predictionEvidenceInterpretation"],
            )
        self.assertEqual(
            report["inputPackSetCanonicalSha256"],
            snapshot.pack_set_canonical_sha256,
        )
        serialized = "\n".join(
            path.read_text(encoding="utf-8", errors="ignore")
            for path in output.rglob("*.json*")
        )
        self.assertNotIn(str(self.root), serialized)

        oof_rows = [
            json.loads(line)
            for line in (output / "oof-predictions.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        shared_rows = [row for row in oof_rows if row["workId"] == "shared-a"]
        self.assertEqual({row["packRole"] for row in shared_rows}, {"old", "new"})
        self.assertEqual(len({row["foldId"] for row in shared_rows}), 1)
        self.assertEqual(
            sorted(row["combinedOrdinal"] for row in oof_rows), list(range(1, 9))
        )
        self.assertIn("thresholdFreeCombinedOofMetrics", report["models"][0])
        self.assertTrue(
            all(
                "thresholdSelectionSafeProbabilities" in fold
                for fold in report["models"][0]["folds"]
            )
        )
        cross_rows = [
            json.loads(line)
            for line in (output / "cross-pack-predictions.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertEqual(len(cross_rows), 4)
        self.assertTrue(
            all(row["workId"] not in {"shared-a", "shared-b"} for row in cross_rows)
        )
        self.assertTrue(all(row["promotionAuthority"] is False for row in cross_rows))
        self.assertTrue(
            all(row["targetLabelsUsedForThreshold"] is False for row in cross_rows)
        )
        self.assertTrue(
            all("inputPackSetSchemaVersion" not in row for row in cross_rows)
        )
        self.assertTrue(
            TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)["ok"]
        )
        polluted_v1 = self.root / "pack-set v1 cross direction variant pollution"
        shutil.copytree(output, polluted_v1)
        polluted_report_path = polluted_v1 / "evaluation-report.json"
        polluted_report = json.loads(polluted_report_path.read_text(encoding="utf-8"))
        polluted_report["crossPackEvaluation"]["models"][0]["directions"][0][
            "sourceWorkUnseenFromAllExistingPacks"
        ] = True
        write_json(polluted_report_path, polluted_report)
        rewrite_manifest_and_seal(polluted_v1)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "cross-pack direction report binding is invalid",
        ):
            TRAIN.validate_output_artifacts(polluted_v1, expected_snapshot=snapshot)
        legacy_output = self.root / "pack-set evaluation legacy v5"
        shutil.copytree(output, legacy_output)
        downgrade_pack_output_to_legacy_v5(legacy_output, snapshot)
        legacy_validation = TRAIN.validate_output_artifacts(
            legacy_output, expected_snapshot=snapshot
        )
        self.assertEqual(
            legacy_validation["schemaVersion"],
            TRAIN.LEGACY_PACK_SET_OUTPUT_SCHEMA_VERSION,
        )
        legacy_threshold_output = self.root / "legacy v5 threshold tamper"
        shutil.copytree(legacy_output, legacy_threshold_output)
        legacy_report_path = legacy_threshold_output / "evaluation-report.json"
        legacy_report = json.loads(legacy_report_path.read_text(encoding="utf-8"))
        legacy_report["crossPackEvaluation"]["models"][0]["directions"][0][
            "sourceThresholdSelection"
        ]["confirmatory"] = True
        write_json(legacy_report_path, legacy_report)
        rewrite_manifest_and_seal(legacy_threshold_output)
        with self.assertRaises(TRAIN.BubbleFitTrainingError):
            TRAIN.validate_output_artifacts(
                legacy_threshold_output, expected_snapshot=snapshot
            )
        with (
            mock.patch.object(
                TRAIN,
                "execution_authority",
                return_value={"changedProducerAuthority": True},
            ),
            self.assertRaisesRegex(
                TRAIN.BubbleFitTrainingError,
                "structural reader compatibility does not imply",
            ),
        ):
            TRAIN.validate_output_artifacts(legacy_output, expected_snapshot=snapshot)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "requires a revalidated expected snapshot"
        ):
            TRAIN.validate_output_artifacts(output)

    def test_pack_set_v2_evaluation_and_strict_validator_bind_external_view(
        self,
    ) -> None:
        snapshot, _pack_set_path, _first, _second, _incremental = (
            self.make_pack_set_v2()
        )
        output = self.root / "pack-set v2 synthetic heuristic evaluation"
        result = TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=output,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=83),
            allow_official_weight_download=False,
        )
        self.assertTrue(result["artifactValidation"]["ok"])

        report = json.loads(
            (output / "evaluation-report.json").read_text(encoding="utf-8")
        )
        plan = json.loads((output / "cross-pack-plan.json").read_text(encoding="utf-8"))
        cross_rows = [
            json.loads(line)
            for line in (output / "cross-pack-predictions.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        oof_rows = [
            json.loads(line)
            for line in (output / "oof-predictions.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]

        self.assertEqual(report["source"]["sourceKind"], "strict_input_pack_set_v2")
        self.assertEqual(
            report["runConfiguration"]["inputMode"], "strict_input_pack_set_v2"
        )
        self.assertEqual(plan["inputPackSetSchemaVersion"], 2)
        self.assertEqual(report["crossPackEvaluation"]["inputPackSetSchemaVersion"], 2)
        self.assertEqual(len(cross_rows), 2)
        self.assertEqual({row["workId"] for row in cross_rows}, {"new-a", "new-b"})
        self.assertTrue(
            all(row["inputPackSetSchemaVersion"] == 2 for row in cross_rows)
        )
        self.assertTrue(
            all(row["sourceWorkUnseenFromAllExistingPacks"] for row in cross_rows)
        )
        shared_rows = [row for row in oof_rows if row["workId"] == "shared-all"]
        self.assertEqual(len(shared_rows), 3)
        self.assertEqual(len({row["foldId"] for row in shared_rows}), 1)
        self.assertTrue(
            TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)["ok"]
        )

        tampered_output = self.root / "pack-set v2 missing tagged-union discriminator"
        shutil.copytree(output, tampered_output)
        report_path = tampered_output / "evaluation-report.json"
        tampered_report = json.loads(report_path.read_text(encoding="utf-8"))
        tampered_report["crossPackEvaluation"].pop("inputPackSetSchemaVersion")
        write_json(report_path, tampered_report)
        rewrite_manifest_and_seal(tampered_output)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "cross-pack report contract is invalid"
        ):
            TRAIN.validate_output_artifacts(tampered_output, expected_snapshot=snapshot)

        polluted_output = self.root / "pack-set v2 cross direction variant pollution"
        shutil.copytree(output, polluted_output)
        polluted_report_path = polluted_output / "evaluation-report.json"
        polluted_report = json.loads(polluted_report_path.read_text(encoding="utf-8"))
        polluted_report["crossPackEvaluation"]["models"][0]["directions"][0][
            "overlappingWorkExcludedFromTrainAndTarget"
        ] = True
        write_json(polluted_report_path, polluted_report)
        rewrite_manifest_and_seal(polluted_output)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "cross-pack direction report binding is invalid",
        ):
            TRAIN.validate_output_artifacts(polluted_output, expected_snapshot=snapshot)

    def test_cross_pack_source_threshold_does_not_use_target_labels(self) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        plan = TRAIN.build_cross_pack_plan(snapshot)
        inputs = np.zeros((len(snapshot.samples), 4, 224, 224), dtype=np.float32)
        inputs[:, 3, 48:176, 64:160] = 1.0
        labels = np.asarray(
            [sample.safe for sample in snapshot.samples], dtype=np.int64
        )
        structurally_absent_target_calls = 0

        def deterministic_fit_predict(
            _model_kind,
            train_indices,
            predict_indices,
            _inputs,
            active_labels,
            _config,
            _weight_bundle,
            _seed,
            _class_targets=None,
        ):
            nonlocal structurally_absent_target_calls
            train_values = active_labels[np.asarray(train_indices, dtype=np.int64)]
            predict_values = active_labels[np.asarray(predict_indices, dtype=np.int64)]
            if np.any(active_labels == -1):
                structurally_absent_target_calls += 1
                self.assertTrue(np.all(predict_values == -1))
                self.assertTrue(set(np.unique(train_values)).issubset({0, 1}))
            probabilities = np.asarray(
                [(index + 1) / (len(active_labels) + 2) for index in predict_indices],
                dtype=np.float64,
            )
            return probabilities, {
                "status": "deterministic-test-fit",
                "trainSafeCount": int(np.count_nonzero(train_values == 1)),
                "trainUnsafeCount": int(np.count_nonzero(train_values == 0)),
            }

        with mock.patch.object(
            TRAIN, "_fit_predict_split", side_effect=deterministic_fit_predict
        ):
            first_report, first_rows = TRAIN.evaluate_cross_pack_directions(
                snapshot=snapshot,
                plan=plan,
                model_kinds=("mobilenet_v3_small_frozen_head",),
                inputs=inputs,
                labels=labels,
                config=TRAIN.EvaluationConfig(seed=61),
                weight_bundle=None,
            )
            changed = labels.copy()
            old_to_new = next(
                direction
                for direction in plan["directions"]
                if direction["directionId"] == "old_to_new"
            )
            _train, target = TRAIN._cross_pack_indices(snapshot, old_to_new)
            changed[np.asarray(target, dtype=np.int64)] = (
                1 - changed[np.asarray(target, dtype=np.int64)]
            )
            second_report, second_rows = TRAIN.evaluate_cross_pack_directions(
                snapshot=snapshot,
                plan=plan,
                model_kinds=("mobilenet_v3_small_frozen_head",),
                inputs=inputs,
                labels=changed,
                config=TRAIN.EvaluationConfig(seed=61),
                weight_bundle=None,
            )
        first_direction = next(
            row
            for row in first_report["models"][0]["directions"]
            if row["directionId"] == "old_to_new"
        )
        second_direction = next(
            row
            for row in second_report["models"][0]["directions"]
            if row["directionId"] == "old_to_new"
        )
        self.assertEqual(
            first_direction["sourceThresholdSelection"],
            second_direction["sourceThresholdSelection"],
        )
        self.assertEqual(
            first_direction["sourceThreshold"], second_direction["sourceThreshold"]
        )
        first_probabilities = [
            row["safeProbability"]
            for row in first_rows
            if row["directionId"] == "old_to_new"
        ]
        second_probabilities = [
            row["safeProbability"]
            for row in second_rows
            if row["directionId"] == "old_to_new"
        ]
        self.assertEqual(first_probabilities, second_probabilities)
        self.assertEqual(structurally_absent_target_calls, 4)

    def test_pack_set_v2_external_fit_never_receives_target_labels(self) -> None:
        snapshot, _pack_set_path, _first, _second, _incremental = (
            self.make_pack_set_v2()
        )
        plan = TRAIN.build_cross_pack_plan(snapshot)
        inputs = np.zeros((len(snapshot.samples), 4, 224, 224), dtype=np.float32)
        inputs[:, 3, 48:176, 64:160] = 1.0
        labels = np.asarray(
            [sample.safe for sample in snapshot.samples], dtype=np.int64
        )
        structurally_absent_target_calls = 0

        def deterministic_fit_predict(
            _model_kind,
            train_indices,
            predict_indices,
            _inputs,
            active_labels,
            _config,
            _weight_bundle,
            _seed,
            _class_targets=None,
        ):
            nonlocal structurally_absent_target_calls
            train_values = active_labels[np.asarray(train_indices, dtype=np.int64)]
            predict_values = active_labels[np.asarray(predict_indices, dtype=np.int64)]
            if np.any(active_labels == -1):
                structurally_absent_target_calls += 1
                self.assertTrue(np.all(predict_values == -1))
                self.assertTrue(set(np.unique(train_values)).issubset({0, 1}))
            probabilities = np.asarray(
                [(index + 1) / (len(active_labels) + 2) for index in predict_indices],
                dtype=np.float64,
            )
            return probabilities, {"status": "deterministic-test-fit"}

        direction = plan["directions"][0]
        _train, target = TRAIN._cross_pack_indices(snapshot, direction)
        changed = labels.copy()
        changed[np.asarray(target, dtype=np.int64)] = (
            1 - changed[np.asarray(target, dtype=np.int64)]
        )
        with mock.patch.object(
            TRAIN, "_fit_predict_split", side_effect=deterministic_fit_predict
        ):
            first_report, first_rows = TRAIN.evaluate_cross_pack_directions(
                snapshot=snapshot,
                plan=plan,
                model_kinds=("mobilenet_v3_small_frozen_head",),
                inputs=inputs,
                labels=labels,
                config=TRAIN.EvaluationConfig(seed=89),
                weight_bundle=None,
            )
            second_report, second_rows = TRAIN.evaluate_cross_pack_directions(
                snapshot=snapshot,
                plan=plan,
                model_kinds=("mobilenet_v3_small_frozen_head",),
                inputs=inputs,
                labels=changed,
                config=TRAIN.EvaluationConfig(seed=89),
                weight_bundle=None,
            )

        first_direction = first_report["models"][0]["directions"][0]
        second_direction = second_report["models"][0]["directions"][0]
        self.assertEqual(
            first_direction["sourceThresholdSelection"],
            second_direction["sourceThresholdSelection"],
        )
        self.assertEqual(
            first_direction["sourceThresholdSelectionSafeProbabilities"],
            second_direction["sourceThresholdSelectionSafeProbabilities"],
        )
        self.assertEqual(
            first_direction["sourceThreshold"], second_direction["sourceThreshold"]
        )
        self.assertEqual(
            [row["safeProbability"] for row in first_rows],
            [row["safeProbability"] for row in second_rows],
        )
        self.assertNotEqual(
            first_direction["targetThresholdFreeMetrics"],
            second_direction["targetThresholdFreeMetrics"],
        )
        self.assertEqual(structurally_absent_target_calls, 2)

    def test_v6_resealed_oof_decision_field_tamper_fails_closed(self) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        base = self.root / "strict OOF decision base"
        TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=base,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=59, unsafe_false_accept_target=1.0),
            allow_official_weight_download=False,
        )

        def threshold(row):
            row["threshold"] = 0.0 if row["threshold"] != 0.0 else 1.0
            row["predictedSafe"] = row["safeProbability"] >= row["threshold"]

        def decision_available(row):
            row.update(
                {
                    "decisionAvailable": False,
                    "threshold": None,
                    "predictedSafe": None,
                }
            )

        def predicted_safe(row):
            row["predictedSafe"] = not row["predictedSafe"]

        mutations = {
            "threshold": threshold,
            "decisionAvailable": decision_available,
            "predictedSafe": predicted_safe,
        }
        for name, mutate in mutations.items():
            with self.subTest(field=name):
                output = self.root / f"strict OOF decision {name}"
                shutil.copytree(base, output)
                oof_path = output / "oof-predictions.jsonl"
                rows = [
                    json.loads(line)
                    for line in oof_path.read_text(encoding="utf-8").splitlines()
                ]
                self.assertTrue(rows[0]["decisionAvailable"])
                mutate(rows[0])
                oof_path.write_text(
                    "".join(
                        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                        for row in rows
                    ),
                    encoding="utf-8",
                )
                coherently_rebind_oof(output)
                with self.assertRaises(TRAIN.BubbleFitTrainingError, msg=name):
                    TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)
        for location in ("manifest", "seal"):
            with self.subTest(prediction_contract_location=location):
                output = self.root / f"strict prediction contract {location}"
                shutil.copytree(base, output)
                manifest_path = output / "artifact-manifest.json"
                seal_path = output / "artifact-seal.json"
                path = manifest_path if location == "manifest" else seal_path
                payload = json.loads(path.read_text(encoding="utf-8"))
                payload["keyedAuthenticityEstablished"] = True
                write_json(path, payload)
                if location == "manifest":
                    seal = json.loads(seal_path.read_text(encoding="utf-8"))
                    seal["manifestSha256"] = sha256_file(manifest_path)
                    write_json(seal_path, seal)
                with self.assertRaises(TRAIN.BubbleFitTrainingError):
                    TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_v6_cross_no_source_threshold_contract_is_strict(self) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        output = self.root / "strict cross no source threshold"
        original_inner = TRAIN._inner_cross_fitted_probabilities

        def cross_only_failure(model_kind, fold, *args, **kwargs):
            if str(fold.fold_id).startswith("cross-"):
                raise TRAIN.FoldClassError("deterministic cross source failure")
            return original_inner(model_kind, fold, *args, **kwargs)

        with mock.patch.object(
            TRAIN,
            "_inner_cross_fitted_probabilities",
            side_effect=cross_only_failure,
        ):
            TRAIN.run_evaluation(
                snapshot=snapshot,
                output_dir=output,
                model_kinds=("heuristic_original_core_v1",),
                config=TRAIN.EvaluationConfig(seed=60),
                allow_official_weight_download=False,
            )
        report = json.loads(
            (output / "evaluation-report.json").read_text(encoding="utf-8")
        )
        records = report["crossPackEvaluation"]["models"][0]["directions"]
        self.assertTrue(
            all(
                record["sourceThresholdSelection"]["status"]
                == "noSourceThresholdAvailable"
                and record["sourceThresholdSelectionSafeProbabilities"] is None
                and record["sourceInnerWorkDisjointFolds"] == []
                for record in records
            )
        )
        for name, mutate in {
            "confirmatory": lambda record: record.update({"confirmatory": True}),
            "target-labels": lambda record: record.update({"targetLabelsUsed": True}),
            "threshold-role": lambda record: record.update(
                {"thresholdRole": "tampered"}
            ),
            "empty-reason": lambda record: record.update({"reason": ""}),
        }.items():
            with self.subTest(field=name):
                tampered_output = self.root / f"strict cross no source {name}"
                shutil.copytree(output, tampered_output)
                report_path = tampered_output / "evaluation-report.json"
                tampered_report = json.loads(report_path.read_text(encoding="utf-8"))
                selection = tampered_report["crossPackEvaluation"]["models"][0][
                    "directions"
                ][0]["sourceThresholdSelection"]
                mutate(selection)
                write_json(report_path, tampered_report)
                rewrite_manifest_and_seal(tampered_output)
                with self.assertRaises(TRAIN.BubbleFitTrainingError, msg=name):
                    TRAIN.validate_output_artifacts(
                        tampered_output, expected_snapshot=snapshot
                    )

    def test_v6_resealed_report_evidence_and_metric_tamper_fails_closed(
        self,
    ) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        base = self.root / "strict report base"
        TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=base,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=61),
            allow_official_weight_download=False,
        )

        def threshold_evidence(report):
            values = report["models"][0]["folds"][0][
                "thresholdSelectionSafeProbabilities"
            ]
            values[:] = [0.123456] * len(values)

        def outer_metric(report):
            report["models"][0]["outerOofMetrics"]["candidateCount"] += 1

        def work_metric(report):
            report["models"][0]["workMacroMetrics"]["perWork"][0]["candidateCount"] += 1

        def confidence_metric(report):
            report["models"][0]["confidenceMetrics"]["primaryHighConfidence"][
                "candidateCount"
            ] += 1

        def subtype_metric(report):
            subtype = next(iter(report["models"][0]["unsafeSubtypeFalseAcceptMetrics"]))
            report["models"][0]["unsafeSubtypeFalseAcceptMetrics"][subtype][
                "candidateCount"
            ] += 1

        def threshold_free_metric(report):
            report["models"][0]["thresholdFreeCombinedOofMetrics"]["candidateLevel"][
                "brierScore"
            ] += 0.01

        def ranking(report):
            report["modelRankingExploratoryTargetFirst"] = []

        def cross_metric(report):
            direction = report["crossPackEvaluation"]["models"][0]["directions"][0]
            direction["targetThresholdFreeMetrics"]["brierScore"] += 0.01

        def cross_threshold_evidence(report):
            direction = report["crossPackEvaluation"]["models"][0]["directions"][0]
            values = direction["sourceThresholdSelectionSafeProbabilities"]
            values[:] = [0.123456] * len(values)

        def prediction_evidence_contract(report):
            report["neuralPredictionReexecution"] = True

        def safety_evidence(report):
            report["safetyEvidenceLimits"]["unsafeCandidateCount"] += 1

        def promotion_block_reason(report):
            report["promotionBlockReason"] += " tampered"

        def current_run_role(report):
            report["currentRunRole"] = "tampered"

        def determinism(report):
            report["determinism"]["seed"] += 1

        def versions(report):
            report["versions"]["numpy"] = "tampered"

        mutations = {
            "threshold-evidence": threshold_evidence,
            "outer-metric": outer_metric,
            "work-metric": work_metric,
            "confidence-metric": confidence_metric,
            "subtype-metric": subtype_metric,
            "threshold-free-metric": threshold_free_metric,
            "ranking": ranking,
            "cross-metric": cross_metric,
            "cross-threshold-evidence": cross_threshold_evidence,
            "prediction-evidence-contract": prediction_evidence_contract,
            "safety-evidence": safety_evidence,
            "promotion-block-reason": promotion_block_reason,
            "current-run-role": current_run_role,
            "determinism": determinism,
            "versions": versions,
        }
        for name, mutate in mutations.items():
            with self.subTest(field=name):
                output = self.root / f"strict report {name}"
                shutil.copytree(base, output)
                report_path = output / "evaluation-report.json"
                report = json.loads(report_path.read_text(encoding="utf-8"))
                mutate(report)
                write_json(report_path, report)
                rewrite_manifest_and_seal(output)
                with self.assertRaises(TRAIN.BubbleFitTrainingError, msg=name):
                    TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_v6_resealed_split_plan_semantic_tamper_fails_closed(self) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        base = self.root / "strict split base"
        TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=base,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=63),
            allow_official_weight_download=False,
        )

        def strategy(split):
            split["strategy"] = "tampered"

        def train_counts(split):
            split["folds"][0]["trainClassCounts"]["safe"] += 1

        def holdout_counts(split):
            split["folds"][0]["holdoutClassCounts"]["unsafe"] += 1

        def class_issues(split):
            current = split["folds"][0]["classIssues"]
            split["folds"][0]["classIssues"] = (
                []
                if current
                else ["holdout_has_single_class_metrics_partially_undefined"]
            )

        for name, mutate in {
            "strategy": strategy,
            "train-counts": train_counts,
            "holdout-counts": holdout_counts,
            "class-issues": class_issues,
        }.items():
            with self.subTest(field=name):
                output = self.root / f"strict split {name}"
                shutil.copytree(base, output)
                split_path = output / "split-plan.json"
                split = json.loads(split_path.read_text(encoding="utf-8"))
                mutate(split)
                split["splitBindingSha256"] = TRAIN._sha256_json(split["folds"])
                write_json(split_path, split)
                coherently_rebind_split_plan(output)
                with self.assertRaises(TRAIN.BubbleFitTrainingError, msg=name):
                    TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_five_class_cross_pack_missing_source_class_is_unsupported_only(
        self,
    ) -> None:
        snapshot = self.make_five_class_pack_set()
        plan = TRAIN.build_cross_pack_plan(snapshot)
        inputs = np.zeros((len(snapshot.samples), 4, 224, 224), dtype=np.float32)
        labels = np.asarray(
            [sample.safe for sample in snapshot.samples], dtype=np.int64
        )

        def inner_probabilities(
            _model_kind,
            fold,
            samples,
            _inputs,
            labels,
            _config,
            _weight_bundle,
        ):
            records = []
            works = sorted({samples[index].work_id for index in fold.train_indices})
            for inner_index, holdout_work in enumerate(works, start=1):
                validation = tuple(
                    index
                    for index in fold.train_indices
                    if samples[index].work_id == holdout_work
                )
                training = tuple(
                    index
                    for index in fold.train_indices
                    if samples[index].work_id != holdout_work
                )
                records.append(
                    {
                        "innerFoldId": (f"{fold.fold_id}-threshold-{inner_index:02d}"),
                        "trainWorkIds": sorted(
                            {samples[index].work_id for index in training}
                        ),
                        "validationWorkIds": [holdout_work],
                        "trainCandidateIdsSha256": TRAIN._sha256_json(
                            [samples[index].candidate_id for index in training]
                        ),
                        "validationCandidateIdsSha256": TRAIN._sha256_json(
                            [samples[index].candidate_id for index in validation]
                        ),
                        "trainClassCounts": TRAIN._class_counts(training, labels),
                        "validationClassCounts": TRAIN._class_counts(
                            validation, labels
                        ),
                        "fit": {"status": "deterministic-inner-test-fit"},
                    }
                )
            return np.linspace(0.1, 0.9, len(fold.train_indices)), records

        def five_class_fit_predict(
            _model_kind,
            _train_indices,
            predict_indices,
            _inputs,
            _labels,
            _config,
            _weight_bundle,
            _seed,
            _class_targets=None,
        ):
            probabilities = np.tile(
                np.asarray([0.6, 0.1, 0.1, 0.1, 0.1], dtype=np.float64),
                (len(predict_indices), 1),
            )
            return probabilities[:, 0], {
                "status": "deterministic-five-class-test-fit",
                "_classProbabilities": probabilities,
            }

        with (
            mock.patch.object(
                TRAIN,
                "_inner_cross_fitted_probabilities",
                side_effect=inner_probabilities,
            ),
            mock.patch.object(
                TRAIN, "_fit_predict_split", side_effect=five_class_fit_predict
            ),
        ):
            report, rows = TRAIN.evaluate_cross_pack_directions(
                snapshot=snapshot,
                plan=plan,
                model_kinds=(TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND,),
                inputs=inputs,
                labels=labels,
                config=TRAIN.EvaluationConfig(seed=71),
                weight_bundle=TRAIN.MobileNetWeightBundle(
                    state_dict={}, provenance={"fixture": True}
                ),
            )

        directions = {
            row["directionId"]: row for row in report["models"][0]["directions"]
        }
        old_to_new = directions["old_to_new"]
        self.assertEqual(old_to_new["status"], "unsupported_missing_training_classes")
        self.assertEqual(old_to_new["missingTrainingClasses"], ["unsafe_translucent"])
        self.assertEqual(old_to_new["predictionCount"], 0)
        self.assertIsNone(old_to_new["targetThresholdFreeMetrics"])
        self.assertFalse(old_to_new["targetLabelsUsedForMetricsOnly"])
        self.assertFalse(any(row["directionId"] == "old_to_new" for row in rows))

        new_to_old = directions["new_to_old"]
        self.assertEqual(new_to_old["status"], "evaluated")
        self.assertTrue(new_to_old["supported"])
        self.assertEqual(new_to_old["targetLabelClassCounts"]["unsafe_translucent"], 0)
        translucent = new_to_old["targetMulticlassMetrics"]["perClass"][
            "unsafe_translucent"
        ]
        self.assertEqual(translucent["candidateCount"], 0)
        self.assertIsNone(translucent["oneVsRestRocAuc"])
        self.assertIsNone(translucent["oneVsRestAveragePrecision"])
        supported_rows = [row for row in rows if row["directionId"] == "new_to_old"]
        self.assertEqual(len(supported_rows), 6)
        self.assertTrue(
            all(
                row["safeProbability"] == row["classProbabilities"]["safe_opaque"]
                for row in supported_rows
            )
        )

    def test_five_class_pack_set_outputs_pass_strict_validator(self) -> None:
        snapshot = self.make_five_class_pack_set()
        output = self.root / "five class strict output"

        def inner_probabilities(
            _model_kind,
            fold,
            samples,
            _inputs,
            labels,
            _config,
            _weight_bundle,
        ):
            records = []
            works = sorted({samples[index].work_id for index in fold.train_indices})
            for inner_index, holdout_work in enumerate(works, start=1):
                validation = tuple(
                    index
                    for index in fold.train_indices
                    if samples[index].work_id == holdout_work
                )
                training = tuple(
                    index
                    for index in fold.train_indices
                    if samples[index].work_id != holdout_work
                )
                records.append(
                    {
                        "innerFoldId": (f"{fold.fold_id}-threshold-{inner_index:02d}"),
                        "trainWorkIds": sorted(
                            {samples[index].work_id for index in training}
                        ),
                        "validationWorkIds": [holdout_work],
                        "trainCandidateIdsSha256": TRAIN._sha256_json(
                            [samples[index].candidate_id for index in training]
                        ),
                        "validationCandidateIdsSha256": TRAIN._sha256_json(
                            [samples[index].candidate_id for index in validation]
                        ),
                        "trainClassCounts": TRAIN._class_counts(training, labels),
                        "validationClassCounts": TRAIN._class_counts(
                            validation, labels
                        ),
                        "fit": {"status": "deterministic-inner-test-fit"},
                    }
                )
            return np.linspace(0.1, 0.9, len(fold.train_indices)), records

        def five_class_fit_predict(
            _model_kind,
            _train_indices,
            predict_indices,
            _inputs,
            _labels,
            _config,
            _weight_bundle,
            _seed,
            _class_targets=None,
        ):
            templates = np.asarray(
                [
                    [0.60, 0.10, 0.10, 0.10, 0.10],
                    [0.10, 0.60, 0.10, 0.10, 0.10],
                    [0.10, 0.10, 0.60, 0.10, 0.10],
                    [0.10, 0.10, 0.10, 0.60, 0.10],
                    [0.10, 0.10, 0.10, 0.10, 0.60],
                ],
                dtype=np.float64,
            )
            probabilities = np.stack(
                [templates[int(index) % len(templates)] for index in predict_indices]
            )
            return probabilities[:, 0], {
                "status": "deterministic-five-class-test-fit",
                "_classProbabilities": probabilities,
            }

        fake_bundle = TRAIN.MobileNetWeightBundle(
            state_dict={}, provenance={"fixture": True}
        )
        with (
            mock.patch.object(
                TRAIN,
                "load_official_mobilenet_weights",
                return_value=fake_bundle,
            ),
            mock.patch.object(
                TRAIN,
                "_inner_cross_fitted_probabilities",
                side_effect=inner_probabilities,
            ),
            mock.patch.object(
                TRAIN, "_fit_predict_split", side_effect=five_class_fit_predict
            ),
        ):
            result = TRAIN.run_evaluation(
                snapshot=snapshot,
                output_dir=output,
                model_kinds=(TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND,),
                config=TRAIN.EvaluationConfig(seed=79),
                allow_official_weight_download=False,
            )

        self.assertTrue(result["artifactValidation"]["ok"])
        self.assertTrue(
            TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)["ok"]
        )
        report = json.loads(
            (output / "evaluation-report.json").read_text(encoding="utf-8")
        )
        self.assertIn("multiclassOofMetrics", report["models"][0])
        directions = {
            row["directionId"]: row
            for row in report["crossPackEvaluation"]["models"][0]["directions"]
        }
        self.assertEqual(
            directions["old_to_new"]["status"],
            "unsupported_missing_training_classes",
        )
        self.assertEqual(directions["new_to_old"]["status"], "evaluated")
        rows = [
            json.loads(line)
            for line in (output / "oof-predictions.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertTrue(all("classProbabilities" in row for row in rows))

        rows[0]["classProbabilities"]["safe_opaque"] -= 0.05
        rows[0]["classProbabilities"]["unsafe_translucent"] += 0.05
        oof_path = output / "oof-predictions.jsonl"
        oof_path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                for row in rows
            ),
            encoding="utf-8",
        )
        new_oof_sha = sha256_file(oof_path)
        report_path = output / "evaluation-report.json"
        manifest_path = output / "artifact-manifest.json"
        seal_path = output / "artifact-seal.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
        bindings = copy.deepcopy(report["authorityBindings"])
        bindings["oofPredictionsSha256"] = new_oof_sha
        unbound = dict(bindings)
        unbound.pop("bindingSha256")
        bindings["bindingSha256"] = TRAIN._sha256_json(unbound)
        report["oofPredictionsSha256"] = new_oof_sha
        for payload in (report, manifest, seal):
            payload["authorityBindings"] = bindings
            for key in TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS:
                payload[key] = bindings[key]
        write_json(report_path, report)
        rewrite_manifest_and_seal(output, manifest=manifest, seal=seal)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "five-class OOF probability semantics are invalid",
        ):
            TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_coherently_resealed_cross_pack_overlap_tamper_is_rejected(self) -> None:
        snapshot, _pack_set_path, _old, _new = self.make_pack_set()
        output = self.root / "cross-pack tamper"
        TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=output,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=67),
            allow_official_weight_download=False,
        )
        predictions_path = output / "cross-pack-predictions.jsonl"
        rows = [
            json.loads(line)
            for line in predictions_path.read_text(encoding="utf-8").splitlines()
        ]
        rows[0]["workId"] = "shared-a"
        predictions_path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                for row in rows
            ),
            encoding="utf-8",
        )
        new_predictions_sha = sha256_file(predictions_path)
        report_path = output / "evaluation-report.json"
        manifest_path = output / "artifact-manifest.json"
        seal_path = output / "artifact-seal.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
        bindings = copy.deepcopy(report["authorityBindings"])
        bindings["crossPackPredictionsSha256"] = new_predictions_sha
        unbound = dict(bindings)
        unbound.pop("bindingSha256")
        bindings["bindingSha256"] = TRAIN._sha256_json(unbound)
        report["crossPackPredictionsSha256"] = new_predictions_sha
        for payload in (report, manifest, seal):
            payload["authorityBindings"] = bindings
            for key in TRAIN.PACK_SET_AUTHORITY_DIRECT_KEYS:
                payload[key] = bindings[key]
        write_json(report_path, report)
        rewrite_manifest_and_seal(output, manifest=manifest, seal=seal)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "cross-pack prediction source/partition binding is invalid",
        ):
            TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_pack_set_v2_coherently_resealed_overlap_plan_tamper_is_rejected(
        self,
    ) -> None:
        snapshot, _pack_set_path, _first, _second, _incremental = (
            self.make_pack_set_v2()
        )
        base = self.root / "pack-set v2 ordered plan tamper base"
        TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=base,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=97),
            allow_official_weight_download=False,
        )
        for name in ("overlap-order", "train-pack-order"):
            with self.subTest(canonical_order=name):
                output = self.root / f"pack-set v2 plan tamper {name}"
                shutil.copytree(base, output)
                plan_path = output / "cross-pack-plan.json"
                plan = json.loads(plan_path.read_text(encoding="utf-8"))
                direction = plan["directions"][0]
                self.assertIn("trainPackIds", direction)
                if name == "overlap-order":
                    reversed_overlap = list(
                        reversed(direction["excludedOverlapWorkIds"])
                    )
                    self.assertNotEqual(
                        reversed_overlap, direction["excludedOverlapWorkIds"]
                    )
                    direction["excludedOverlapWorkIds"] = reversed_overlap
                    direction["excludedOverlapWorkIdsSha256"] = TRAIN._sha256_json(
                        reversed_overlap
                    )
                    plan["externalEvaluationView"]["overlapSourceWorkIdsSha256"] = (
                        TRAIN._sha256_json(reversed_overlap)
                    )
                else:
                    reversed_pack_ids = list(reversed(direction["trainPackIds"]))
                    self.assertNotEqual(reversed_pack_ids, direction["trainPackIds"])
                    direction["trainPackIds"] = reversed_pack_ids
                    plan["externalEvaluationView"]["existingPackIds"] = (
                        reversed_pack_ids
                    )
                unbound = dict(plan)
                unbound.pop("planBindingSha256")
                plan["planBindingSha256"] = TRAIN._sha256_json(unbound)
                write_json(plan_path, plan)
                coherently_rebind_cross_plan(output)

                with self.assertRaisesRegex(
                    TRAIN.BubbleFitTrainingError,
                    "cross-pack plan differs from the revalidated pack-set",
                ):
                    TRAIN.validate_output_artifacts(output, expected_snapshot=snapshot)

    def test_authority_seal_is_path_free_strict_and_canonically_reproducible(
        self,
    ) -> None:
        snapshot = self.fixture.load()
        frozen_authority = TRAIN.execution_authority(requires_mobile=False)
        outputs = [self.root / "canonical a", self.root / "canonical b"]
        with mock.patch.object(
            TRAIN, "execution_authority", return_value=frozen_authority
        ):
            for output in outputs:
                TRAIN.run_evaluation(
                    snapshot=snapshot,
                    output_dir=output,
                    model_kinds=("heuristic_original_core_v1",),
                    config=TRAIN.EvaluationConfig(seed=31),
                    allow_official_weight_download=False,
                )
        first = {
            path.relative_to(outputs[0]).as_posix(): path.read_bytes()
            for path in outputs[0].rglob("*")
            if path.is_file()
        }
        second = {
            path.relative_to(outputs[1]).as_posix(): path.read_bytes()
            for path in outputs[1].rglob("*")
            if path.is_file()
        }
        self.assertEqual(first, second)
        validation = TRAIN.validate_output_artifacts(outputs[0])
        self.assertTrue(validation["ok"])
        seal = json.loads(
            (outputs[0] / "artifact-seal.json").read_text(encoding="utf-8")
        )
        bindings = seal["authorityBindings"]
        for key in TRAIN.AUTHORITY_DIRECT_KEYS:
            self.assertEqual(seal[key], bindings[key])
        authority_text = json.dumps(
            seal["executionAuthority"], ensure_ascii=False, sort_keys=True
        )
        self.assertNotIn(str(self.root), authority_text)
        self.assertNotIn(str(self.fixture.dataset_dir), authority_text)

        (outputs[0] / "unsealed-extra.bin").write_bytes(b"extra")
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "unsealed extra files"
        ):
            TRAIN.validate_output_artifacts(outputs[0])
        report_path = outputs[1] / "evaluation-report.json"
        manifest_path = outputs[1] / "artifact-manifest.json"
        seal_path = outputs[1] / "artifact-seal.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
        tampered_contract = copy.deepcopy(report["confirmatoryAuditContract"])
        tampered_contract["sealedEligibilityLedgerPresent"] = True
        tampered_contract["eligibleUntouchedWorkClusterCount"] = 38
        tampered_contract["eligibleUntouchedWorkClusterShortfallForFivePercent"] = 21
        bindings = copy.deepcopy(report["authorityBindings"])
        bindings["confirmatoryAuditContractCanonicalSha256"] = TRAIN._sha256_json(
            tampered_contract
        )
        bindings_without_sha = dict(bindings)
        bindings_without_sha.pop("bindingSha256")
        bindings["bindingSha256"] = TRAIN._sha256_json(bindings_without_sha)
        for payload in (report, manifest, seal):
            payload["confirmatoryAuditContract"] = tampered_contract
            payload["authorityBindings"] = bindings
        for key in TRAIN.AUTHORITY_DIRECT_KEYS:
            seal[key] = bindings[key]
        write_json(report_path, report)
        rewrite_manifest_and_seal(outputs[1], manifest=manifest, seal=seal)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "confirmatory audit contract is not canonical"
        ):
            TRAIN.validate_output_artifacts(outputs[1])

    def test_candidate_diagnostic_refuses_small_reject_all_threshold(self) -> None:
        self.assertAlmostEqual(
            TRAIN.one_sided_binomial_upper_bound(0, 22),
            0.1273054316548387,
        )
        labels = np.asarray([1] * 6 + [0] * 22, dtype=np.int64)
        probabilities = np.asarray([0.99] * 6 + [0.01] * 22, dtype=np.float64)
        threshold, record = TRAIN.select_safety_threshold(
            labels,
            probabilities,
            unsafe_false_accept_target=0.05,
        )
        self.assertIsNone(threshold)
        self.assertEqual(record["status"], "noInnerThresholdAvailable")
        self.assertFalse(record["innerThresholdAvailable"])
        self.assertFalse(record["candidateIndependenceAsserted"])
        self.assertFalse(record["confirmatory"])
        self.assertIsNone(record["selectedMetrics"])

        larger_labels = np.asarray([1] * 10 + [0] * 100, dtype=np.int64)
        larger_probabilities = np.asarray([0.99] * 10 + [0.01] * 100, dtype=np.float64)
        threshold, record = TRAIN.select_safety_threshold(
            larger_labels,
            larger_probabilities,
            unsafe_false_accept_target=0.05,
        )
        self.assertIsNotNone(threshold)
        self.assertLess(float(threshold), 1.0)
        self.assertEqual(record["status"], "innerThresholdAvailable")
        self.assertLessEqual(
            record["selectedMetrics"]["candidateLevelDiagnosticUpper95"], 0.05
        )
        self.assertGreater(record["selectedMetrics"]["counts"]["trueSafeAccepted"], 0)

    def test_coherently_resealed_oof_promotion_tamper_is_rejected(self) -> None:
        snapshot = self.fixture.load()
        output = self.root / "oof safety tamper"
        TRAIN.run_evaluation(
            snapshot=snapshot,
            output_dir=output,
            model_kinds=("heuristic_original_core_v1",),
            config=TRAIN.EvaluationConfig(seed=43),
            allow_official_weight_download=False,
        )
        oof_path = output / "oof-predictions.jsonl"
        rows = [
            json.loads(line)
            for line in oof_path.read_text(encoding="utf-8").splitlines()
        ]
        rows[0]["promotionEligible"] = True
        oof_path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                for row in rows
            ),
            encoding="utf-8",
        )
        new_oof_sha = sha256_file(oof_path)
        report_path = output / "evaluation-report.json"
        manifest_path = output / "artifact-manifest.json"
        seal_path = output / "artifact-seal.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
        bindings = copy.deepcopy(report["authorityBindings"])
        bindings["oofPredictionsSha256"] = new_oof_sha
        unbound = dict(bindings)
        unbound.pop("bindingSha256")
        bindings["bindingSha256"] = TRAIN._sha256_json(unbound)
        report["oofPredictionsSha256"] = new_oof_sha
        for payload in (report, manifest, seal):
            payload["authorityBindings"] = bindings
        for key in TRAIN.AUTHORITY_DIRECT_KEYS:
            seal[key] = bindings[key]
        write_json(report_path, report)
        rewrite_manifest_and_seal(output, manifest=manifest, seal=seal)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "OOF prediction 1 common non-promotable contract is invalid",
        ):
            TRAIN.validate_output_artifacts(output)

    def test_python_producer_authority_binds_runtime_records_and_mobile_stack(
        self,
    ) -> None:
        base = TRAIN.execution_authority(requires_mobile=False)
        self.assertIn("rendererDependencyLock", base)
        self.assertNotIn("dependencyLock", base)
        self.assertEqual(
            base["pythonRuntime"]["implementationCacheTag"],
            sys.implementation.cache_tag,
        )
        self.assertIn("extensionSuffix", base["pythonRuntime"])
        self.assertIn("sysconfigPlatform", base["pythonRuntime"])
        base_names = {
            row["normalizedName"]
            for row in base["pythonProducerDistributions"]["distributions"]
        }
        self.assertEqual(base_names, {"numpy", "pillow"})
        for row in base["pythonProducerDistributions"]["distributions"]:
            record = row["record"]
            self.assertRegex(record["sha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(record["canonicalEntryInventorySha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(record["entryCount"], 0)

        mobile = TRAIN.execution_authority(requires_mobile=True)
        mobile_names = {
            row["normalizedName"]
            for row in mobile["pythonProducerDistributions"]["distributions"]
        }
        self.assertTrue(
            {"torch", "torchvision", "onnx", "onnxruntime"}.issubset(mobile_names)
        )
        self.assertTrue(
            mobile["pythonProducerDistributions"]["mobileProducerDependenciesRequired"]
        )
        TRAIN._assert_no_absolute_paths(mobile)

    def test_work_cluster_confirmatory_feasibility_requires_59_clusters(self) -> None:
        upper_38 = TRAIN.one_sided_binomial_upper_bound(0, 38)
        self.assertAlmostEqual(upper_38, 0.07580765168296455)
        self.assertGreater(upper_38, 0.05)
        self.assertEqual(TRAIN.minimum_zero_failure_work_clusters(0.05), 59)
        self.assertGreater(TRAIN.one_sided_binomial_upper_bound(0, 58), 0.05)
        self.assertLessEqual(TRAIN.one_sided_binomial_upper_bound(0, 59), 0.05)
        contract = TRAIN.confirmatory_audit_contract(
            current_source_work_count=10, target=0.05
        )
        self.assertEqual(contract["referenceLibraryInventoryWorkCount"], 38)
        self.assertIsNone(contract["eligibleUntouchedWorkClusterCount"])
        self.assertIsNone(
            contract["eligibleUntouchedWorkClusterShortfallForFivePercent"]
        )
        theoretical = contract[
            "theoreticalBestCaseAssumingEveryInventoryWorkIsEligibleUntouchedAndHasZeroFailures"
        ]
        self.assertEqual(theoretical["referenceLibraryInventoryWorkCount"], 38)
        self.assertEqual(theoretical["minimumZeroFailureWorkClusters"], 59)
        self.assertFalse(theoretical["assumptionIsEstablished"])
        self.assertFalse(contract["currentRunIsLockedConfirmatoryAudit"])
        self.assertFalse(contract["candidateIidInferenceAuthorized"])
        self.assertFalse(contract["promotionEligible"])

    def test_outer_exploratory_target_requires_every_check(self) -> None:
        config = TRAIN.EvaluationConfig(
            unsafe_false_accept_target=0.05,
            minimum_coverage=0.1,
            minimum_accepted_safe=2,
        )
        metrics = {
            "candidateLevelDiagnosticUpper95": 0.04,
            "coverage": 0.2,
            "counts": {"trueSafeAccepted": 2},
        }
        checks, met = TRAIN._outer_exploratory_target_checks(
            metrics, all_outer_decisions_available=True, config=config
        )
        self.assertTrue(met)
        self.assertTrue(
            all(
                checks[key]
                for key in (
                    "allOuterDecisionsAvailable",
                    "candidateLevelDiagnosticUpper95AtOrBelowTarget",
                    "minimumCoverageMet",
                    "minimumAcceptedSafeMet",
                )
            )
        )
        for mutation in (
            {"all_outer_decisions_available": False},
            {"candidateLevelDiagnosticUpper95": 0.06},
            {"coverage": 0.09},
            {"counts": {"trueSafeAccepted": 1}},
        ):
            candidate = dict(metrics)
            decisions = mutation.pop("all_outer_decisions_available", True)
            candidate.update(mutation)
            _checks, candidate_met = TRAIN._outer_exploratory_target_checks(
                candidate,
                all_outer_decisions_available=decisions,
                config=config,
            )
            self.assertFalse(candidate_met)

    def test_ranking_places_outer_exploratory_target_met_models_first(self) -> None:
        def record(name: str, target_met: bool) -> dict[str, Any]:
            return {
                "modelKind": name,
                "outerOofMetrics": {
                    "outerExploratoryTargetMet": target_met,
                    "candidateLevelDiagnosticUpper95": 0.9 if target_met else 0.0,
                    "safePrecision": 1.0,
                    "safeRecall": 1.0,
                    "coverage": 1.0,
                },
            }

        self.assertEqual(
            TRAIN.rank_model_records(
                [record("no-threshold", False), record("target-met", True)]
            ),
            ["target-met", "no-threshold"],
        )

    def test_v6_ranking_uses_evidence_not_filename_for_no_decision_models(
        self,
    ) -> None:
        def record(name: str, auc: float) -> dict[str, Any]:
            return {
                "modelKind": name,
                "outerOofMetrics": {
                    "outerExploratoryTargetMet": False,
                    "evaluatedCandidateCount": 0,
                    "candidateLevelDiagnosticUpper95": None,
                    "safePrecision": None,
                    "safeRecall": None,
                    "coverage": None,
                },
                "thresholdFreeCombinedOofMetrics": {
                    "candidateLevel": {
                        "rocAuc": auc,
                        "averagePrecision": auc,
                    },
                    "workMacroRocAuc": {"rocAuc": auc},
                },
            }

        high = record("zzz-high-evidence", 0.8)
        low = record("aaa-low-evidence", 0.6)
        self.assertEqual(
            TRAIN.rank_model_records(
                [low, high], schema_version=TRAIN.PACK_SET_OUTPUT_SCHEMA_VERSION
            ),
            ["zzz-high-evidence", "aaa-low-evidence"],
        )
        tied_late = record("aaa-tied", 0.8)
        self.assertEqual(
            TRAIN.rank_model_records(
                [high, tied_late],
                schema_version=TRAIN.PACK_SET_OUTPUT_SCHEMA_VERSION,
            ),
            ["zzz-high-evidence", "aaa-tied"],
        )

    def test_confidence_primary_and_unsafe_subtype_metrics_are_explicit(self) -> None:
        snapshot = self.fixture.load()
        samples = list(snapshot.samples)
        unsafe_index = next(
            index for index, sample in enumerate(samples) if not sample.safe
        )
        samples[unsafe_index] = dataclasses.replace(
            samples[unsafe_index], confidence="medium"
        )
        labels = np.asarray([sample.safe for sample in samples], dtype=np.int64)
        predicted = labels.astype(bool)
        predicted[unsafe_index] = True
        available = np.ones(len(samples), dtype=bool)
        confidence, subtypes = TRAIN._confidence_and_subtype_metrics(
            samples, labels, predicted, available
        )
        self.assertEqual(confidence["primaryHighConfidence"]["candidateCount"], 3)
        self.assertEqual(confidence["sensitivityIncludingMedium"]["candidateCount"], 4)
        subtype = samples[unsafe_index].label
        self.assertEqual(subtypes[subtype]["falseAccepts"], 1)
        self.assertIsNotNone(subtypes[subtype]["candidateLevelDiagnosticUpper95"])

    def test_threshold_free_combined_metrics_include_work_macro_auc(self) -> None:
        samples = [
            TRAIN._ValidationMetricSample("work-a", "safe_opaque", "high"),
            TRAIN._ValidationMetricSample("work-a", "unsafe_translucent", "high"),
            TRAIN._ValidationMetricSample("work-b", "safe_opaque", "high"),
            TRAIN._ValidationMetricSample("work-b", "unsafe_open_or_illusory", "high"),
        ]
        metrics = TRAIN._combined_oof_threshold_free_metrics(
            samples,
            np.asarray([1, 0, 1, 0], dtype=np.int64),
            np.asarray([0.9, 0.1, 0.4, 0.6], dtype=np.float64),
        )
        self.assertAlmostEqual(metrics["candidateLevel"]["rocAuc"], 0.75)
        self.assertAlmostEqual(metrics["candidateLevel"]["averagePrecision"], 5.0 / 6.0)
        self.assertAlmostEqual(metrics["workMacroRocAuc"]["rocAuc"], 0.5)
        self.assertEqual(metrics["workMacroRocAuc"]["definedWorkCount"], 2)
        self.assertFalse(metrics["promotionAuthority"])

    def test_tampered_official_weight_cache_fails_before_deserialization(self) -> None:
        fake_hub = self.root / "fake torch hub"
        checkpoint = fake_hub / "checkpoints" / "mobilenet_v3_small-047dcff4.pth"
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint.write_bytes(b"shape-compatible provenance must still be pinned")
        with mock.patch("torch.hub.get_dir", return_value=str(fake_hub)):
            with self.assertRaisesRegex(
                TRAIN.BubbleFitTrainingError, "byte-size mismatch"
            ):
                TRAIN.load_official_mobilenet_weights(allow_download=False)
        checkpoint.write_bytes(b"x" * TRAIN.MOBILENET_V3_SMALL_IMAGENET1K_V1_SIZE_BYTES)
        with mock.patch("torch.hub.get_dir", return_value=str(fake_hub)):
            with self.assertRaisesRegex(
                TRAIN.BubbleFitTrainingError, "SHA-256 mismatch"
            ):
                TRAIN.load_official_mobilenet_weights(allow_download=False)

    def test_mobilenet_and_exported_onnx_require_four_channel_contract(self) -> None:
        import onnx
        from torch import nn

        model = TRAIN.build_mobilenet_v3_small_gate(
            mode="mobilenet_v3_small_frozen_head",
            seed=7,
            pretrained_state_dict=None,
        )
        self.assertEqual(model.features[0][0].in_channels, 4)
        self.assertEqual(model.classifier[-1].out_features, 1)

        linear_binary = TRAIN.build_mobilenet_v3_small_gate(
            mode=TRAIN.LINEAR_BINARY_MODEL_KIND,
            seed=7,
            pretrained_state_dict=None,
        )
        self.assertEqual(linear_binary.classifier[-1].out_features, 1)
        self.assertEqual(
            sum(
                parameter.numel()
                for parameter in linear_binary.parameters()
                if parameter.requires_grad
            ),
            1_025,
        )
        self.assertEqual(
            [
                name
                for name, parameter in linear_binary.named_parameters()
                if parameter.requires_grad
            ],
            ["classifier.3.weight", "classifier.3.bias"],
        )

        linear_five_class = TRAIN.build_mobilenet_v3_small_gate(
            mode=TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND,
            seed=7,
            pretrained_state_dict=None,
        )
        self.assertEqual(linear_five_class.classifier[-1].out_features, 5)
        self.assertEqual(
            sum(
                parameter.numel()
                for parameter in linear_five_class.parameters()
                if parameter.requires_grad
            ),
            5_125,
        )
        self.assertEqual(
            [
                name
                for name, parameter in linear_five_class.named_parameters()
                if parameter.requires_grad
            ],
            ["classifier.3.weight", "classifier.3.bias"],
        )
        self.assertEqual(
            TRAIN.model_definition(TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND)[
                "outputSemantics"
            ]["classOrder"],
            list(TRAIN.ALLOWED_LABELS),
        )
        self.assertEqual(
            TRAIN.model_definition(TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND)[
                "trainingObjective"
            ]["classWeights"],
            {
                "safe_opaque": 1.0,
                "unsafe_translucent": 2.5,
                "unsafe_open_or_illusory": 2.5,
                "unsafe_mask_leak_or_clip": 2.5,
                "unsafe_merged_or_wrong_region": 2.5,
            },
        )
        self.assertEqual(
            TRAIN.model_definition("mobilenet_v3_small_frozen_head"),
            {
                "architecture": "torchvision.models.mobilenet_v3_small",
                "inputChannels": 4,
                "firstConvolutionInitialization": {
                    "rgbChannels": "official ImageNet weight copy",
                    "candidateCoreMaskChannel": ("mean of three official RGB kernels"),
                },
                "classifier": (
                    "stock MobileNetV3-Small classifier with final Linear "
                    "replaced by one safe logit"
                ),
                "trainableScope": "classifier only",
                "pixelSources": ["originalNative", "candidateCoreMask"],
                "cleanedPixelsUsed": False,
            },
        )

        class TinyGate(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.conv = nn.Conv2d(4, 1, kernel_size=1)

            def forward(self, value):
                return self.conv(value).mean(dim=(2, 3))

        onnx_path = self.root / "tiny-gate.onnx"
        contract = TRAIN.export_onnx_candidate(TinyGate(), onnx_path)
        self.assertEqual(contract["inputShape"], ["batch", 4, 224, 224])
        self.assertEqual(contract["outputShape"], ["batch", 1])
        self.assertEqual(contract["outputName"], "safe_probability")
        self.assertEqual(contract["outputSemantics"], "sigmoid_safe_probability")
        self.assertTrue(contract["numericalParity"]["passed"])
        self.assertEqual(contract["metadata"]["cleanedPixelsUsed"], "false")
        self.assertEqual(contract["metadata"], TRAIN.ONNX_METADATA)

        linear_onnx_path = self.root / "linear-binary-gate.onnx"
        linear_contract = TRAIN.export_onnx_candidate(linear_binary, linear_onnx_path)
        self.assertTrue(linear_contract["numericalParity"]["passed"])
        self.assertEqual(linear_contract["outputName"], "safe_probability")
        self.assertEqual(linear_contract["outputSemantics"], "sigmoid_safe_probability")
        graph = onnx.load(onnx_path)
        graph.graph.input[0].type.tensor_type.shape.dim[1].dim_value = 3
        bad_path = self.root / "bad-three-channel.onnx"
        onnx.save(graph, bad_path)
        with self.assertRaisesRegex(TRAIN.BubbleFitTrainingError, "4,224,224"):
            TRAIN.assert_onnx_input_contract(bad_path, TinyGate())

        graph = onnx.load(onnx_path)
        for item in graph.metadata_props:
            if item.key == "productionUseForbidden":
                item.value = "false"
        bad_metadata_path = self.root / "bad-metadata.onnx"
        onnx.save(graph, bad_metadata_path)
        with self.assertRaisesRegex(TRAIN.BubbleFitTrainingError, "metadata"):
            TRAIN.assert_onnx_input_contract(bad_metadata_path, TinyGate())

    def test_five_class_training_fold_missing_any_class_fails_before_fit(
        self,
    ) -> None:
        labels = np.asarray([1, 0, 0, 0], dtype=np.int64)
        class_targets = np.asarray([0, 1, 2, 3], dtype=np.int64)
        with self.assertRaisesRegex(
            TRAIN.UnsupportedMulticlassFoldError,
            "unsafe_merged_or_wrong_region",
        ):
            TRAIN._fit_mobile_model(
                TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND,
                tuple(range(4)),
                np.zeros((4, 4, 8, 8), dtype=np.float32),
                labels,
                TRAIN.EvaluationConfig(seed=73),
                TRAIN.MobileNetWeightBundle(
                    state_dict={}, provenance={"fixture": True}
                ),
                73,
                class_targets,
            )

    def test_linear_probes_are_opt_in_and_only_binary_is_exportable(self) -> None:
        self.assertEqual(TRAIN.DEFAULT_MODEL_KINDS, TRAIN.LEGACY_MODEL_KINDS)
        self.assertIn(TRAIN.LINEAR_BINARY_MODEL_KIND, TRAIN.EXPORTABLE_MODEL_KINDS)
        self.assertNotIn(
            TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND, TRAIN.EXPORTABLE_MODEL_KINDS
        )
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "only binary MobileNet models support final/ONNX export",
        ):
            TRAIN.run_evaluation(
                snapshot=self.fixture.load(),
                output_dir=self.root / "forbidden five-class export",
                model_kinds=(TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND,),
                config=TRAIN.EvaluationConfig(seed=83),
                allow_official_weight_download=False,
                export_final_model=TRAIN.LINEAR_FIVE_CLASS_MODEL_KIND,
            )

    def test_linear_binary_all_data_export_has_no_operational_threshold(self) -> None:
        from torch import nn

        class TinyGate(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.conv = nn.Conv2d(4, 1, kernel_size=1)

            def forward(self, value):
                return self.conv(value).mean(dim=(2, 3))

        output = self.root / "diagnostic final"
        output.mkdir(parents=True)
        fake_bundle = TRAIN.MobileNetWeightBundle(
            state_dict={}, provenance={"fixture": True}
        )
        snapshot = self.fixture.load()
        authority = TRAIN.execution_authority(requires_mobile=True)
        confirmatory_contract = TRAIN.confirmatory_audit_contract(
            current_source_work_count=4, target=0.05
        )
        authority_bindings = TRAIN.build_authority_bindings(
            snapshot=snapshot,
            config=TRAIN.EvaluationConfig(),
            model_kinds=(TRAIN.LINEAR_BINARY_MODEL_KIND,),
            export_final_model=TRAIN.LINEAR_BINARY_MODEL_KIND,
            split_plan_sha256="a" * 64,
            oof_predictions_sha256="b" * 64,
            authority=authority,
            confirmatory_contract=confirmatory_contract,
        )
        with mock.patch.object(
            TRAIN,
            "_fit_mobile_model",
            return_value=(TinyGate(), {"status": "fixture"}),
        ):
            contract = TRAIN._train_final_mobile_candidate(
                TRAIN.LINEAR_BINARY_MODEL_KIND,
                np.zeros((2, 4, 224, 224), dtype=np.float32),
                np.asarray([0, 1], dtype=np.int64),
                TRAIN.EvaluationConfig(),
                fake_bundle,
                output,
                {
                    "sourcePageCount": 2,
                    "sourceWorkCount": 2,
                    "candidateCount": 2,
                    "candidateBearingWorkCount": 2,
                },
                authority,
                authority_bindings,
                confirmatory_contract,
            )
        self.assertIsNone(contract["threshold"])
        self.assertEqual(contract["modelKind"], TRAIN.LINEAR_BINARY_MODEL_KIND)
        self.assertIsNone(contract["operationalThreshold"])
        self.assertTrue(contract["calibrationRequired"])
        self.assertFalse(contract["runtimePreprocessorParity"])
        self.assertFalse(contract["exactProductionFloodParity"])
        self.assertFalse(contract["productionSafetyEstablished"])
        self.assertFalse(contract["confirmatory"])
        self.assertEqual(
            contract["datasetManifestSha256"], snapshot.dataset_manifest_sha256
        )
        self.assertEqual(contract["labelsSha256"], snapshot.labels_sha256)
        self.assertEqual(
            contract["productionInputBindingSha256"],
            snapshot.production_input_binding_sha256,
        )
        self.assertEqual(contract["splitPlanSha256"], "a" * 64)
        self.assertEqual(
            contract["evaluationConfigCanonicalSha256"],
            authority_bindings["evaluationConfigCanonicalSha256"],
        )
        self.assertEqual(contract["onnx"]["outputName"], "safe_probability")

    def test_final_candidate_validator_reopens_state_and_reexecutes_onnx(
        self,
    ) -> None:
        from torch import nn

        snapshot, base = self.make_linear_final_output("strict final base")
        self.assertTrue(
            TRAIN.validate_output_artifacts(base, expected_snapshot=snapshot)["ok"]
        )
        base_contract = json.loads(
            (base / "final-candidate-contract.json").read_text(encoding="utf-8")
        )
        self.assertIsNone(base_contract["operationalThreshold"])
        self.assertTrue(base_contract["productionUseForbidden"])
        self.assertTrue(base_contract["onnx"]["numericalParity"]["passed"])

        bad_state_output = self.root / "strict final bad state"
        shutil.copytree(base, bad_state_output)
        bad_state_path = bad_state_output / "final-candidate-state.pt"
        bad_state_path.write_bytes(b"not a safe tensor state dictionary")
        bad_state_contract = copy.deepcopy(base_contract)
        bad_state_contract["state"]["sha256"] = sha256_file(bad_state_path)
        bad_state_contract["state"]["sizeBytes"] = bad_state_path.stat().st_size
        rewrite_final_contract_and_seal(bad_state_output, bad_state_contract)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "state could not be safely reopened|state dictionary is invalid",
        ):
            TRAIN.validate_output_artifacts(
                bad_state_output, expected_snapshot=snapshot
            )

        class DifferentTinyGate(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.conv = nn.Conv2d(4, 1, kernel_size=1)

            def forward(self, value):
                return self.conv(value).mean(dim=(2, 3))

        bad_onnx_output = self.root / "strict final bad onnx"
        shutil.copytree(base, bad_onnx_output)
        bad_onnx_path = bad_onnx_output / "final-candidate.onnx"
        bad_onnx_record = TRAIN.export_onnx_candidate(
            DifferentTinyGate(), bad_onnx_path
        )
        bad_onnx_contract = copy.deepcopy(base_contract)
        bad_onnx_contract["onnx"] = {
            "path": "final-candidate.onnx",
            **bad_onnx_record,
        }
        rewrite_final_contract_and_seal(bad_onnx_output, bad_onnx_contract)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError,
            "differs from PyTorch|contract/parity receipt",
        ):
            TRAIN.validate_output_artifacts(bad_onnx_output, expected_snapshot=snapshot)

        threshold_output = self.root / "strict final threshold tamper"
        shutil.copytree(base, threshold_output)
        threshold_contract = copy.deepcopy(base_contract)
        threshold_contract["operationalThreshold"] = 0.5
        rewrite_final_contract_and_seal(threshold_output, threshold_contract)
        with self.assertRaisesRegex(
            TRAIN.BubbleFitTrainingError, "final candidate contract binding"
        ):
            TRAIN.validate_output_artifacts(
                threshold_output, expected_snapshot=snapshot
            )


if __name__ == "__main__":
    unittest.main()
