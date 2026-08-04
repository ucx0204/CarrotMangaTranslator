#!/usr/bin/env python3
"""Export the active21 MangaFont v7 query head for the application runtime.

The application currently consumes the sealed v2 hybrid I/O envelope.  This
exporter preserves that envelope while making every font-family score come
from one shared v7 pixel-only head:

* ``candidate_scores`` == ``body_candidate_scores`` ==
  ``variant_candidate_scores``;
* the score path consumes only base SigLIP2 patch tokens, the trained 4x256
  query head, and active21 candidate-query prototypes;
* role/style/treatment outputs are neutral compatibility tensors, so role is
  left to the application's downstream consistency/emphasis policy; and
* Gugi is removed from the copied active catalog, candidate tensors, bags,
  and prototypes before ONNX export.

The legacy 256-D encoder prefix remains only because the TypeScript v2 runtime
contract and future selection-calibration feature layout require it.  It is
not read by the font-family score graph.  Completed v7/r3 teacher-stable
outputs are release-candidate sources subject to the same quality and
selection-calibration gates as v7/v7-r2.  A sealed v6/r3 head may still be
supplied only with ``--allow-r3-fixture-source`` for bounded QA export.
Fixture bundles are marked QA-only and are never installed by this script.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import export_font_matching_runtime_onnx as legacy_export
    from scripts import export_manga_font_student_hybrid_runtime_onnx as hybrid
    from scripts import export_manga_font_student_runtime_onnx as base_export
    from scripts import train_manga_font_student_v1 as trainer
    from scripts import train_manga_font_student_v6_fontquery as trainer_v6
    from scripts import train_manga_font_student_v6_fontquery_r3 as trainer_r3
    from scripts import train_manga_font_student_v6_mass21_data as mass21
    from scripts import train_manga_font_student_v7_mass21 as trainer_v7
    from scripts import train_manga_font_student_v7_mass21_r2 as trainer_v7_r2
    from scripts import train_manga_font_student_v7_mass21_r3 as trainer_v7_r3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_matching_runtime_artifact as runtime
    import export_font_matching_runtime_onnx as legacy_export
    import export_manga_font_student_hybrid_runtime_onnx as hybrid
    import export_manga_font_student_runtime_onnx as base_export
    import train_manga_font_student_v1 as trainer
    import train_manga_font_student_v6_fontquery as trainer_v6
    import train_manga_font_student_v6_fontquery_r3 as trainer_r3
    import train_manga_font_student_v6_mass21_data as mass21
    import train_manga_font_student_v7_mass21 as trainer_v7
    import train_manga_font_student_v7_mass21_r2 as trainer_v7_r2
    import train_manga_font_student_v7_mass21_r3 as trainer_v7_r3


SCHEMA_VERSION = hybrid.SCHEMA_VERSION
RECORD_TYPE = hybrid.RECORD_TYPE
OWNER = hybrid.OWNER
MARKER_FILE = hybrid.MARKER_FILE
CONTRACT_FILE = hybrid.CONTRACT_FILE
ENCODER_FILE = hybrid.ENCODER_FILE
RANKER_FILE = hybrid.RANKER_FILE
PROTOTYPE_FILE = hybrid.PROTOTYPE_FILE
ACTIVE_CATALOG_FILE = hybrid.ACTIVE_CATALOG_FILE
OUTPUT_FILES = hybrid.OUTPUT_FILES
OPSET_VERSION = hybrid.OPSET_VERSION
MIN_PARITY_SAMPLES = hybrid.MIN_PARITY_SAMPLES
ENCODER_BATCH_SIZE = hybrid.ENCODER_BATCH_SIZE
RANKER_BATCH_SIZE = hybrid.RANKER_BATCH_SIZE
LEGACY_FEATURE_DIM = hybrid.LEGACY_FEATURE_DIM
QUERY_COUNT = trainer_v7.QUERY_COUNT
QUERY_DIM = trainer_v7.QUERY_DIM
QUERY_FEATURE_DIM = QUERY_COUNT * QUERY_DIM
FEATURE_DIM = LEGACY_FEATURE_DIM + QUERY_FEATURE_DIM
RANKER_OUTPUT_NAMES = hybrid.RANKER_OUTPUT_NAMES
ACTIVE_CANDIDATE_IDS = mass21.candidate_projection(
    mass21.legacy15.FULL22_CANDIDATE_IDS
).active_ids
ACTIVE_CATALOG_VERSION = "fontclip-font-catalog-v2-manga-font21-no-gugi"


class MangaFontV7RuntimeExportError(ValueError):
    """Raised when active21 runtime provenance or parity is unsafe."""


@dataclass(frozen=True)
class FontQuerySource:
    root: Path
    kind: str
    schema_version: str
    manifest_name: str
    manifest: Mapping[str, Any]
    checkpoint_path: Path
    prototype_path: Path
    prototypes: np.ndarray
    candidate_ids: tuple[str, ...]
    fixture_only: bool
    quality_gate_passed: bool


@dataclass(frozen=True)
class V7RuntimeAuthority:
    base: base_export.StudentAuthority
    source: FontQuerySource
    candidate_ids: tuple[str, ...]
    candidate_bags: tuple[dict[str, Any], ...]
    active_catalog: Mapping[str, Any]
    packed_prototypes: np.ndarray


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV7RuntimeExportError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise MangaFontV7RuntimeExportError(f"{location}: missing or linked file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MangaFontV7RuntimeExportError(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _safe_output(path: Path) -> Path:
    try:
        return base_export._safe_output(path)  # noqa: SLF001
    except base_export.StudentRuntimeExportError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error


def _exact_inventory(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV7RuntimeExportError("runtime output is missing or linked")
    entries = tuple(root.iterdir())
    if (
        any(path.is_symlink() or not path.is_file() for path in entries)
        or {path.name for path in entries} != set(OUTPUT_FILES)
    ):
        raise MangaFontV7RuntimeExportError("runtime output inventory drifted")


def _quality_gate_passed(value: Mapping[str, Any]) -> bool:
    gate = value.get("quality_gate")
    return isinstance(gate, Mapping) and gate.get("passed") is True


def _load_completed_v7_r3_source(root: Path) -> FontQuerySource:
    try:
        validation = trainer_v7_r3.validate_output(root)
    except (
        trainer_v7_r3.MangaFontV7Mass21R3Error,
        trainer_v7_r2.MangaFontV7Mass21R2Error,
        trainer_v7.MangaFontV7Mass21Error,
    ) as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    if validation.get("status") != "validated_v7_mass21_r3_teacher_stable_output":
        raise MangaFontV7RuntimeExportError("v7 r3 completion validator status drifted")
    marker = _read_json(root / trainer_v7_r3.MARKER, "v7 r3 marker")
    manifest = _read_json(root / trainer_v7.MANIFEST, "v7 r3 manifest")
    try:
        runtime.validate_record_seal(manifest, location="v7 r3 manifest")
    except runtime.RuntimeArtifactError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    expected_source_sha = runtime.sha256_file(Path(trainer_v7_r3.__file__).resolve())
    source_provenance = _mapping(
        manifest.get("source_provenance"), "v7 r3 source provenance"
    )
    source_fingerprint = _mapping(
        manifest.get("source_fingerprint"), "v7 r3 source fingerprint"
    )
    distillation = _mapping(manifest.get("distillation"), "v7 r3 distillation")
    best_epoch = manifest.get("best_epoch")
    history_epochs = manifest.get("history_epochs")
    if (
        marker.get("owner") != trainer_v7_r3.OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != trainer_v7_r3.SCHEMA
        or manifest.get("schema_version") != trainer_v7_r3.SCHEMA
        or manifest.get("record_type")
        != "manga_font_student_v7_mass21_r3_teacher_stable_training_manifest"
        or manifest.get("source_code_sha256") != expected_source_sha
        or source_provenance.get("r3_source_code_sha256") != expected_source_sha
        or isinstance(best_epoch, bool)
        or not isinstance(best_epoch, int)
        or best_epoch < 0
        or isinstance(history_epochs, bool)
        or not isinstance(history_epochs, int)
        or history_epochs < 1
        or best_epoch > history_epochs
        or int(validation.get("best_epoch", -1)) != best_epoch
        or int(validation.get("candidate_count", -1)) != len(ACTIVE_CANDIDATE_IDS)
        or not isinstance(source_fingerprint.get("r3_checkpoint_sha256"), str)
        or len(str(source_fingerprint.get("r3_checkpoint_sha256"))) != 64
        or distillation.get("teacher_checkpoint_sha256")
        != source_fingerprint.get("r3_checkpoint_sha256")
    ):
        raise MangaFontV7RuntimeExportError("v7 r3 marker/schema/source binding drifted")
    artifacts = _mapping(marker.get("artifacts"), "v7 r3 marker artifacts")
    expected_artifacts = trainer_v7_r3.OUTPUT_FILES - {trainer_v7_r3.MARKER}
    if set(artifacts) != expected_artifacts:
        raise MangaFontV7RuntimeExportError("v7 r3 marker artifact inventory drifted")
    descriptors = _mapping(manifest.get("files"), "v7 r3 files")
    expected_descriptors = expected_artifacts - {trainer_v7.MANIFEST}
    if set(descriptors) != expected_descriptors:
        raise MangaFontV7RuntimeExportError("v7 r3 best-epoch file inventory drifted")
    for name in expected_artifacts:
        path = root / name
        digest = runtime.sha256_file(path)
        if artifacts.get(name) != digest:
            raise MangaFontV7RuntimeExportError(f"v7 r3 marker hash drifted: {name}")
        if name == trainer_v7.MANIFEST:
            continue
        descriptor = _mapping(descriptors.get(name), f"v7 r3 files.{name}")
        if (
            descriptor.get("file") != name
            or descriptor.get("sha256") != digest
            or int(descriptor.get("byte_size", -1)) != path.stat().st_size
        ):
            raise MangaFontV7RuntimeExportError(
                f"v7 r3 best-epoch file seal drifted: {name}"
            )
    candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
    if (
        candidate_ids != ACTIVE_CANDIDATE_IDS
        or mass21.RETIRED_FONT_ID in candidate_ids
    ):
        raise MangaFontV7RuntimeExportError("v7 r3 candidate order is not active21")
    try:
        prototypes = np.frombuffer(
            (root / trainer_v7.PROTOTYPES).read_bytes(), dtype="<f4"
        ).reshape(len(candidate_ids), QUERY_COUNT, QUERY_DIM)
    except (OSError, ValueError) as error:
        raise MangaFontV7RuntimeExportError("v7 r3 prototype artifact drifted") from error
    return FontQuerySource(
        root=root,
        kind="v7_mass21_r3_teacher_stable",
        schema_version=trainer_v7_r3.SCHEMA,
        manifest_name=trainer_v7.MANIFEST,
        manifest=manifest,
        checkpoint_path=root / trainer_v7.BEST_HEAD,
        prototype_path=root / trainer_v7.PROTOTYPES,
        prototypes=prototypes,
        candidate_ids=candidate_ids,
        fixture_only=False,
        quality_gate_passed=_quality_gate_passed(manifest),
    )


def _load_fontquery_source(
    output_dir: Path, *, allow_r3_fixture_source: bool
) -> FontQuerySource:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV7RuntimeExportError("font-query output is missing or linked")
    if (root / trainer_v7_r3.MARKER).is_file():
        source = _load_completed_v7_r3_source(root)
    elif (root / trainer_v7_r2.MARKER).is_file():
        try:
            trainer_v7_r2.validate_output(root)
        except (
            trainer_v7_r2.MangaFontV7Mass21R2Error,
            trainer_v7.MangaFontV7Mass21Error,
        ) as error:
            raise MangaFontV7RuntimeExportError(str(error)) from error
        manifest = _read_json(root / trainer_v7.MANIFEST, "v7 r2 manifest")
        candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
        if candidate_ids != ACTIVE_CANDIDATE_IDS:
            raise MangaFontV7RuntimeExportError("v7 r2 candidate order is not active21")
        source = FontQuerySource(
            root=root,
            kind="v7_mass21_r2",
            schema_version=trainer_v7_r2.SCHEMA,
            manifest_name=trainer_v7.MANIFEST,
            manifest=manifest,
            checkpoint_path=root / trainer_v7.BEST_HEAD,
            prototype_path=root / trainer_v7.PROTOTYPES,
            prototypes=np.frombuffer(
                (root / trainer_v7.PROTOTYPES).read_bytes(), dtype="<f4"
            ).reshape(len(candidate_ids), QUERY_COUNT, QUERY_DIM),
            candidate_ids=candidate_ids,
            fixture_only=False,
            quality_gate_passed=_quality_gate_passed(manifest),
        )
    elif (root / trainer_v7.MARKER).is_file():
        try:
            trainer_v7.validate_output(root)
        except trainer_v7.MangaFontV7Mass21Error as error:
            raise MangaFontV7RuntimeExportError(str(error)) from error
        manifest = _read_json(root / trainer_v7.MANIFEST, "v7 manifest")
        candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
        if candidate_ids != ACTIVE_CANDIDATE_IDS:
            raise MangaFontV7RuntimeExportError("v7 candidate order is not active21")
        source = FontQuerySource(
            root=root,
            kind="v7_mass21",
            schema_version=trainer_v7.SCHEMA,
            manifest_name=trainer_v7.MANIFEST,
            manifest=manifest,
            checkpoint_path=root / trainer_v7.BEST_HEAD,
            prototype_path=root / trainer_v7.PROTOTYPES,
            prototypes=np.frombuffer(
                (root / trainer_v7.PROTOTYPES).read_bytes(), dtype="<f4"
            ).reshape(len(candidate_ids), QUERY_COUNT, QUERY_DIM),
            candidate_ids=candidate_ids,
            fixture_only=False,
            quality_gate_passed=_quality_gate_passed(manifest),
        )
    elif (root / trainer_r3.MARKER).is_file():
        if not allow_r3_fixture_source:
            raise MangaFontV7RuntimeExportError(
                "r3 is fixture-only; pass --allow-r3-fixture-source"
            )
        try:
            trainer_r3.validate_output(root)
        except trainer_r3.MangaFontV6R3Error as error:
            raise MangaFontV7RuntimeExportError(str(error)) from error
        report = _read_json(root / trainer_r3.REPORT, "r3 fixture report")
        source_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
        projection = mass21.candidate_projection(source_ids)
        source_prototypes = np.frombuffer(
            (root / trainer_r3.PROTOTYPES).read_bytes(), dtype="<f4"
        ).reshape(len(source_ids), QUERY_COUNT, QUERY_DIM)
        source = FontQuerySource(
            root=root,
            kind="r3_projected_fixture",
            schema_version=trainer_r3.SCHEMA,
            manifest_name=trainer_r3.REPORT,
            manifest=report,
            checkpoint_path=root / trainer_r3.CHECKPOINT,
            prototype_path=root / trainer_r3.PROTOTYPES,
            prototypes=np.ascontiguousarray(
                source_prototypes[np.asarray(projection.keep_indices, dtype=np.int64)]
            ),
            candidate_ids=projection.active_ids,
            fixture_only=True,
            quality_gate_passed=False,
        )
    else:
        raise MangaFontV7RuntimeExportError(
            "font-query source is neither sealed v7/v7-r2/v7-r3 nor permitted r3 fixture"
        )
    architecture = _mapping(source.manifest.get("architecture"), "source architecture")
    if (
        source.candidate_ids != ACTIVE_CANDIDATE_IDS
        or source.prototypes.shape != (len(ACTIVE_CANDIDATE_IDS), QUERY_COUNT, QUERY_DIM)
        or not np.isfinite(source.prototypes).all()
        or int(architecture.get("query_count", 0)) != QUERY_COUNT
        or int(architecture.get("query_dim", 0)) != QUERY_DIM
        or int(architecture.get("encoder_trainable_blocks", -1)) != 0
        or architecture.get("candidate_bias") is not False
    ):
        raise MangaFontV7RuntimeExportError("font-query source architecture drifted")
    norms = np.linalg.norm(source.prototypes, axis=-1)
    if np.max(np.abs(norms - 1.0)) > 1e-4:
        raise MangaFontV7RuntimeExportError("candidate-query prototypes are not normalized")
    return source


def _project_active_catalog(
    source_catalog: Mapping[str, Any],
) -> dict[str, Any]:
    record = copy.deepcopy(
        dict(_mapping(source_catalog.get("record"), "full22 active catalog record"))
    )
    source_ids = tuple(str(value) for value in record.get("candidate_ids", ()))
    if source_ids != base_export.EXPECTED_CANDIDATE_IDS:
        raise MangaFontV7RuntimeExportError("active catalog is not pinned full22")
    candidates = list(record.get("candidates", ()))
    if tuple(str(row.get("candidate_id")) for row in candidates) != source_ids:
        raise MangaFontV7RuntimeExportError("active catalog candidate rows drifted")
    gugi_rows = [row for row in candidates if row.get("candidate_id") == mass21.RETIRED_FONT_ID]
    if len(gugi_rows) != 1:
        raise MangaFontV7RuntimeExportError("Gugi catalog row is not unique")
    excluded = list(record.get("excluded_candidates", ()))
    if any(row.get("candidate_id") == mass21.RETIRED_FONT_ID for row in excluded):
        raise MangaFontV7RuntimeExportError("Gugi was already excluded unexpectedly")
    projected = {
        key: value
        for key, value in record.items()
        if key != "record_sha256"
    }
    projected.update(
        {
            "candidate_count": len(ACTIVE_CANDIDATE_IDS),
            "candidate_ids": list(ACTIVE_CANDIDATE_IDS),
            "candidate_order_sha256": runtime._ordered_values_sha256(  # noqa: SLF001
                ACTIVE_CANDIDATE_IDS
            ),
            "candidates": [
                row for row in candidates if row.get("candidate_id") != mass21.RETIRED_FONT_ID
            ],
            "catalog_version": ACTIVE_CATALOG_VERSION,
            "excluded_candidates": [
                *excluded,
                {
                    "candidate_id": mass21.RETIRED_FONT_ID,
                    "disposition": {
                        "action": "deleted_safe_zero",
                        "active_release_eligible": False,
                        "all_unrenderable": False,
                        "deployable_opportunity_count": 1,
                        "evidence_source": "v5_catalog_disposition",
                        "safe_count": 0,
                        "terminal": True,
                    },
                },
            ],
        }
    )
    sealed = runtime.seal_record(projected)
    try:
        normalized = runtime.validate_active_catalog_record(
            sealed, location="projected active21 catalog"
        )
    except runtime.RuntimeArtifactError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    if (
        tuple(normalized["candidate_ids"]) != ACTIVE_CANDIDATE_IDS
        or any(row["candidate_id"] == mass21.RETIRED_FONT_ID for row in normalized["candidates"])
    ):
        raise MangaFontV7RuntimeExportError("projected catalog retained Gugi")
    return dict(sealed)


def _pack_active21_prototypes(
    *,
    legacy_prototypes: np.ndarray,
    source_candidate_ids: tuple[str, ...],
    source_bags: Sequence[Mapping[str, Any]],
    query_prototypes: np.ndarray,
) -> tuple[np.ndarray, tuple[dict[str, Any], ...]]:
    legacy = np.asarray(legacy_prototypes, dtype=np.float32)
    queries = np.asarray(query_prototypes, dtype=np.float32)
    if (
        source_candidate_ids != base_export.EXPECTED_CANDIDATE_IDS
        or len(source_bags) != len(source_candidate_ids)
        or legacy.ndim != 2
        or legacy.shape[1] != LEGACY_FEATURE_DIM
        or queries.shape != (len(ACTIVE_CANDIDATE_IDS), QUERY_COUNT, QUERY_DIM)
        or not np.isfinite(legacy).all()
        or not np.isfinite(queries).all()
    ):
        raise MangaFontV7RuntimeExportError("prototype input contract drifted")
    source_index = {candidate_id: index for index, candidate_id in enumerate(source_candidate_ids)}
    legacy_rows: list[np.ndarray] = []
    query_rows: list[np.ndarray] = []
    bags: list[dict[str, Any]] = []
    start = 0
    for active_index, candidate_id in enumerate(ACTIVE_CANDIDATE_IDS):
        bag = source_bags[source_index[candidate_id]]
        if bag.get("candidate_id") != candidate_id:
            raise MangaFontV7RuntimeExportError("legacy prototype bag order drifted")
        source_start = int(bag.get("start", -1))
        count = int(bag.get("count", 0))
        if source_start < 0 or count < 1 or source_start + count > legacy.shape[0]:
            raise MangaFontV7RuntimeExportError("legacy prototype bag range drifted")
        legacy_rows.append(legacy[source_start : source_start + count])
        query_rows.append(
            np.repeat(queries[active_index][None, :, :], count, axis=0).reshape(
                count, QUERY_FEATURE_DIM
            )
        )
        bags.append({"candidate_id": candidate_id, "count": count, "start": start})
        start += count
    packed = np.concatenate(
        [np.concatenate(legacy_rows, axis=0), np.concatenate(query_rows, axis=0)],
        axis=1,
    )
    if packed.shape != (start, FEATURE_DIM):
        raise MangaFontV7RuntimeExportError("active21 packed prototype shape drifted")
    return np.ascontiguousarray(packed, dtype="<f4"), tuple(bags)


def load_v7_runtime_authority(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    v7_output_dir: Path,
    allow_r3_fixture_source: bool,
) -> V7RuntimeAuthority:
    try:
        base = base_export.load_student_authority(
            student_output=student_output,
            active_catalog_path=active_catalog_path,
            encoder_source_dir=encoder_source_dir,
        )
    except base_export.StudentRuntimeExportError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    source = _load_fontquery_source(
        v7_output_dir, allow_r3_fixture_source=allow_r3_fixture_source
    )
    packed, bags = _pack_active21_prototypes(
        legacy_prototypes=base.prototypes,
        source_candidate_ids=base.candidate_ids,
        source_bags=base.candidate_bags,
        query_prototypes=source.prototypes,
    )
    active_catalog = _project_active_catalog(base.active_catalog)
    return V7RuntimeAuthority(
        base=base,
        source=source,
        candidate_ids=ACTIVE_CANDIDATE_IDS,
        candidate_bags=bags,
        active_catalog=active_catalog,
        packed_prototypes=packed,
    )


def _load_models(authority: V7RuntimeAuthority) -> tuple[Any, Any, Any]:
    legacy_export._ensure_offline_environment()  # noqa: SLF001
    try:
        import torch
        from safetensors.torch import load_file
        from transformers import SiglipVisionModel
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV7RuntimeExportError(
            "export requires torch, transformers, and safetensors"
        ) from error
    legacy_student, _processor = base_export._load_models(authority.base)  # noqa: SLF001
    try:
        vision = SiglipVisionModel.from_pretrained(
            str(authority.base.encoder_source_dir),
            local_files_only=True,
            attn_implementation="eager",
        )
        vision.config._attn_implementation = "eager"  # noqa: SLF001
        head = trainer_v6.build_font_query_head(
            torch,
            query_count=QUERY_COUNT,
            query_dim=QUERY_DIM,
            hidden_size=int(vision.config.hidden_size),
        )
        head.load_state_dict(
            dict(load_file(str(authority.source.checkpoint_path), device="cpu")),
            strict=True,
        )
    except Exception as error:  # noqa: BLE001
        raise MangaFontV7RuntimeExportError(
            f"v7 query model reconstruction failed: {error}"
        ) from error
    for model in (legacy_student, vision, head):
        model.requires_grad_(False)
        model.eval()
        model.to("cpu", dtype=torch.float32)
    return legacy_student, vision, head


def _make_wrappers(
    *,
    authority: V7RuntimeAuthority,
    legacy_student: Any,
    vision: Any,
    head: Any,
) -> tuple[Any, Any]:
    import torch

    class EncoderWrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.legacy_vision = legacy_student.vision_encoder
            self.legacy_projection = legacy_student.projection
            self.patch_vision = vision
            self.query_head = head

        def forward(self, pixel_values: Any) -> Any:
            legacy_output = self.legacy_vision(
                pixel_values=pixel_values, return_dict=False
            )
            compatibility = torch.nn.functional.normalize(
                self.legacy_projection(legacy_output[1]).float(), p=2, dim=-1
            )
            patch_output = self.patch_vision(
                pixel_values=pixel_values, return_dict=False
            )
            query_embeddings, _attention = self.query_head.encode(patch_output[0])
            return torch.cat(
                [compatibility, query_embeddings.flatten(start_dim=1)], dim=-1
            )

    treatment_fields = tuple(sorted(trainer.TREATMENT_VALUES))

    class RankerWrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.register_buffer(
                "query_weight_logits",
                head.query_weight_logits.detach().float().clone(),
            )
            self.register_buffer("logit_scale", head.logit_scale.detach().float().clone())

        def forward(self, views: Any, prototype_features: Any) -> tuple[Any, ...]:
            query_views = views[:, :, LEGACY_FEATURE_DIM:].reshape(
                views.shape[0], 3, QUERY_COUNT, QUERY_DIM
            )
            sample = torch.nn.functional.normalize(
                query_views.mean(dim=1), p=2, dim=-1
            )
            candidate_prototypes = []
            for bag in authority.candidate_bags:
                rows = prototype_features[
                    int(bag["start"]) : int(bag["start"]) + int(bag["count"]),
                    LEGACY_FEATURE_DIM:,
                ].reshape(int(bag["count"]), QUERY_COUNT, QUERY_DIM)
                candidate_prototypes.append(
                    torch.nn.functional.normalize(rows.mean(dim=0), p=2, dim=-1)
                )
            prototypes = torch.stack(candidate_prototypes, dim=0)
            per_query = torch.einsum("bqd,cqd->bcq", sample, prototypes)
            weights = torch.softmax(self.query_weight_logits, dim=0)
            scores = self.logit_scale.exp().clamp(max=100.0) * (
                per_query * weights[None, None, :]
            ).sum(dim=-1)
            neutral = scores[:, 0] * 0.0
            none_logits = neutral - 20.0
            role_logits = neutral[:, None].expand(-1, len(trainer.ROLE_VALUES))
            style_logits = neutral[:, None].expand(-1, len(trainer.STYLE_FIELDS))
            treatments = tuple(
                neutral[:, None].expand(-1, len(trainer.TREATMENT_VALUES[field]))
                for field in treatment_fields
            )
            view_gate_weights = torch.ones_like(views[:, :, 0]) / 3.0
            return (
                scores,
                scores,
                scores,
                none_logits,
                role_logits,
                style_logits,
                *treatments,
                view_gate_weights,
            )

    return EncoderWrapper().eval(), RankerWrapper().eval()


def _io_contract(authority: V7RuntimeAuthority) -> dict[str, Any]:
    candidate_count = len(authority.candidate_ids)
    prototype_count = int(authority.packed_prototypes.shape[0])
    outputs = [
        {"name": "candidate_scores", "shape": [None, candidate_count], "type": "tensor(float)"},
        {"name": "body_candidate_scores", "shape": [None, candidate_count], "type": "tensor(float)"},
        {"name": "variant_candidate_scores", "shape": [None, candidate_count], "type": "tensor(float)"},
        {"name": "none_logits", "shape": [None], "type": "tensor(float)"},
        {"name": "role_logits", "shape": [None, len(trainer.ROLE_VALUES)], "type": "tensor(float)"},
        {"name": "style_logits", "shape": [None, len(trainer.STYLE_FIELDS)], "type": "tensor(float)"},
    ]
    outputs.extend(
        {
            "name": f"treatment_{field}_logits",
            "shape": [None, len(trainer.TREATMENT_VALUES[field])],
            "type": "tensor(float)",
        }
        for field in sorted(trainer.TREATMENT_VALUES)
    )
    outputs.append(
        {"name": "view_gate_weights", "shape": [None, 3], "type": "tensor(float)"}
    )
    return {
        ENCODER_FILE: {
            "inputs": [
                {"name": "pixel_values", "shape": [None, 3, 224, 224], "type": "tensor(float)"}
            ],
            "outputs": [
                {"name": "image_features", "shape": [None, FEATURE_DIM], "type": "tensor(float)"}
            ],
        },
        RANKER_FILE: {
            "inputs": [
                {"name": "views", "shape": [None, 3, FEATURE_DIM], "type": "tensor(float)"},
                {
                    "name": "prototype_features",
                    "shape": [prototype_count, FEATURE_DIM],
                    "type": "tensor(float)",
                },
            ],
            "outputs": outputs,
        },
    }


def _export_graphs(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    authority: V7RuntimeAuthority,
    encoder_path: Path,
    ranker_path: Path,
) -> None:
    legacy_export._require_onnx_export_dependency()  # noqa: SLF001
    import torch

    prototypes = torch.from_numpy(np.array(authority.packed_prototypes, copy=True))
    dynamic_ranker = {"views": {0: "batch"}}
    dynamic_ranker.update({name: {0: "batch"} for name in RANKER_OUTPUT_NAMES})
    try:
        with torch.inference_mode():
            torch.onnx.export(
                encoder_wrapper,
                (torch.zeros((1, 3, 224, 224), dtype=torch.float32),),
                str(encoder_path),
                input_names=["pixel_values"],
                output_names=["image_features"],
                dynamic_axes={
                    "pixel_values": {0: "batch"},
                    "image_features": {0: "batch"},
                },
                opset_version=OPSET_VERSION,
                dynamo=False,
                external_data=False,
                export_params=True,
                do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
            torch.onnx.export(
                ranker_wrapper,
                (
                    torch.zeros((2, 3, FEATURE_DIM), dtype=torch.float32),
                    prototypes,
                ),
                str(ranker_path),
                input_names=["views", "prototype_features"],
                output_names=list(RANKER_OUTPUT_NAMES),
                dynamic_axes=dynamic_ranker,
                opset_version=OPSET_VERSION,
                dynamo=False,
                external_data=False,
                export_params=True,
                do_constant_folding=True,
                training=torch.onnx.TrainingMode.EVAL,
            )
    except Exception as error:  # noqa: BLE001
        raise MangaFontV7RuntimeExportError(
            f"PyTorch ONNX export failed: {error}"
        ) from error


def _parity_metrics(
    *,
    reference_encoder: np.ndarray,
    actual_encoder: np.ndarray,
    reference_ranker: Mapping[str, np.ndarray],
    actual_ranker: Mapping[str, np.ndarray],
) -> dict[str, Any]:
    body_error = float(
        np.max(
            np.abs(
                actual_ranker["candidate_scores"]
                - actual_ranker["body_candidate_scores"]
            )
        )
    )
    variant_error = float(
        np.max(
            np.abs(
                actual_ranker["candidate_scores"]
                - actual_ranker["variant_candidate_scores"]
            )
        )
    )
    if body_error != 0.0 or variant_error != 0.0:
        raise MangaFontV7RuntimeExportError("shared active21 score aliases drifted")
    try:
        metrics = base_export._parity_metrics(  # noqa: SLF001
            reference_encoder=reference_encoder,
            actual_encoder=actual_encoder,
            reference_ranker=reference_ranker,
            actual_ranker=actual_ranker,
        )
    except base_export.StudentRuntimeExportError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    return {
        **metrics,
        "body_alias_max_abs_error": body_error,
        "variant_alias_max_abs_error": variant_error,
        "variant_top1_agreement": 1.0,
    }


def _run_parity(
    *,
    encoder_wrapper: Any,
    ranker_wrapper: Any,
    authority: V7RuntimeAuthority,
    encoder_path: Path,
    ranker_path: Path,
    electron_path: Path,
    sample_count: int,
    seed: int,
    wasm_timeout_seconds: int,
) -> Mapping[str, Any]:
    if sample_count < MIN_PARITY_SAMPLES:
        raise MangaFontV7RuntimeExportError(
            f"parity requires at least {MIN_PARITY_SAMPLES} synthetic rows"
        )
    encoder_inputs = legacy_export._synthetic_encoder_inputs(sample_count, seed)  # noqa: SLF001
    rng = np.random.default_rng(seed ^ 0x721)
    ranker_views = rng.standard_normal(
        (sample_count, 3, FEATURE_DIM), dtype=np.float32
    )
    legacy = ranker_views[:, :, :LEGACY_FEATURE_DIM]
    legacy /= np.maximum(
        np.linalg.norm(legacy, axis=-1, keepdims=True), np.float32(1e-12)
    )
    queries = ranker_views[:, :, LEGACY_FEATURE_DIM:].reshape(
        sample_count, 3, QUERY_COUNT, QUERY_DIM
    )
    queries /= np.maximum(
        np.linalg.norm(queries, axis=-1, keepdims=True), np.float32(1e-12)
    )
    ranker_views = np.ascontiguousarray(ranker_views)
    reference_encoder, reference_ranker = legacy_export._run_reference_models(  # noqa: SLF001
        encoder_wrapper=encoder_wrapper,
        ranker_wrapper=ranker_wrapper,
        encoder_inputs=encoder_inputs,
        ranker_views=ranker_views,
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=ENCODER_BATCH_SIZE,
        ranker_batch_size=RANKER_BATCH_SIZE,
        output_names=RANKER_OUTPUT_NAMES,
    )
    cpu_encoder, cpu_ranker, cpu_evidence = legacy_export._run_cpu_ort(  # noqa: SLF001
        encoder_path=encoder_path,
        ranker_path=ranker_path,
        encoder_inputs=encoder_inputs,
        ranker_views=ranker_views,
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=ENCODER_BATCH_SIZE,
        ranker_batch_size=RANKER_BATCH_SIZE,
        output_names=RANKER_OUTPUT_NAMES,
    )
    wasm_encoder, wasm_ranker, wasm_evidence = legacy_export._run_electron_wasm(  # noqa: SLF001
        encoder_path=encoder_path,
        ranker_path=ranker_path,
        encoder_inputs=encoder_inputs,
        ranker_views=ranker_views,
        prototype_features=authority.packed_prototypes,
        encoder_batch_size=ENCODER_BATCH_SIZE,
        ranker_batch_size=RANKER_BATCH_SIZE,
        output_names=RANKER_OUTPUT_NAMES,
        electron_path=electron_path,
        timeout_seconds=wasm_timeout_seconds,
    )
    return {
        "cpu": {
            "evidence": dict(cpu_evidence),
            "metrics": _parity_metrics(
                reference_encoder=reference_encoder,
                actual_encoder=cpu_encoder,
                reference_ranker=reference_ranker,
                actual_ranker=cpu_ranker,
            ),
        },
        "wasm": {
            "evidence": dict(wasm_evidence),
            "metrics": _parity_metrics(
                reference_encoder=reference_encoder,
                actual_encoder=wasm_encoder,
                reference_ranker=reference_ranker,
                actual_ranker=wasm_ranker,
            ),
        },
        "opset": OPSET_VERSION,
        "sample_count": sample_count,
        "sample_source": "deterministic_synthetic_only",
        "seed": seed,
        "test_or_fresh_or_library_qa_rows_used": 0,
    }


def _validate_parity_record(value: Any) -> None:
    parity = _mapping(value, "v7 export parity")
    if (
        parity.get("opset") != OPSET_VERSION
        or not isinstance(parity.get("sample_count"), int)
        or int(parity["sample_count"]) < MIN_PARITY_SAMPLES
        or parity.get("sample_source") != "deterministic_synthetic_only"
        or parity.get("test_or_fresh_or_library_qa_rows_used") != 0
    ):
        raise MangaFontV7RuntimeExportError("v7 parity boundary drifted")
    for target in ("cpu", "wasm"):
        row = _mapping(parity.get(target), f"v7 parity {target}")
        evidence = _mapping(row.get("evidence"), f"v7 parity {target} evidence")
        metrics = _mapping(row.get("metrics"), f"v7 parity {target} metrics")
        if (
            metrics.get("candidate_top1_agreement") != 1.0
            or metrics.get("variant_top1_agreement") != 1.0
            or metrics.get("none_decision_agreement") != 1.0
            or metrics.get("role_top1_agreement") != 1.0
            or metrics.get("body_alias_max_abs_error") != 0.0
            or metrics.get("variant_alias_max_abs_error") != 0.0
            or float(metrics.get("encoder_max_abs_error", float("inf"))) > 2e-4
            or float(metrics.get("ranker_max_abs_error", float("inf"))) > 2e-4
            or float(metrics.get("encoder_minimum_cosine_similarity", 0.0)) < 0.999
        ):
            raise MangaFontV7RuntimeExportError(f"v7 {target} parity gate drifted")
        if target == "cpu":
            if evidence.get("execution_provider") != "CPUExecutionProvider":
                raise MangaFontV7RuntimeExportError("v7 CPU provider drifted")
        elif (
            evidence.get("package") != runtime.TARGET_ORT_PACKAGE
            or evidence.get("version") != runtime.TARGET_ORT_VERSION
            or evidence.get("host") != "electron-main"
            or evidence.get("all_outputs_finite") is not True
        ):
            raise MangaFontV7RuntimeExportError("v7 WASM runtime drifted")


def _font_family_evidence_contract() -> dict[str, Any]:
    return {
        "body_and_variant_share_exact_scores": True,
        "candidate_output": "candidate_scores",
        "candidate_score_inputs": [
            "base_siglip2_last_hidden_state_patch_tokens",
            "active21_four_query_head",
            "active21_candidate_query_prototypes",
        ],
        "forbidden_family_logit_inputs": ["gemma", "genre", "role"],
        "role_policy_stage": "downstream_page_consistency_and_emphasis_only",
        "schema_version": "manga-font-v7-active21-pixel-family-evidence-v1",
    }


def _build_contract(
    authority: V7RuntimeAuthority,
    staging: Path,
    parity: Mapping[str, Any],
) -> dict[str, Any]:
    artifacts = {
        name: runtime._artifact_descriptor(staging / name, file_name=name)  # noqa: SLF001
        for name in (ACTIVE_CATALOG_FILE, ENCODER_FILE, RANKER_FILE, PROTOTYPE_FILE)
    }
    active_sources = _mapping(
        authority.active_catalog.get("source_records"), "active21 sources"
    )
    base_inputs = _mapping(authority.base.contract.get("inputs"), "base inputs")
    candidate_order_sha = runtime._ordered_values_sha256(  # noqa: SLF001
        authority.candidate_ids
    )
    frozen_manifest = str(base_inputs.get("human_export_manifest_sha256", ""))
    if len(frozen_manifest) != 64:
        raise MangaFontV7RuntimeExportError("base frozen-test binding is missing")
    metrics = _mapping(authority.source.manifest.get("best_val"), "source best val")
    contract = {
        "artifacts": artifacts,
        "calibration": {
            "calibration_split": "val",
            "none_threshold": 0.5,
            "none_threshold_selection_metric": "neutral_compatibility_output",
            "temperature": 1.0,
            "temperature_selection_metric": "requires_active21_calibration",
        },
        "catalog": {
            "active_catalog_record_sha256": authority.active_catalog["record_sha256"],
            "candidate_count": len(authority.candidate_ids),
            "candidate_ids": list(authority.candidate_ids),
            "candidate_order_sha256": candidate_order_sha,
            "candidate_parameterization": "prototype-bag-only-no-id-embedding-or-bias",
            "catalog_disposition_record_sha256": active_sources[
                "catalog_disposition_record_sha256"
            ],
            "catalog_registry_sha256": base_inputs["catalog_registry_sha256"],
            "catalog_version": authority.active_catalog["catalog_version"],
            "final_catalog_record_sha256": active_sources["final_catalog_record_sha256"],
            "font_catalog_sha256": active_sources[
                "deployment_font_face_manifest_sha256"
            ],
            "font_prototypes_sha256": runtime.sha256_file(staging / PROTOTYPE_FILE),
            "prototype_bags": [dict(row) for row in authority.candidate_bags],
            "prototype_count": int(authority.packed_prototypes.shape[0]),
            "render_bank_manifest_sha256": active_sources[
                "deployment_render_bank_manifest_sha256"
            ],
            "variant_prototype_layout": {
                "aggregation": "mean_each_active_candidate_bag",
                "candidate_count": len(authority.candidate_ids),
                "feature_offset": LEGACY_FEATURE_DIM,
                "query_count": QUERY_COUNT,
                "query_dim": QUERY_DIM,
            },
        },
        "deployment": {
            "automatic_mutation_allowed": True,
            "fail_closed": True,
            "fallback_policy": copy.deepcopy(base_export.FALLBACK_POLICY),
            "state": "ready",
        },
        "encoder": {
            "branches": {
                "body": "v2_finetuned_pooler_projection256",
                "shared_weights_assumed": False,
                "variant": "pinned_base_patch_tokens_four_query_embeddings1024",
            },
            "class": "DualSiglipVisionModel",
            "fully_frozen": True,
            "model_id": trainer.MODEL_ID,
            "onnx_sha256": artifacts[ENCODER_FILE]["sha256"],
            "revision": trainer.MODEL_REVISION,
            "source_weights_sha256": runtime.sha256_file(
                authority.base.encoder_source_weights
            ),
            "version": "dual-siglip-vision-body-pooler-variant-patch-query-onnx-v1",
        },
        "font_family_evidence": _font_family_evidence_contract(),
        "head": {
            "architecture": {
                "candidate_count": len(authority.candidate_ids),
                "feature_dim": FEATURE_DIM,
                "legacy_feature_dim": LEGACY_FEATURE_DIM,
                "variant_feature_dim": QUERY_FEATURE_DIM,
                "variant_query_count": QUERY_COUNT,
                "variant_query_dim": QUERY_DIM,
            },
            "body_checkpoint_sha256": runtime.sha256_file(
                authority.source.checkpoint_path
            ),
            "family_score_sharing": "candidate_body_variant_exact_alias",
            "onnx_sha256": artifacts[RANKER_FILE]["sha256"],
            "variant_checkpoint_sha256": runtime.sha256_file(
                authority.source.checkpoint_path
            ),
            "version": "manga-font-v7-active21-shared-pixel-ranker-onnx-v1",
        },
        "hybrid_score_routing": hybrid._routing_contract(),  # noqa: SLF001
        "model_version": (
            f"manga-font-v7-active21-{runtime.sha256_file(authority.source.checkpoint_path)[:10]}-"
            f"{candidate_order_sha[:10]}"
        ),
        "onnx_io_contract": _io_contract(authority),
        "policy": base_export._runtime_policy(),  # noqa: SLF001
        "preprocessing": {
            "input_mode": "RGB",
            "input_size_px": [224, 224],
            "processor": {
                "class": "AutoImageProcessor",
                "do_resize": False,
                "use_fast": False,
            },
            "prototype_to_encoder_input": {
                "algorithm": "fontclip-letterbox-rgb-v1",
                "canvas_color_rgb": [255, 255, 255],
                "convert_mode": "RGB",
                "operation": "aspect_preserving_letterbox",
                "placement": "center_floor",
                "resize_filter": "lanczos",
                "rounding": "python_round_then_minimum_1px",
                "target_size_px": [224, 224],
            },
            "sample_views": "verified-rgb-224-passthrough-v1",
        },
        "provenance": {
            "base_checkpoint_sha256": runtime.sha256_file(
                authority.base.checkpoint_path
            ),
            "base_model_contract_sha256": runtime.sha256_file(
                authority.base.student_root / trainer.CONTRACT_FILE
            ),
            "export_validation": copy.deepcopy(dict(parity)),
            "exporter_sha256": runtime.sha256_file(Path(__file__).resolve()),
            "fontquery_fixture_only": authority.source.fixture_only,
            "fontquery_source_quality_gate_passed": (
                authority.source.quality_gate_passed
            ),
            "fontquery_source_kind": authority.source.kind,
            "fontquery_source_manifest_sha256": runtime.sha256_file(
                authority.source.root / authority.source.manifest_name
            ),
            "fontquery_source_prototypes_sha256": runtime.sha256_file(
                authority.source.prototype_path
            ),
            "frozen_test_manifest_sha256": frozen_manifest,
            "source_full22_active_catalog_sha256": runtime.sha256_file(
                authority.base.active_catalog_path
            ),
        },
        "record_type": RECORD_TYPE,
        "release_evaluation": {
            "evaluated_row_count": int(metrics.get("evaluated_positive_rows", 0)),
            "evaluation_report_sha256": runtime.sha256_file(
                authority.source.root / authority.source.manifest_name
            ),
            "metrics": copy.deepcopy(dict(metrics)),
            "test_manifest_sha256": frozen_manifest,
            "thresholds": {},
            "status": (
                "qa_only_r3_projected_export_fixture"
                if authority.source.fixture_only
                else (
                    "v7_active21_source_quality_gate_failed"
                    if not authority.source.quality_gate_passed
                    else "v7_active21_requires_selection_calibration_and_library_qa"
                )
            ),
        },
        "runtime": {
            "execution_provider": runtime.TARGET_ORT_PROVIDER,
            "package": runtime.TARGET_ORT_PACKAGE,
            "version": runtime.TARGET_ORT_VERSION,
        },
        "runtime_batching": hybrid._runtime_batching_contract(),  # noqa: SLF001
        "schema_version": SCHEMA_VERSION,
        "test_data_boundary": hybrid._expected_test_boundary(),  # noqa: SLF001
    }
    return runtime.seal_record(contract)


def _qa_only(authority: V7RuntimeAuthority) -> bool:
    return authority.source.fixture_only or not authority.source.quality_gate_passed


def _marker(authority: V7RuntimeAuthority, staging: Path) -> dict[str, Any]:
    marker: dict[str, Any] = {
        "artifacts": {
            name: runtime.sha256_file(staging / name)
            for name in sorted(OUTPUT_FILES - {MARKER_FILE})
        },
        "owner": OWNER,
        "safe_replace": True,
        "schema_version": SCHEMA_VERSION,
    }
    if _qa_only(authority):
        marker.update({"qa_only": True, "release_approved": False})
    return marker


def _validate_marker(
    root: Path, *, authority: V7RuntimeAuthority
) -> Mapping[str, Any]:
    marker = _read_json(root / MARKER_FILE, "v7 runtime marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA_VERSION
        or (marker.get("qa_only") is True) != _qa_only(authority)
        or (marker.get("release_approved") is False) != _qa_only(authority)
    ):
        raise MangaFontV7RuntimeExportError("v7 runtime marker drifted")
    artifacts = _mapping(marker.get("artifacts"), "v7 runtime marker artifacts")
    if set(artifacts) != set(OUTPUT_FILES - {MARKER_FILE}):
        raise MangaFontV7RuntimeExportError("v7 marker artifact inventory drifted")
    for name in OUTPUT_FILES - {MARKER_FILE}:
        if artifacts.get(name) != runtime.sha256_file(root / name):
            raise MangaFontV7RuntimeExportError(f"v7 marker hash drifted: {name}")
    return marker


def validate_runtime_output(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    v7_output_dir: Path,
    allow_r3_fixture_source: bool,
    output_dir: Path,
    inspect_onnx: bool = True,
) -> Mapping[str, Any]:
    authority = load_v7_runtime_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
        v7_output_dir=v7_output_dir,
        allow_r3_fixture_source=allow_r3_fixture_source,
    )
    root = _safe_output(output_dir)
    _exact_inventory(root)
    _validate_marker(root, authority=authority)
    if (root / PROTOTYPE_FILE).read_bytes() != authority.packed_prototypes.tobytes():
        raise MangaFontV7RuntimeExportError("published active21 prototypes drifted")
    expected_catalog = runtime.json_bytes(authority.active_catalog, pretty=True)
    if (root / ACTIVE_CATALOG_FILE).read_bytes() != expected_catalog:
        raise MangaFontV7RuntimeExportError("published active21 catalog drifted")
    contract = _read_json(root / CONTRACT_FILE, "v7 runtime contract")
    try:
        runtime.validate_record_seal(contract, location="v7 runtime contract")
    except runtime.RuntimeArtifactError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    catalog = _mapping(contract.get("catalog"), "v7 runtime catalog")
    head = _mapping(contract.get("head"), "v7 runtime head")
    architecture = _mapping(head.get("architecture"), "v7 runtime architecture")
    provenance = _mapping(contract.get("provenance"), "v7 runtime provenance")
    evidence = _mapping(contract.get("font_family_evidence"), "v7 family evidence")
    active_sources = _mapping(authority.active_catalog.get("source_records"), "active21 sources")
    if (
        contract.get("schema_version") != SCHEMA_VERSION
        or contract.get("record_type") != RECORD_TYPE
        or tuple(catalog.get("candidate_ids", ())) != authority.candidate_ids
        or catalog.get("candidate_count") != len(authority.candidate_ids)
        or catalog.get("prototype_count") != int(authority.packed_prototypes.shape[0])
        or catalog.get("prototype_bags") != [dict(row) for row in authority.candidate_bags]
        or catalog.get("active_catalog_record_sha256")
        != authority.active_catalog["record_sha256"]
        or catalog.get("catalog_version") != ACTIVE_CATALOG_VERSION
        or catalog.get("font_catalog_sha256")
        != active_sources["deployment_font_face_manifest_sha256"]
        or catalog.get("font_prototypes_sha256")
        != runtime.sha256_file(root / PROTOTYPE_FILE)
        or architecture
        != {
            "candidate_count": len(authority.candidate_ids),
            "feature_dim": FEATURE_DIM,
            "legacy_feature_dim": LEGACY_FEATURE_DIM,
            "variant_feature_dim": QUERY_FEATURE_DIM,
            "variant_query_count": QUERY_COUNT,
            "variant_query_dim": QUERY_DIM,
        }
        or head.get("body_checkpoint_sha256")
        != runtime.sha256_file(authority.source.checkpoint_path)
        or head.get("variant_checkpoint_sha256")
        != runtime.sha256_file(authority.source.checkpoint_path)
        or head.get("family_score_sharing")
        != "candidate_body_variant_exact_alias"
        or dict(evidence) != _font_family_evidence_contract()
        or mass21.RETIRED_FONT_ID in tuple(catalog.get("candidate_ids", ()))
        or provenance.get("fontquery_fixture_only") is not authority.source.fixture_only
        or provenance.get("fontquery_source_quality_gate_passed")
        is not authority.source.quality_gate_passed
        or provenance.get("fontquery_source_kind") != authority.source.kind
        or provenance.get("exporter_sha256")
        != runtime.sha256_file(Path(__file__).resolve())
        or contract.get("hybrid_score_routing") != hybrid._routing_contract()  # noqa: SLF001
        or contract.get("runtime_batching")
        != hybrid._runtime_batching_contract()  # noqa: SLF001
        or contract.get("test_data_boundary")
        != hybrid._expected_test_boundary()  # noqa: SLF001
        or contract.get("onnx_io_contract") != _io_contract(authority)
    ):
        raise MangaFontV7RuntimeExportError("v7 runtime contract/source drifted")
    _validate_parity_record(provenance.get("export_validation"))
    try:
        active = runtime.load_active_catalog(
            root / ACTIVE_CATALOG_FILE, location="runtime active21 catalog"
        )
    except runtime.RuntimeArtifactError as error:
        raise MangaFontV7RuntimeExportError(str(error)) from error
    if (
        tuple(active["candidate_ids"]) != authority.candidate_ids
        or any(row["candidate_id"] == mass21.RETIRED_FONT_ID for row in active["candidates"])
    ):
        raise MangaFontV7RuntimeExportError("runtime active catalog retained Gugi")
    artifacts = _mapping(contract.get("artifacts"), "v7 runtime artifacts")
    for name in (ACTIVE_CATALOG_FILE, ENCODER_FILE, RANKER_FILE, PROTOTYPE_FILE):
        expected = runtime._artifact_descriptor(root / name, file_name=name)  # noqa: SLF001
        if artifacts.get(name) != expected:
            raise MangaFontV7RuntimeExportError(f"v7 artifact descriptor drifted: {name}")
    if inspect_onnx:
        expected_io = _io_contract(authority)
        legacy_export._inspect_graph_file(  # noqa: SLF001
            root / ENCODER_FILE, expected_opset=OPSET_VERSION
        )
        legacy_export._inspect_graph_file(  # noqa: SLF001
            root / RANKER_FILE, expected_opset=OPSET_VERSION
        )
        if (
            runtime._inspect_onnx_contract(root / ENCODER_FILE)  # noqa: SLF001
            != expected_io[ENCODER_FILE]
            or runtime._inspect_onnx_contract(root / RANKER_FILE)  # noqa: SLF001
            != expected_io[RANKER_FILE]
        ):
            raise MangaFontV7RuntimeExportError("v7 ONNX I/O contract drifted")
    return {
        "automatic_mutation_allowed_without_calibration": False,
        "candidate_count": len(authority.candidate_ids),
        "contract_sha256": runtime.sha256_file(root / CONTRACT_FILE),
        "feature_dim": FEATURE_DIM,
        "fixture_only": authority.source.fixture_only,
        "gugi_candidate_count": 0,
        "model_version": contract["model_version"],
        "output_dir": str(root),
        "quality_gate_passed": authority.source.quality_gate_passed,
        "qa_only": _qa_only(authority),
        "selection_calibration_required": True,
        "status": "sealed_v7_active21_base_runtime",
    }


def _commit(
    staging: Path,
    target: Path,
    validate: Any,
    replace: bool,
) -> Mapping[str, Any]:
    if not target.exists():
        os.replace(staging, target)
        try:
            return validate(target)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            raise
    if not replace:
        raise MangaFontV7RuntimeExportError(
            "runtime output exists; pass --replace-owned-output"
        )
    _exact_inventory(target)
    backup = target.with_name(f".{target.name}.backup-{uuid.uuid4().hex}")
    os.replace(target, backup)
    try:
        os.replace(staging, target)
        result = validate(target)
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        os.replace(backup, target)
        raise
    shutil.rmtree(backup)
    return result


def build_runtime_output(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    v7_output_dir: Path,
    allow_r3_fixture_source: bool,
    output_dir: Path,
    electron_path: Path,
    parity_samples: int,
    parity_seed: int,
    wasm_timeout_seconds: int,
    replace_owned_output: bool,
) -> Mapping[str, Any]:
    authority = load_v7_runtime_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
        v7_output_dir=v7_output_dir,
        allow_r3_fixture_source=allow_r3_fixture_source,
    )
    target = _safe_output(output_dir)
    immutable = (
        authority.base.student_root,
        authority.base.active_catalog_path.parent,
        authority.base.encoder_source_dir,
        authority.source.root,
    )
    if any(
        base_export._paths_overlap(target, source)  # noqa: SLF001
        for source in immutable
    ):
        raise MangaFontV7RuntimeExportError(
            "runtime output overlaps an immutable source"
        )
    if target.exists() and not replace_owned_output:
        raise MangaFontV7RuntimeExportError(
            "runtime output exists; pass --replace-owned-output"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        (staging / ACTIVE_CATALOG_FILE).write_bytes(
            runtime.json_bytes(authority.active_catalog, pretty=True)
        )
        (staging / PROTOTYPE_FILE).write_bytes(
            authority.packed_prototypes.tobytes()
        )
        legacy_student, vision, head = _load_models(authority)
        encoder_wrapper, ranker_wrapper = _make_wrappers(
            authority=authority,
            legacy_student=legacy_student,
            vision=vision,
            head=head,
        )
        _export_graphs(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=staging / ENCODER_FILE,
            ranker_path=staging / RANKER_FILE,
        )
        legacy_export._inspect_graph_file(  # noqa: SLF001
            staging / ENCODER_FILE, expected_opset=OPSET_VERSION
        )
        legacy_export._inspect_graph_file(  # noqa: SLF001
            staging / RANKER_FILE, expected_opset=OPSET_VERSION
        )
        expected_io = _io_contract(authority)
        if (
            runtime._inspect_onnx_contract(staging / ENCODER_FILE)  # noqa: SLF001
            != expected_io[ENCODER_FILE]
            or runtime._inspect_onnx_contract(staging / RANKER_FILE)  # noqa: SLF001
            != expected_io[RANKER_FILE]
        ):
            raise MangaFontV7RuntimeExportError("exported ONNX I/O drifted")
        parity = _run_parity(
            encoder_wrapper=encoder_wrapper,
            ranker_wrapper=ranker_wrapper,
            authority=authority,
            encoder_path=staging / ENCODER_FILE,
            ranker_path=staging / RANKER_FILE,
            electron_path=electron_path.expanduser().resolve(),
            sample_count=parity_samples,
            seed=parity_seed,
            wasm_timeout_seconds=wasm_timeout_seconds,
        )
        contract = _build_contract(authority, staging, parity)
        (staging / CONTRACT_FILE).write_bytes(runtime.json_bytes(contract, pretty=True))
        (staging / MARKER_FILE).write_bytes(
            runtime.json_bytes(_marker(authority, staging), pretty=True)
        )
        validate = lambda root: validate_runtime_output(  # noqa: E731
            student_output=student_output,
            active_catalog_path=active_catalog_path,
            encoder_source_dir=encoder_source_dir,
            v7_output_dir=v7_output_dir,
            allow_r3_fixture_source=allow_r3_fixture_source,
            output_dir=root,
        )
        validate(staging)
        return _commit(staging, target, validate, replace_owned_output)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def preflight(
    *,
    student_output: Path,
    active_catalog_path: Path,
    encoder_source_dir: Path,
    v7_output_dir: Path,
    allow_r3_fixture_source: bool,
    electron_path: Path,
) -> Mapping[str, Any]:
    authority = load_v7_runtime_authority(
        student_output=student_output,
        active_catalog_path=active_catalog_path,
        encoder_source_dir=encoder_source_dir,
        v7_output_dir=v7_output_dir,
        allow_r3_fixture_source=allow_r3_fixture_source,
    )
    legacy_export._require_onnx_export_dependency()  # noqa: SLF001
    try:
        import onnxruntime as ort
        import torch
        import transformers
    except ImportError as error:  # pragma: no cover
        raise MangaFontV7RuntimeExportError(
            f"export dependency missing: {error}"
        ) from error
    electron = electron_path.expanduser().resolve()
    if electron.is_symlink() or not electron.is_file():
        raise MangaFontV7RuntimeExportError("pinned Electron is unavailable")
    for label, path in {
        "WASM helper": legacy_export.WASM_HELPER,
        **legacy_export._runtime_asset_paths(),  # noqa: SLF001
    }.items():
        if path.is_symlink() or not path.is_file():
            raise MangaFontV7RuntimeExportError(f"{label} is unavailable: {path}")
    return {
        "candidate_count": len(authority.candidate_ids),
        "electron_version": legacy_export._pinned_electron_version(),  # noqa: SLF001
        "feature_dim": FEATURE_DIM,
        "fixture_only": authority.source.fixture_only,
        "fontquery_checkpoint_sha256": runtime.sha256_file(
            authority.source.checkpoint_path
        ),
        "fontquery_source_kind": authority.source.kind,
        "gugi_candidate_count": 0,
        "onnxruntime_version": ort.__version__,
        "opset": OPSET_VERSION,
        "prototype_count": int(authority.packed_prototypes.shape[0]),
        "quality_gate_passed": authority.source.quality_gate_passed,
        "qa_only": _qa_only(authority),
        "selection_calibration_required": True,
        "status": "ready_for_v7_active21_runtime_export",
        "torch_version": torch.__version__,
        "transformers_version": transformers.__version__,
    }


def _add_source_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--student-output", type=Path, required=True)
    parser.add_argument(
        "--active-catalog", dest="active_catalog_path", type=Path, required=True
    )
    parser.add_argument("--encoder-source-dir", type=Path, required=True)
    parser.add_argument("--v7-output-dir", type=Path, required=True)
    parser.add_argument("--allow-r3-fixture-source", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "build", "validate"):
        command = commands.add_parser(name)
        _add_source_args(command)
        if name in {"build", "validate"}:
            command.add_argument("--output-dir", type=Path, required=True)
        if name in {"preflight", "build"}:
            command.add_argument(
                "--electron-path",
                type=Path,
                default=legacy_export._default_electron_path(),  # noqa: SLF001
            )
        if name == "build":
            command.add_argument(
                "--parity-samples", type=int, default=MIN_PARITY_SAMPLES
            )
            command.add_argument("--parity-seed", type=int, default=20260803)
            command.add_argument("--wasm-timeout-seconds", type=int, default=7200)
            command.add_argument("--replace-owned-output", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    values = vars(args).copy()
    command = values.pop("command")
    try:
        if command == "preflight":
            result = preflight(**values)
        elif command == "build":
            result = build_runtime_output(**values)
        else:
            result = validate_runtime_output(**values)
    except MangaFontV7RuntimeExportError as error:
        print(
            json.dumps(
                {"error": str(error), "status": "blocked"}, ensure_ascii=False
            )
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
