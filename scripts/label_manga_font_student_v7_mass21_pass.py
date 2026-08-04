#!/usr/bin/env python3
"""Run resumable active21 three-view inference over master-v3.

The labeler reads a completed MangaFont v7 mass21/v7-r2/v7-r3 output or, for
bounded pre-release smoke tests only, the sealed v6/r3 query head with its Gugi
prototype projected out.  Raw/context/glyph crops are encoded by the pinned
SigLIP2 vision model and scored only by the visual query head and active21
prototypes.  Gemma, role, genre, chapter, and family priors have exactly zero
logit influence.

It produces two outputs:

* ``review-predictions.jsonl`` for all selected master train/val/test rows;
* ``pseudo-targets.jsonl`` for train rows, directly consumable by
  ``train_manga_font_student_v6_mass21_data.load_pseudo_targets``.

Every record remains pseudo evidence, never gold.  Gugi has no candidate slot.
Completed atomic shards are reused on restart; validation rebinds every shard,
merged file, model source, master row, and authority boundary.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import tempfile
import time
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_font_matching_master as master
    from scripts import build_manga_font_master_v3_siglip2_hidden_cache as hidden_cache
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import label_manga_font_student_pass as legacy_pass
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v6_fontquery as v6
    from scripts import train_manga_font_student_v6_fontquery_r3 as r3
    from scripts import train_manga_font_student_v6_mass21_data as mass21
    from scripts import train_manga_font_student_v7_mass21 as v7
    from scripts import train_manga_font_student_v7_mass21_r2 as v7r2
    from scripts import train_manga_font_student_v7_mass21_r3 as v7r3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_matching_master as master
    import build_manga_font_master_v3_siglip2_hidden_cache as hidden_cache
    import font_matching_catalog_assets as catalog_assets
    import label_manga_font_student_pass as legacy_pass
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v6_fontquery as v6
    import train_manga_font_student_v6_fontquery_r3 as r3
    import train_manga_font_student_v6_mass21_data as mass21
    import train_manga_font_student_v7_mass21 as v7
    import train_manga_font_student_v7_mass21_r2 as v7r2
    import train_manga_font_student_v7_mass21_r3 as v7r3


SCHEMA = "manga-font-student-v7-mass21-pass-v1"
REPORT_SCHEMA = "manga-font-student-v7-mass21-pass-report-v1"
SHARD_SCHEMA = "manga-font-student-v7-mass21-pass-shard-v1"
OWNER = "carrot-manga-translator/manga-font-student-v7-mass21-pass-v1"
MARKER = ".manga-font-student-v7-mass21-pass-v1-owned.json"
REPORT = "report.json"
REVIEW_OUTPUT = "review-predictions.jsonl"
PSEUDO_OUTPUT = "pseudo-targets.jsonl"
SHARD_DIR = "shards"
VALID_SPLITS = frozenset({"train", "val", "test"})
VIEW_NAMES = base.VIEW_NAMES
STYLE_FIELDS = (
    "serifness",
    "weight",
    "width",
    "roundness",
    "stroke_contrast",
    "handwritten",
    "angularity",
    "irregularity",
    "slant",
    "energy",
)
INFLUENCE_FIELDS = ("gemma", "role", "genre", "chapter", "family_prior")
V7_R3_MODEL_SOURCE = "v7_r3_completed"


class MangaFontV7PassError(ValueError):
    """Raised when visual inference or its sealed evidence drifts."""


@dataclass(frozen=True)
class ModelArtifacts:
    source_kind: str
    source_dir: Path
    candidate_ids: tuple[str, ...]
    checkpoint_state: Mapping[str, Any]
    prototypes: np.ndarray
    bindings: Mapping[str, Any]
    promotion_source_allowed: bool


@dataclass
class Runtime:
    torch: Any
    processor: Any | None
    encoder: Any | None
    head: Any
    prototypes: Any
    candidate_ids: tuple[str, ...]
    device: Any
    amp_dtype: Any | None


@dataclass(frozen=True)
class PreviousTargets:
    path: Path | None
    sha256: str | None
    probabilities: Mapping[str, tuple[float, ...]]


@dataclass(frozen=True)
class HiddenCacheBinding:
    root: Path
    build_contract_sha256: str
    cache_identity_sha256: str
    manifest_sha256: str
    master_manifest_sha256: str
    model_contract_sha256: str
    row_count: int
    sample_index_sha256: str
    sample_order_sha256: str
    selected_prefix_order_sha256: str
    view_contract_sha256: str

    def record(self) -> dict[str, Any]:
        return {
            "build_contract_sha256": self.build_contract_sha256,
            "cache_identity_sha256": self.cache_identity_sha256,
            "kind": "sealed_siglip2_last_hidden_state_patch_tokens",
            "manifest_sha256": self.manifest_sha256,
            "master_manifest_sha256": self.master_manifest_sha256,
            "model_contract_sha256": self.model_contract_sha256,
            "row_count": self.row_count,
            "sample_index_sha256": self.sample_index_sha256,
            "sample_order_sha256": self.sample_order_sha256,
            "selected_prefix_order_sha256": self.selected_prefix_order_sha256,
            "tensor_shape": [self.row_count, 3, v7.PATCH_COUNT, v7.HIDDEN_SIZE],
            "view_contract_sha256": self.view_contract_sha256,
        }


@dataclass(frozen=True)
class HiddenCacheReader:
    binding: HiddenCacheBinding
    shards: tuple[Mapping[str, Any], ...]

    def read_rows(
        self, rows: Sequence[legacy_pass.MasterRow]
    ) -> np.ndarray:
        if not rows:
            raise MangaFontV7PassError("cached inference cannot read an empty batch")
        indices = tuple(int(row.row_index) for row in rows)
        expected = tuple(range(indices[0], indices[0] + len(indices)))
        if indices != expected or indices[-1] >= self.binding.row_count:
            raise MangaFontV7PassError(
                "cached inference rows must be an in-range master-order run"
            )
        result = np.empty(
            (len(rows), len(VIEW_NAMES), v7.PATCH_COUNT, v7.HIDDEN_SIZE),
            dtype="<f2",
        )
        cursor = indices[0]
        target_stop = indices[-1] + 1
        while cursor < target_stop:
            descriptor = next(
                (
                    item
                    for item in self.shards
                    if int(item["start_cache_index"])
                    <= cursor
                    < int(item["end_cache_index_exclusive"])
                ),
                None,
            )
            if descriptor is None:
                raise MangaFontV7PassError("hidden cache shard coverage has a gap")
            shard_start = int(descriptor["start_cache_index"])
            shard_stop = int(descriptor["end_cache_index_exclusive"])
            copy_stop = min(shard_stop, target_stop)
            shard_dir = self.binding.root / hidden_cache.SHARDS_DIR / str(
                descriptor["directory"]
            )
            array_path = shard_dir / hidden_cache.SHARD_ARRAY
            try:
                values = np.load(array_path, mmap_mode="r", allow_pickle=False)
            except (OSError, ValueError) as error:
                raise MangaFontV7PassError(
                    "validated hidden cache shard could not be reopened"
                ) from error
            expected_shape = (
                int(descriptor["row_count"]),
                len(VIEW_NAMES),
                v7.PATCH_COUNT,
                v7.HIDDEN_SIZE,
            )
            try:
                if values.dtype != np.dtype("<f2"):
                    raise MangaFontV7PassError(
                        "pooled or non-float16 hidden cache is forbidden"
                    )
                if values.shape == (expected_shape[0], len(VIEW_NAMES), v7.HIDDEN_SIZE):
                    raise MangaFontV7PassError(
                        "pooled (N,3,768) hidden cache is forbidden"
                    )
                if values.shape != expected_shape:
                    raise MangaFontV7PassError("hidden cache shard shape drifted")
                result[cursor - indices[0] : copy_stop - indices[0]] = values[
                    cursor - shard_start : copy_stop - shard_start
                ]
            finally:
                mapped = getattr(values, "_mmap", None)
                if mapped is not None:
                    mapped.close()
            cursor = copy_stop
        if not np.isfinite(result).all():
            raise MangaFontV7PassError("hidden cache batch contains non-finite values")
        return result


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise MangaFontV7PassError(f"{location}: invalid record seal")
    core = dict(record)
    core.pop("record_sha256", None)
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise MangaFontV7PassError(f"{location}: record seal drifted")
    return actual


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV7PassError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise MangaFontV7PassError(f"{location}: expected array")
    return value


def _sealed_model_bindings(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result["model_bindings_sha256"] = sha256_bytes(
        canonical_json(result).encode("utf-8")
    )
    return result


def _validate_v7_r3_model_bindings(
    bindings: Mapping[str, Any], *, location: str
) -> None:
    if bindings.get("source_kind") != V7_R3_MODEL_SOURCE:
        return
    core = copy.deepcopy(dict(bindings))
    declared = core.pop("model_bindings_sha256", None)
    if declared != sha256_bytes(canonical_json(core).encode("utf-8")):
        raise MangaFontV7PassError(f"{location}: model binding seal drifted")
    fingerprint = _mapping(
        bindings.get("source_fingerprint"), f"{location}.source_fingerprint"
    )
    if bindings.get("source_fingerprint_sha256") != sha256_bytes(
        canonical_json(fingerprint).encode("utf-8")
    ):
        raise MangaFontV7PassError(f"{location}: source fingerprint seal drifted")
    required_hashes = (
        "best_head_sha256",
        "checkpoint_sha256",
        "manifest_record_sha256",
        "manifest_sha256",
        "model_bindings_sha256",
        "prototypes_sha256",
        "source_fingerprint_sha256",
        "teacher_checkpoint_sha256",
    )
    if any(
        not isinstance(bindings.get(name), str)
        or len(str(bindings.get(name))) != 64
        for name in required_hashes
    ):
        raise MangaFontV7PassError(f"{location}: required R3 hash binding is invalid")
    if (
        bindings.get("best_head_sha256") != bindings.get("checkpoint_sha256")
        or bindings.get("teacher_checkpoint_sha256")
        != fingerprint.get("r3_checkpoint_sha256")
        or bindings.get("training_schema_version") != v7r3.SCHEMA
    ):
        raise MangaFontV7PassError(f"{location}: R3 source binding drifted")


def _teacher_bindings(
    *,
    artifacts: ModelArtifacts,
    master_manifest_sha256: str,
    previous_pseudo_sha256: str | None,
    round_number: int,
    visual_features: Mapping[str, Any],
) -> dict[str, Any]:
    core = {
        **copy.deepcopy(dict(artifacts.bindings)),
        "master_manifest_sha256": master_manifest_sha256,
        "previous_pseudo_sha256": previous_pseudo_sha256,
        "round": round_number,
        "visual_features": copy.deepcopy(dict(visual_features)),
    }
    if artifacts.bindings.get("source_kind") == V7_R3_MODEL_SOURCE:
        return seal_record(core)
    return core


def _expected_teacher_bindings(
    marker: Mapping[str, Any], *, visual_features: Mapping[str, Any]
) -> dict[str, Any]:
    model_bindings = _mapping(marker.get("model_bindings"), "marker model bindings")
    _validate_v7_r3_model_bindings(model_bindings, location="marker model bindings")
    core = {
        **copy.deepcopy(dict(model_bindings)),
        "master_manifest_sha256": marker.get("master_manifest_sha256"),
        "previous_pseudo_sha256": marker.get("previous_pseudo_sha256"),
        "round": marker.get("round"),
        "visual_features": copy.deepcopy(dict(visual_features)),
    }
    if model_bindings.get("source_kind") == V7_R3_MODEL_SOURCE:
        return seal_record(core)
    return core


def _validate_teacher_bindings(
    value: Any, *, expected: Mapping[str, Any], location: str
) -> None:
    bindings = _mapping(value, location)
    if expected.get("source_kind") == V7_R3_MODEL_SOURCE:
        validate_record_seal(bindings, location=location)
    if dict(bindings) != dict(expected):
        raise MangaFontV7PassError(f"{location}: exact teacher binding drifted")


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise MangaFontV7PassError(f"unsafe output directory: {result}")
    return result


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(raw_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    _atomic_write(
        path,
        (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        ),
    )


def _iter_jsonl(path: Path, *, location: str) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise MangaFontV7PassError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _descriptor(path: Path, *, allow_empty: bool = False) -> dict[str, Any]:
    if (
        path.is_symlink()
        or not path.is_file()
        or (path.stat().st_size < 1 and not allow_empty)
    ):
        raise MangaFontV7PassError(f"missing output file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }


def load_hidden_cache_reader(
    cache_dir: Path,
    *,
    master_dir: Path,
    catalog_registry: Path,
    rows: Sequence[legacy_pass.MasterRow],
    master_manifest_sha256: str,
) -> HiddenCacheReader:
    root = cache_dir.expanduser().resolve()
    try:
        validation = hidden_cache.validate_cache(
            root,
            master_dir=master_dir,
            catalog_registry=catalog_registry,
        )
    except (hidden_cache.HiddenStateCacheError, OSError) as error:
        raise MangaFontV7PassError(f"hidden cache validation failed: {error}") from error
    if not rows:
        raise MangaFontV7PassError("hidden cache requires selected master rows")
    build_contract = base.read_json(
        root / hidden_cache.BUILD_CONTRACT, location="hidden cache build contract"
    )
    manifest = base.read_json(
        root / hidden_cache.MANIFEST, location="hidden cache manifest"
    )
    model = _mapping(build_contract.get("model"), "hidden cache model")
    if (
        model.get("base_model_id") != base.MODEL_ID
        or model.get("base_model_revision") != base.MODEL_REVISION
        or model.get("cached_tensor") != "last_hidden_state"
        or model.get("pooler_output_used") is not False
        or int(model.get("hidden_size", 0)) != v7.HIDDEN_SIZE
        or int(model.get("image_size", 0)) != hidden_cache.IMAGE_SIZE
        or int(model.get("patch_count", 0)) != v7.PATCH_COUNT
        or int(model.get("patch_size", 0)) != hidden_cache.PATCH_SIZE
        or model.get("processor_use_fast") != base.PROCESSOR_USE_FAST
    ):
        raise MangaFontV7PassError("hidden cache model/revision contract drifted")
    views = _mapping(build_contract.get("views"), "hidden cache views")
    tensor = _mapping(build_contract.get("tensor"), "hidden cache tensor")
    if (
        views != hidden_cache._view_contract()  # noqa: SLF001
        or tensor != hidden_cache._tensor_contract()  # noqa: SLF001
        or tuple(str(value) for value in views.get("order", ())) != VIEW_NAMES
        or tensor.get("per_sample_shape")
        != [len(VIEW_NAMES), v7.PATCH_COUNT, v7.HIDDEN_SIZE]
        or tensor.get("representation")
        != "siglip2_vision_last_hidden_state_patch_tokens"
    ):
        raise MangaFontV7PassError("hidden cache view/tensor contract drifted")
    row_count = int(validation.get("row_count", -1))
    if (
        validation.get("status") != "valid_siglip2_last_hidden_state_cache"
        or validation.get("master_manifest_sha256") != master_manifest_sha256
        or validation.get("model_revision") != base.MODEL_REVISION
        or validation.get("training_eligible_by_itself") is not False
        or row_count < len(rows)
        or validation.get("tensor_shape")
        != [row_count, len(VIEW_NAMES), v7.PATCH_COUNT, v7.HIDDEN_SIZE]
    ):
        raise MangaFontV7PassError("hidden cache validation/master boundary drifted")
    expected_model_sha = sha256_bytes(canonical_json(model).encode("utf-8"))
    expected_view_sha = sha256_bytes(canonical_json(views).encode("utf-8"))
    if (
        validation.get("model_contract_sha256") != expected_model_sha
        or validation.get("view_contract_sha256") != expected_view_sha
        or validation.get("build_contract_sha256")
        != sha256_file(root / hidden_cache.BUILD_CONTRACT)
        or validation.get("manifest_sha256")
        != sha256_file(root / hidden_cache.MANIFEST)
        or validation.get("sample_index_sha256")
        != sha256_file(root / hidden_cache.SAMPLE_INDEX)
    ):
        raise MangaFontV7PassError("hidden cache model/view/index SHA drifted")

    matched_rows = 0
    with (root / hidden_cache.SAMPLE_INDEX).open(encoding="utf-8") as handle:
        for cache_index, line in enumerate(handle):
            if not line.strip():
                continue
            try:
                index_row = _mapping(
                    json.loads(line), f"hidden cache index:{cache_index + 1}"
                )
            except json.JSONDecodeError as error:
                raise MangaFontV7PassError("hidden cache index JSON drifted") from error
            try:
                hidden_cache._validate_record_seal(  # noqa: SLF001
                    index_row, f"hidden cache index:{cache_index + 1}"
                )
            except hidden_cache.HiddenStateCacheError as error:
                raise MangaFontV7PassError("hidden cache index seal drifted") from error
            if matched_rows < len(rows):
                expected = rows[matched_rows]
                if (
                    index_row.get("cache_index") != matched_rows
                    or index_row.get("master_row_index") != expected.row_index
                    or index_row.get("sample_id") != expected.sample_id
                    or index_row.get("split") != expected.split
                ):
                    raise MangaFontV7PassError(
                        "hidden cache selected sample identity/order drifted"
                    )
                matched_rows += 1
    if matched_rows != len(rows):
        raise MangaFontV7PassError("hidden cache does not cover selected master rows")
    shards_raw = _sequence(manifest.get("shards"), "hidden cache shards")
    shards = tuple(
        _mapping(value, f"hidden cache shard:{index}")
        for index, value in enumerate(shards_raw)
    )
    prefix_order_sha = sha256_bytes(
        "\n".join(row.sample_id for row in rows).encode("utf-8")
    )
    binding = HiddenCacheBinding(
        root=root,
        build_contract_sha256=str(validation["build_contract_sha256"]),
        cache_identity_sha256=str(validation["cache_identity_sha256"]),
        manifest_sha256=str(validation["manifest_sha256"]),
        master_manifest_sha256=master_manifest_sha256,
        model_contract_sha256=expected_model_sha,
        row_count=row_count,
        sample_index_sha256=str(validation["sample_index_sha256"]),
        sample_order_sha256=str(validation["sample_order_sha256"]),
        selected_prefix_order_sha256=prefix_order_sha,
        view_contract_sha256=expected_view_sha,
    )
    return HiddenCacheReader(binding=binding, shards=shards)


def _read_prototypes(
    path: Path, *, candidate_count: int, query_count: int, query_dim: int
) -> np.ndarray:
    values = np.fromfile(path, dtype="<f4")
    expected = candidate_count * query_count * query_dim
    if values.size != expected or not np.isfinite(values).all():
        raise MangaFontV7PassError("prototype artifact shape/value drifted")
    return np.ascontiguousarray(
        values.reshape(candidate_count, query_count, query_dim), dtype="<f4"
    )


def _load_safetensors(path: Path) -> dict[str, Any]:
    try:
        from safetensors.torch import load_file
    except (ImportError, OSError) as error:  # pragma: no cover
        raise MangaFontV7PassError("safetensors is required") from error
    return dict(load_file(str(path), device="cpu"))


def load_model_artifacts(source_dir: Path, *, source_kind: str) -> ModelArtifacts:
    root = source_dir.expanduser().resolve()
    if source_kind in {"v7", "v7-r2"}:
        validator = v7.validate_output if source_kind == "v7" else v7r2.validate_output
        validator(root)
        manifest = base.read_json(root / v7.MANIFEST, location="v7 pass model")
        candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
        state = _load_safetensors(root / v7.BEST_HEAD)
        prototypes = _read_prototypes(
            root / v7.PROTOTYPES,
            candidate_count=len(candidate_ids),
            query_count=v7.QUERY_COUNT,
            query_dim=v7.QUERY_DIM,
        )
        bindings = {
            "checkpoint_sha256": sha256_file(root / v7.BEST_HEAD),
            "manifest_sha256": sha256_file(root / v7.MANIFEST),
            "prototypes_sha256": sha256_file(root / v7.PROTOTYPES),
            "source_kind": (
                "v7_completed" if source_kind == "v7" else "v7_r2_completed"
            ),
        }
        promotion_allowed = True
    elif source_kind == "v7-r3":
        validation = v7r3.validate_output(root)
        if validation.get("status") != "validated_v7_mass21_r3_teacher_stable_output":
            raise MangaFontV7PassError("R3 validator did not confirm a completed output")
        manifest = base.read_json(root / v7.MANIFEST, location="v7-r3 pass model")
        validate_record_seal(manifest, location="v7-r3 pass model")
        candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
        if (
            manifest.get("schema_version") != v7r3.SCHEMA
            or manifest.get("record_type")
            != "manga_font_student_v7_mass21_r3_teacher_stable_training_manifest"
        ):
            raise MangaFontV7PassError("completed R3 manifest schema drifted")
        source_fingerprint = _mapping(
            manifest.get("source_fingerprint"), "v7-r3 source fingerprint"
        )
        if any(
            not isinstance(source_fingerprint.get(name), str)
            or len(str(source_fingerprint.get(name))) != 64
            for name in ("r3_checkpoint_sha256", "r3_report_sha256")
        ):
            raise MangaFontV7PassError("completed R3 source fingerprint is incomplete")
        descriptors = _mapping(manifest.get("files"), "v7-r3 files")
        artifact_hashes: dict[str, str] = {}
        for name in (v7.BEST_HEAD, v7.PROTOTYPES):
            path = root / name
            descriptor = _mapping(descriptors.get(name), f"v7-r3 files.{name}")
            digest = sha256_file(path)
            if (
                descriptor.get("file") != name
                or descriptor.get("sha256") != digest
                or int(descriptor.get("byte_size", -1)) != path.stat().st_size
            ):
                raise MangaFontV7PassError(f"completed R3 artifact seal drifted: {name}")
            artifact_hashes[name] = digest
        distillation = _mapping(
            manifest.get("distillation"), "v7-r3 distillation"
        )
        teacher_checkpoint_sha256 = source_fingerprint["r3_checkpoint_sha256"]
        if distillation.get("teacher_checkpoint_sha256") != teacher_checkpoint_sha256:
            raise MangaFontV7PassError("completed R3 teacher source binding drifted")
        state = _load_safetensors(root / v7.BEST_HEAD)
        prototypes = _read_prototypes(
            root / v7.PROTOTYPES,
            candidate_count=len(candidate_ids),
            query_count=v7.QUERY_COUNT,
            query_dim=v7.QUERY_DIM,
        )
        checkpoint_sha256 = artifact_hashes[v7.BEST_HEAD]
        bindings = _sealed_model_bindings(
            {
                "best_head_sha256": checkpoint_sha256,
                "checkpoint_sha256": checkpoint_sha256,
                "manifest_record_sha256": manifest["record_sha256"],
                "manifest_sha256": sha256_file(root / v7.MANIFEST),
                "prototypes_sha256": artifact_hashes[v7.PROTOTYPES],
                "source_fingerprint": copy.deepcopy(dict(source_fingerprint)),
                "source_fingerprint_sha256": sha256_bytes(
                    canonical_json(source_fingerprint).encode("utf-8")
                ),
                "source_kind": V7_R3_MODEL_SOURCE,
                "teacher_checkpoint_sha256": teacher_checkpoint_sha256,
                "training_schema_version": v7r3.SCHEMA,
            }
        )
        _validate_v7_r3_model_bindings(bindings, location="loaded v7-r3 bindings")
        promotion_allowed = True
    elif source_kind == "r3-fixture":
        r3.validate_output(root)
        report = base.read_json(root / r3.REPORT, location="r3 pass fixture")
        source_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
        projection = mass21.candidate_projection(source_ids)
        source_prototypes = _read_prototypes(
            root / r3.PROTOTYPES,
            candidate_count=len(source_ids),
            query_count=v7.QUERY_COUNT,
            query_dim=v7.QUERY_DIM,
        )
        candidate_ids = projection.active_ids
        prototypes = np.ascontiguousarray(
            source_prototypes[np.asarray(projection.keep_indices, dtype=np.int64)]
        )
        state = _load_safetensors(root / r3.CHECKPOINT)
        bindings = {
            "checkpoint_sha256": sha256_file(root / r3.CHECKPOINT),
            "report_sha256": sha256_file(root / r3.REPORT),
            "prototypes_sha256": sha256_file(root / r3.PROTOTYPES),
            "source_kind": "r3_active21_fixture_not_promotable",
        }
        promotion_allowed = False
    else:
        raise MangaFontV7PassError(
            "model source kind must be v7, v7-r2, v7-r3, or r3-fixture"
        )
    expected_active = mass21.candidate_projection(
        mass21.legacy15.FULL22_CANDIDATE_IDS
    ).active_ids
    if (
        candidate_ids != expected_active
        or len(candidate_ids) != mass21.ACTIVE_CANDIDATE_COUNT
        or mass21.RETIRED_FONT_ID in candidate_ids
        or prototypes.shape
        != (mass21.ACTIVE_CANDIDATE_COUNT, v7.QUERY_COUNT, v7.QUERY_DIM)
    ):
        raise MangaFontV7PassError("model source did not produce exact active21")
    return ModelArtifacts(
        source_kind=source_kind,
        source_dir=root,
        candidate_ids=candidate_ids,
        checkpoint_state=state,
        prototypes=prototypes,
        bindings=bindings,
        promotion_source_allowed=promotion_allowed,
    )


def build_runtime(
    artifacts: ModelArtifacts,
    *,
    device_name: str,
    amp_name: str,
    load_visual_encoder: bool = True,
) -> Runtime:
    if load_visual_encoder:
        torch, processor_class, vision_class, _save_file = (
            base._load_training_dependencies()  # noqa: SLF001
        )
    else:
        try:
            import torch
        except ImportError as error:  # pragma: no cover - environment dependency
            raise MangaFontV7PassError("PyTorch is required for cached inference") from error
    device = torch.device(device_name)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise MangaFontV7PassError("CUDA is unavailable")
    if device.type not in {"cuda", "cpu"}:
        raise MangaFontV7PassError("device must be cuda or cpu")
    amp_dtype = None
    if device.type == "cuda":
        if amp_name == "bf16":
            if not torch.cuda.is_bf16_supported():
                raise MangaFontV7PassError("CUDA bf16 is unavailable")
            amp_dtype = torch.bfloat16
        elif amp_name == "fp16":
            amp_dtype = torch.float16
        elif amp_name != "none":
            raise MangaFontV7PassError("amp dtype must be bf16, fp16, or none")
    processor = None
    encoder = None
    if load_visual_encoder:
        processor = processor_class.from_pretrained(
            base.MODEL_ID,
            revision=base.MODEL_REVISION,
            use_fast=base.PROCESSOR_USE_FAST,
            local_files_only=True,
        )
        encoder = (
            vision_class.from_pretrained(
                base.MODEL_ID,
                revision=base.MODEL_REVISION,
                local_files_only=True,
            )
            .eval()
            .requires_grad_(False)
            .to(device)
        )
    head = v6.build_font_query_head(
        torch, query_count=v7.QUERY_COUNT, query_dim=v7.QUERY_DIM
    ).to(device)
    head.load_state_dict(artifacts.checkpoint_state, strict=True)
    head.eval().requires_grad_(False)
    prototypes = torch.from_numpy(artifacts.prototypes).to(
        device=device, dtype=torch.float32
    )
    prototypes = torch.nn.functional.normalize(prototypes, p=2, dim=-1)
    return Runtime(
        torch=torch,
        processor=processor,
        encoder=encoder,
        head=head,
        prototypes=prototypes,
        candidate_ids=artifacts.candidate_ids,
        device=device,
        amp_dtype=amp_dtype,
    )


def _amp_context(runtime: Runtime) -> Any:
    torch = runtime.torch
    return (
        torch.autocast(device_type="cuda", dtype=runtime.amp_dtype)
        if runtime.device.type == "cuda" and runtime.amp_dtype is not None
        else nullcontext()
    )


def _score_patch_tokens(
    runtime: Runtime, tokens: Any, *, batch_size: int
) -> dict[str, np.ndarray]:
    torch = runtime.torch
    expected = (batch_size * len(VIEW_NAMES), v7.PATCH_COUNT, v7.HIDDEN_SIZE)
    if tuple(tokens.shape) == (
        batch_size * len(VIEW_NAMES),
        v7.HIDDEN_SIZE,
    ):
        raise MangaFontV7PassError(
            "pooled (N,3,768) features are forbidden for visual-query inference"
        )
    if tuple(tokens.shape) != expected or not bool(torch.isfinite(tokens).all()):
        raise MangaFontV7PassError(
            f"visual patch-token shape/value drifted: {tuple(tokens.shape)}"
        )
    with torch.inference_mode(), _amp_context(runtime):
        encoded, _attention = runtime.head.encode(tokens)
        views = encoded.reshape(
            batch_size,
            len(VIEW_NAMES),
            v7.QUERY_COUNT,
            v7.QUERY_DIM,
        )
        samples = torch.nn.functional.normalize(views.mean(dim=1), p=2, dim=-1)
        sample_per_query = torch.einsum(
            "bqd,cqd->bcq", samples, runtime.prototypes
        )
        view_per_query = torch.einsum(
            "bvqd,cqd->bvcq", views, runtime.prototypes
        )
        query_weights = torch.softmax(runtime.head.query_weight_logits.float(), dim=0)
        scale = runtime.head.logit_scale.float().exp().clamp(max=100.0)
        scores = scale * torch.einsum("bcq,q->bc", sample_per_query, query_weights)
        view_scores = scale * torch.einsum(
            "bvcq,q->bvc", view_per_query, query_weights
        )
    result = {
        "scores": scores.detach().float().cpu().numpy(),
        "view_scores": view_scores.detach().float().cpu().numpy(),
    }
    if any(not np.isfinite(values).all() for values in result.values()):
        raise MangaFontV7PassError("model produced non-finite visual scores")
    return result


def infer_images(runtime: Runtime, images: Sequence[Any]) -> dict[str, np.ndarray]:
    if not images or len(images) % len(VIEW_NAMES) != 0:
        raise MangaFontV7PassError("inference requires complete three-view rows")
    if runtime.processor is None or runtime.encoder is None:
        raise MangaFontV7PassError("raw-image inference runtime lacks encoder/processor")
    torch = runtime.torch
    processed = runtime.processor(
        images=list(images),
        return_tensors="pt",
        do_resize=False,
        do_convert_rgb=True,
    )
    pixels = processed["pixel_values"].to(runtime.device, non_blocking=False)
    with torch.inference_mode(), _amp_context(runtime):
        tokens = runtime.encoder(pixel_values=pixels).last_hidden_state
    return _score_patch_tokens(
        runtime, tokens, batch_size=len(images) // len(VIEW_NAMES)
    )


def infer_hidden_states(
    runtime: Runtime, hidden_states: np.ndarray
) -> dict[str, np.ndarray]:
    values = np.asarray(hidden_states)
    if values.ndim == 3 and values.shape[1:] == (
        len(VIEW_NAMES),
        v7.HIDDEN_SIZE,
    ):
        raise MangaFontV7PassError(
            "pooled (N,3,768) hidden cache is forbidden"
        )
    expected_tail = (len(VIEW_NAMES), v7.PATCH_COUNT, v7.HIDDEN_SIZE)
    if (
        values.ndim != 4
        or values.shape[1:] != expected_tail
        or values.dtype != np.dtype("<f2")
        or not np.isfinite(values).all()
    ):
        raise MangaFontV7PassError(
            "cached inference requires finite (N,3,196,768) float16 tokens"
        )
    contiguous = np.ascontiguousarray(values, dtype="<f2")
    tokens = runtime.torch.from_numpy(contiguous).to(
        device=runtime.device, non_blocking=False
    )
    return _score_patch_tokens(
        runtime,
        tokens.reshape(-1, v7.PATCH_COUNT, v7.HIDDEN_SIZE),
        batch_size=values.shape[0],
    )


def softmax(values: np.ndarray, *, temperature: float) -> np.ndarray:
    if not math.isfinite(temperature) or temperature <= 0.0:
        raise MangaFontV7PassError("temperature must be positive and finite")
    scaled = np.asarray(values, dtype=np.float64) / temperature
    scaled -= np.max(scaled, axis=-1, keepdims=True)
    exponent = np.exp(scaled)
    return (exponent / exponent.sum(axis=-1, keepdims=True)).astype(np.float32)


def ensemble_probabilities(
    current: np.ndarray,
    previous: Sequence[float] | None,
    *,
    previous_weight: float,
) -> np.ndarray:
    values = np.asarray(current, dtype=np.float64)
    if values.shape != (mass21.ACTIVE_CANDIDATE_COUNT,):
        raise MangaFontV7PassError("current probability shape drifted")
    if previous is not None:
        old = np.asarray(previous, dtype=np.float64)
        if old.shape != values.shape:
            raise MangaFontV7PassError("previous probability shape drifted")
        values = (1.0 - previous_weight) * values + previous_weight * old
    values = np.clip(values, 0.0, None)
    total = float(values.sum())
    if not math.isfinite(total) or total <= 0.0:
        raise MangaFontV7PassError("ensemble probability simplex is invalid")
    return np.ascontiguousarray(values / total, dtype=np.float32)


def probability_evidence(
    probabilities: np.ndarray, view_probabilities: np.ndarray
) -> dict[str, Any]:
    if (
        probabilities.shape != (mass21.ACTIVE_CANDIDATE_COUNT,)
        or view_probabilities.shape
        != (len(VIEW_NAMES), mass21.ACTIVE_CANDIDATE_COUNT)
    ):
        raise MangaFontV7PassError("probability evidence shape drifted")
    order = np.argsort(-probabilities, kind="stable")
    margin = float(probabilities[order[0]] - probabilities[order[1]])
    safe = np.clip(probabilities.astype(np.float64), 1e-12, 1.0)
    normalized_entropy = float(-np.sum(safe * np.log(safe)) / math.log(len(safe)))
    view_top1 = np.argmax(view_probabilities, axis=1)
    counts = Counter(int(value) for value in view_top1.tolist())
    majority = max(counts.values())
    top1_disagreement = 1.0 - majority / len(VIEW_NAMES)
    mean_view = np.clip(view_probabilities.mean(axis=0), 1e-12, 1.0)
    safe_views = np.clip(view_probabilities.astype(np.float64), 1e-12, 1.0)
    js = float(
        np.mean(np.sum(safe_views * (np.log(safe_views) - np.log(mean_view)), axis=1))
        / math.log(len(safe))
    )
    entropy_certainty = 1.0 - min(max(normalized_entropy, 0.0), 1.0)
    margin_certainty = min(max(margin * 5.0, 0.0), 1.0)
    agreement = 1.0 - min(max(top1_disagreement, 0.0), 1.0)
    confidence = min(
        max(0.50 * entropy_certainty + 0.30 * margin_certainty + 0.20 * agreement, 0.0),
        1.0,
    )
    weight = min(max(confidence * (1.0 - 0.5 * min(max(js, 0.0), 1.0)), 0.0), 1.0)
    return {
        "confidence": confidence,
        "entropy": normalized_entropy,
        "margin": margin,
        "order": order,
        "view_js_divergence": js,
        "view_top1_indices": view_top1,
        "view_top1_disagreement": top1_disagreement,
        "weight": weight,
    }


def _rounded_probabilities(values: Sequence[float]) -> list[float]:
    return [round(float(value), 10) for value in values]


def _top5(
    candidate_ids: Sequence[str], probabilities: np.ndarray, order: np.ndarray
) -> list[dict[str, Any]]:
    return [
        {
            "font_id": candidate_ids[int(index)],
            "probability": round(float(probabilities[index]), 10),
            "rank": rank,
            "score": round(float(math.log(max(float(probabilities[index]), 1e-12))), 8),
        }
        for rank, index in enumerate(order[:5], 1)
    ]


def build_records(
    row: legacy_pass.MasterRow,
    *,
    candidate_ids: tuple[str, ...],
    scores: np.ndarray,
    view_scores: np.ndarray,
    temperature: float,
    previous: Sequence[float] | None,
    previous_weight: float,
    round_number: int,
    teacher_bindings: Mapping[str, Any],
    model_source_kind: str,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    current = softmax(scores[None, :], temperature=temperature)[0]
    view_probabilities = softmax(view_scores, temperature=temperature)
    probabilities = ensemble_probabilities(
        current, previous, previous_weight=previous_weight
    )
    evidence = probability_evidence(probabilities, view_probabilities)
    order = evidence["order"]
    selected = candidate_ids[int(order[0])]
    view_top1_ids = [
        candidate_ids[int(index)] for index in evidence["view_top1_indices"]
    ]
    glyph_selected = view_top1_ids[VIEW_NAMES.index("glyph_224")]
    top5 = _top5(candidate_ids, probabilities, order)
    dense = _rounded_probabilities(probabilities)
    influence = {name: 0.0 for name in INFLUENCE_FIELDS}
    review = seal_record(
        {
            "candidate_count": len(candidate_ids),
            "candidate_ids": list(candidate_ids),
            "chapter_id": row.chapter_id,
            "chapter_title": row.chapter_title,
            "confidence": round(float(evidence["confidence"]), 8),
            "direct_reference": {
                "selected_font_id": glyph_selected,
                "source": "glyph_view_visual_query_top1",
            },
            "entropy": round(float(evidence["entropy"]), 8),
            "family_logit_influence": influence,
            "gugi_probability": 0.0,
            "label_authority": "pseudo_not_gold",
            "label_status": f"pseudo_visual_mass21_round_{round_number}",
            "master_row_sha256": row.row_sha256,
            "model_source_kind": model_source_kind,
            "page_id": row.page_id,
            "page_name": row.page_name,
            "probabilities": dense,
            "probability_source": (
                "visual_query_ema_previous_dense"
                if previous is not None
                else "visual_query_current"
            ),
            "promotion_allowed": False,
            "ranker": {
                "selected_font_id": selected,
                "top1_margin": round(float(evidence["margin"]), 8),
                "top5": top5,
            },
            "role": {"top3": [{"confidence": 0.0, "role": "unknown"}]},
            "round": round_number,
            "sample_id": row.sample_id,
            "schema_version": SCHEMA,
            "selected_font_id": selected,
            "source_category": row.source_category,
            "source_kind": row.source_kind,
            "source_row_index": row.row_index,
            "split": row.split,
            "style": {name: 0.5 for name in STYLE_FIELDS},
            "teacher_bindings": copy.deepcopy(dict(teacher_bindings)),
            "top5": top5,
            "training_eligible": False,
            "view_disagreement": {
                "js_divergence": round(float(evidence["view_js_divergence"]), 8),
                "top1_candidate_ids": view_top1_ids,
                "top1_disagreement": round(
                    float(evidence["view_top1_disagreement"]), 8
                ),
            },
            "weight": round(float(evidence["weight"]), 8),
            "work_id": row.work_id,
            "work_title": row.work_title,
        }
    )
    pseudo = None
    if row.split == "train":
        pseudo = seal_record(
            {
                "candidate_ids": list(candidate_ids),
                "label_authority": "pseudo_soft_not_gold",
                "master_row_sha256": row.row_sha256,
                "probabilities": dense,
                "round": round_number,
                "sample_id": row.sample_id,
                "schema_version": mass21.PSEUDO_SCHEMA,
                "source_category": row.source_category,
                "split": "train",
                "teacher_bindings": copy.deepcopy(dict(teacher_bindings)),
                "training_eligible": False,
                "weight": round(float(evidence["weight"]), 8),
                "work_id": row.work_id,
            }
        )
    return review, pseudo


def load_previous_targets(
    path: Path | None, *, candidate_ids: tuple[str, ...]
) -> PreviousTargets:
    if path is None:
        return PreviousTargets(None, None, {})
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise MangaFontV7PassError("previous pseudo file is missing or linked")
    values: dict[str, tuple[float, ...]] = {}
    for line_number, row in enumerate(
        _iter_jsonl(source, location="previous pseudo"), 1
    ):
        if (
            row.get("schema_version") != mass21.PSEUDO_SCHEMA
            or row.get("split") != "train"
            or tuple(str(value) for value in row.get("candidate_ids", ()))
            != candidate_ids
            or row.get("label_authority") != "pseudo_soft_not_gold"
        ):
            raise MangaFontV7PassError(
                f"previous pseudo:{line_number}: contract drifted"
            )
        sample_id = str(row.get("sample_id", ""))
        probabilities = tuple(float(value) for value in row.get("probabilities", ()))
        if (
            not sample_id
            or sample_id in values
            or len(probabilities) != len(candidate_ids)
            or any(not math.isfinite(value) or value < 0.0 for value in probabilities)
            or not math.isclose(sum(probabilities), 1.0, abs_tol=1e-5, rel_tol=0.0)
        ):
            raise MangaFontV7PassError(
                f"previous pseudo:{line_number}: invalid probability row"
            )
        values[sample_id] = probabilities
    if not values:
        raise MangaFontV7PassError("previous pseudo input is empty")
    return PreviousTargets(source, sha256_file(source), values)


def _validate_master_contract(master_dir: Path, catalog_registry: Path) -> str:
    root = master_dir.expanduser().resolve()
    report = base.read_json(root / "report.json", location="master-v3 report")
    statistics = _mapping(report.get("statistics"), "master-v3 statistics")
    by_split = _mapping(statistics.get("by_split"), "master-v3 split counts")
    outputs = _mapping(report.get("outputs"), "master-v3 outputs")
    manifest_path = root / "manifest.jsonl"
    manifest_sha = sha256_file(manifest_path)
    if (
        int(statistics.get("record_count", -1)) != mass21.MASTER_TOTAL_ROWS
        or dict(by_split)
        != {
            "test": mass21.MASTER_TEST_ROWS,
            "train": mass21.MASTER_TRAIN_ROWS,
            "val": mass21.MASTER_VAL_ROWS,
        }
        or outputs.get("master_manifest_sha256") != manifest_sha
        or report.get("tool") != master.TOOL_ID
    ):
        raise MangaFontV7PassError("master-v3 report/count binding drifted")
    registry_sha = sha256_file(catalog_registry.expanduser().resolve())
    attestation = _mapping(
        _mapping(report.get("inputs"), "master-v3 inputs").get("attestation"),
        "master-v3 attestation",
    )
    registry_binding = _mapping(
        attestation.get("catalog_registry"), "master-v3 catalog registry"
    )
    if registry_binding.get("sha256") != registry_sha:
        raise MangaFontV7PassError("master-v3 catalog registry binding drifted")
    return manifest_sha


def _marker_core(
    *,
    args: argparse.Namespace,
    artifacts: ModelArtifacts,
    master_sha256: str,
    previous: PreviousTargets,
    visual_features: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "amp_dtype": args.amp_dtype,
        "batch_size": args.batch_size,
        "candidate_ids": list(artifacts.candidate_ids),
        "master_manifest_sha256": master_sha256,
        "max_samples": args.max_samples,
        "model_bindings": copy.deepcopy(dict(artifacts.bindings)),
        "owner": OWNER,
        "previous_pseudo_sha256": previous.sha256,
        "previous_weight": args.previous_weight,
        "promotion_source_allowed": artifacts.promotion_source_allowed,
        "round": args.round,
        "safe_replace": True,
        "schema_version": SCHEMA,
        "shard_size": args.shard_size,
        "source_code_sha256": sha256_file(Path(__file__).resolve()),
        "temperature": args.temperature,
        "visual_features": copy.deepcopy(dict(visual_features)),
    }


def _ensure_output(root: Path, marker_core: Mapping[str, Any]) -> Path:
    output = _safe_output(root)
    if output.exists() and (output.is_symlink() or not output.is_dir()):
        raise MangaFontV7PassError("output exists but is not a safe directory")
    output.mkdir(parents=True, exist_ok=True)
    marker_path = output / MARKER
    expected = seal_record(marker_core)
    if marker_path.exists():
        marker = base.read_json(marker_path, location="v7 pass marker")
        validate_record_seal(marker, location="v7 pass marker")
        if marker != expected:
            raise MangaFontV7PassError("output marker is bound to another run")
    else:
        if any(output.iterdir()):
            raise MangaFontV7PassError("non-empty output lacks ownership marker")
        _atomic_json(marker_path, expected)
    shards = output / SHARD_DIR
    shards.mkdir(exist_ok=True)
    return output


def _shard_paths(root: Path, index: int) -> tuple[Path, Path, Path]:
    shards = root / SHARD_DIR
    stem = f"shard-{index:05d}"
    return (
        shards / f"{stem}-review.jsonl",
        shards / f"{stem}-pseudo.jsonl",
        shards / f"{stem}.json",
    )


def _shard_core(
    index: int,
    rows: Sequence[legacy_pass.MasterRow],
    *,
    marker_sha256: str,
) -> dict[str, Any]:
    return {
        "first_source_row_index": rows[0].row_index,
        "last_source_row_index": rows[-1].row_index,
        "marker_sha256": marker_sha256,
        "row_count": len(rows),
        "sample_ids_sha256": sha256_bytes(
            ("\n".join(row.sample_id for row in rows) + "\n").encode("utf-8")
        ),
        "schema_version": SHARD_SCHEMA,
        "shard_index": index,
        "train_row_count": sum(row.split == "train" for row in rows),
    }


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    payload = b"".join((canonical_json(row) + "\n").encode("utf-8") for row in rows)
    if rows and not payload:
        raise MangaFontV7PassError("refusing empty JSONL payload")
    _atomic_write(path, payload)


def _valid_shard(
    paths: tuple[Path, Path, Path],
    *,
    core: Mapping[str, Any],
    rows: Sequence[legacy_pass.MasterRow],
) -> bool:
    review_path, pseudo_path, metadata_path = paths
    try:
        if any(path.is_symlink() or not path.is_file() for path in paths):
            return False
        metadata = base.read_json(metadata_path, location="v7 pass shard")
        validate_record_seal(metadata, location="v7 pass shard")
        if any(metadata.get(key) != value for key, value in core.items()):
            return False
        if (
            metadata.get("review_sha256") != sha256_file(review_path)
            or metadata.get("pseudo_sha256") != sha256_file(pseudo_path)
        ):
            return False
        reviews = list(_iter_jsonl(review_path, location="shard review"))
        pseudos = list(_iter_jsonl(pseudo_path, location="shard pseudo"))
        if len(reviews) != len(rows) or len(pseudos) != core["train_row_count"]:
            return False
        pseudo_index = 0
        for review, expected in zip(reviews, rows, strict=True):
            validate_record_seal(review, location="shard review")
            if (
                review.get("sample_id") != expected.sample_id
                or review.get("split") != expected.split
                or review.get("training_eligible") is not False
            ):
                return False
            if expected.split == "train":
                pseudo = pseudos[pseudo_index]
                pseudo_index += 1
                validate_record_seal(pseudo, location="shard pseudo")
                if pseudo.get("sample_id") != expected.sample_id:
                    return False
        return True
    except (OSError, ValueError, TypeError, MangaFontV7PassError):
        return False


def _infer_shard(
    *,
    runtime: Runtime,
    resolver: Any | None,
    hidden_reader: HiddenCacheReader | None,
    rows: Sequence[legacy_pass.MasterRow],
    batch_size: int,
    temperature: float,
    previous: PreviousTargets,
    previous_weight: float,
    round_number: int,
    teacher_bindings: Mapping[str, Any],
    model_source_kind: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if (resolver is None) == (hidden_reader is None):
        raise MangaFontV7PassError(
            "inference must use exactly one of raw pixels or sealed hidden cache"
        )
    reviews: list[dict[str, Any]] = []
    pseudos: list[dict[str, Any]] = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        if hidden_reader is not None:
            output = infer_hidden_states(runtime, hidden_reader.read_rows(batch))
        else:
            assert resolver is not None
            images: list[Any] = []
            try:
                for row in batch:
                    for view_name in VIEW_NAMES:
                        with resolver.resolve_sample_view(
                            row.resolver_sample, view_name
                        ) as resolved:
                            if resolved.mode != "RGB" or resolved.size != (224, 224):
                                raise MangaFontV7PassError(
                                    f"{row.sample_id}/{view_name}: invalid visual pixels"
                                )
                            images.append(resolved.image.copy())
                output = infer_images(runtime, images)
            finally:
                for image in images:
                    image.close()
        for offset, row in enumerate(batch):
            review, pseudo = build_records(
                row,
                candidate_ids=runtime.candidate_ids,
                scores=output["scores"][offset],
                view_scores=output["view_scores"][offset],
                temperature=temperature,
                previous=previous.probabilities.get(row.sample_id),
                previous_weight=previous_weight,
                round_number=round_number,
                teacher_bindings=teacher_bindings,
                model_source_kind=model_source_kind,
            )
            reviews.append(review)
            if pseudo is not None:
                pseudos.append(pseudo)
    return reviews, pseudos


def _write_shard(
    paths: tuple[Path, Path, Path],
    *,
    core: Mapping[str, Any],
    reviews: Sequence[Mapping[str, Any]],
    pseudos: Sequence[Mapping[str, Any]],
) -> None:
    review_path, pseudo_path, metadata_path = paths
    if len(reviews) != core["row_count"] or len(pseudos) != core["train_row_count"]:
        raise MangaFontV7PassError("shard output counts drifted")
    _write_jsonl(review_path, reviews)
    _write_jsonl(pseudo_path, pseudos)
    metadata = seal_record(
        {
            **dict(core),
            "pseudo_file": pseudo_path.name,
            "pseudo_sha256": sha256_file(pseudo_path),
            "review_file": review_path.name,
            "review_sha256": sha256_file(review_path),
        }
    )
    _atomic_json(metadata_path, metadata)


def _merge_and_report(
    *,
    root: Path,
    rows: Sequence[legacy_pass.MasterRow],
    shard_paths: Sequence[tuple[Path, Path, Path]],
    marker: Mapping[str, Any],
    artifacts: ModelArtifacts,
    previous: PreviousTargets,
    elapsed_seconds: float,
) -> Mapping[str, Any]:
    review_target = root / REVIEW_OUTPUT
    pseudo_target = root / PSEUDO_OUTPUT
    review_temp = review_target.with_name(f".{review_target.name}.merge")
    pseudo_temp = pseudo_target.with_name(f".{pseudo_target.name}.merge")
    split_counts: Counter[str] = Counter()
    font_counts: Counter[str] = Counter()
    margins: list[float] = []
    confidences: list[float] = []
    weights: list[float] = []
    review_count = 0
    pseudo_count = 0
    try:
        with review_temp.open("wb") as review_output, pseudo_temp.open("wb") as pseudo_output:
            for review_path, pseudo_path, _metadata in shard_paths:
                for record in _iter_jsonl(review_path, location="merge review"):
                    expected = rows[review_count]
                    validate_record_seal(record, location="merge review")
                    if record.get("sample_id") != expected.sample_id:
                        raise MangaFontV7PassError("review merge order drifted")
                    review_output.write((canonical_json(record) + "\n").encode("utf-8"))
                    split_counts[str(record["split"])] += 1
                    font_counts[str(record["selected_font_id"])] += 1
                    ranker = _mapping(record.get("ranker"), "merge ranker")
                    margins.append(float(ranker["top1_margin"]))
                    confidences.append(float(record["confidence"]))
                    weights.append(float(record["weight"]))
                    review_count += 1
                for record in _iter_jsonl(pseudo_path, location="merge pseudo"):
                    validate_record_seal(record, location="merge pseudo")
                    pseudo_output.write((canonical_json(record) + "\n").encode("utf-8"))
                    pseudo_count += 1
            review_output.flush()
            pseudo_output.flush()
            os.fsync(review_output.fileno())
            os.fsync(pseudo_output.fileno())
        if review_count != len(rows) or pseudo_count != split_counts["train"]:
            raise MangaFontV7PassError("merged output inventory drifted")
        os.replace(review_temp, review_target)
        os.replace(pseudo_temp, pseudo_target)
    finally:
        for path in (review_temp, pseudo_temp):
            if path.exists():
                path.unlink()
    report = seal_record(
        {
            "artifacts": {
                "pseudo_targets": _descriptor(pseudo_target),
                "review_predictions": _descriptor(review_target),
                "shards": [
                    {
                        "metadata": _descriptor(metadata),
                        "pseudo": _descriptor(pseudo, allow_empty=True),
                        "review": _descriptor(review),
                    }
                    for review, pseudo, metadata in shard_paths
                ],
            },
            "authority": {
                "human_gold_inputs_read": 0,
                "label_authority": "pseudo_not_gold",
                "promotion_allowed_rows": 0,
                "test_training_eligible_rows": 0,
                "training_eligible_rows": 0,
                "val_training_eligible_rows": 0,
            },
            "candidate_ids": list(artifacts.candidate_ids),
            "counts": {
                "font_top1": dict(sorted(font_counts.items())),
                "pseudo_train_rows": pseudo_count,
                "review_rows": review_count,
                "splits": dict(sorted(split_counts.items())),
            },
            "distribution": {
                "confidence_mean": float(np.mean(confidences)),
                "margin_mean": float(np.mean(margins)),
                "weight_mean": float(np.mean(weights)),
            },
            "gugi_probability_mass": 0.0,
            "marker_record_sha256": marker["record_sha256"],
            "model": {
                **copy.deepcopy(dict(artifacts.bindings)),
                "promotion_source_allowed": artifacts.promotion_source_allowed,
            },
            "nonvisual_logit_influence": {name: 0.0 for name in INFLUENCE_FIELDS},
            "previous_pseudo": {
                "row_count": len(previous.probabilities),
                "sha256": previous.sha256,
            },
            "record_type": "manga_font_student_v7_mass21_pass_report",
            "schema_version": REPORT_SCHEMA,
            "source_code_sha256": sha256_file(Path(__file__).resolve()),
            "timing_seconds": elapsed_seconds,
            "visual_features": copy.deepcopy(
                dict(_mapping(marker.get("visual_features"), "marker visual features"))
            ),
        }
    )
    _atomic_json(root / REPORT, report)
    return report


def label(args: argparse.Namespace) -> Mapping[str, Any]:
    if args.batch_size < 1 or args.shard_size < 1:
        raise MangaFontV7PassError("batch and shard sizes must be positive")
    if args.round < 1:
        raise MangaFontV7PassError("round must be positive")
    if not 0.0 <= args.previous_weight < 1.0:
        raise MangaFontV7PassError("previous weight must be inside [0,1)")
    if args.max_samples < 0:
        raise MangaFontV7PassError("max samples must be nonnegative")
    started = time.monotonic()
    artifacts = load_model_artifacts(args.model_dir, source_kind=args.model_source)
    previous = load_previous_targets(
        args.previous_pseudo, candidate_ids=artifacts.candidate_ids
    )
    master_sha = _validate_master_contract(
        args.master_dir, args.catalog_registry
    )
    rows, loaded_sha = legacy_pass.load_master_rows(
        args.master_dir.expanduser().resolve() / "manifest.jsonl", VALID_SPLITS
    )
    if loaded_sha != master_sha or len(rows) != mass21.MASTER_TOTAL_ROWS:
        raise MangaFontV7PassError("master-v3 loaded inventory drifted")
    if args.max_samples:
        rows = rows[: args.max_samples]
    hidden_reader: HiddenCacheReader | None = None
    if args.hidden_cache_dir is not None:
        hidden_reader = load_hidden_cache_reader(
            args.hidden_cache_dir,
            master_dir=args.master_dir,
            catalog_registry=args.catalog_registry,
            rows=rows,
            master_manifest_sha256=master_sha,
        )
        visual_features = hidden_reader.binding.record()
    else:
        raw_contract = {
            "base_model_id": base.MODEL_ID,
            "base_model_revision": base.MODEL_REVISION,
            "kind": "live_pinned_siglip2_raw_pixels",
            "processor_use_fast": base.PROCESSOR_USE_FAST,
            "view_order": list(VIEW_NAMES),
        }
        visual_features = {
            **raw_contract,
            "contract_sha256": sha256_bytes(
                canonical_json(raw_contract).encode("utf-8")
            ),
        }
    marker_core = _marker_core(
        args=args,
        artifacts=artifacts,
        master_sha256=master_sha,
        previous=previous,
        visual_features=visual_features,
    )
    root = _ensure_output(args.output_dir, marker_core)
    marker = base.read_json(root / MARKER, location="v7 pass marker")
    marker_sha = marker["record_sha256"]
    shards: list[
        tuple[
            tuple[Path, Path, Path],
            Mapping[str, Any],
            Sequence[legacy_pass.MasterRow],
        ]
    ] = []
    for shard_index, start in enumerate(range(0, len(rows), args.shard_size)):
        shard_rows = rows[start : start + args.shard_size]
        paths = _shard_paths(root, shard_index)
        core = _shard_core(shard_index, shard_rows, marker_sha256=marker_sha)
        shards.append((paths, core, shard_rows))
    reuse = [
        _valid_shard(paths, core=core, rows=shard_rows)
        for paths, core, shard_rows in shards
    ]
    runtime: Runtime | None = None
    resolver: Any | None = None
    teacher_bindings = _teacher_bindings(
        artifacts=artifacts,
        master_manifest_sha256=master_sha,
        previous_pseudo_sha256=previous.sha256,
        round_number=args.round,
        visual_features=visual_features,
    )
    if not all(reuse):
        runtime = build_runtime(
            artifacts,
            device_name=args.device,
            amp_name=args.amp_dtype,
            load_visual_encoder=hidden_reader is None,
        )
        if hidden_reader is None:
            resolver = catalog_assets.CatalogAssetResolver(args.catalog_registry)
    for index, ((paths, core, shard_rows), reused) in enumerate(
        zip(shards, reuse, strict=True), 1
    ):
        if reused:
            print(f"v7 pass shard {index}/{len(shards)}: reuse", flush=True)
            continue
        assert runtime is not None and (resolver is not None or hidden_reader is not None)
        reviews, pseudos = _infer_shard(
            runtime=runtime,
            resolver=resolver,
            hidden_reader=hidden_reader,
            rows=shard_rows,
            batch_size=args.batch_size,
            temperature=args.temperature,
            previous=previous,
            previous_weight=args.previous_weight,
            round_number=args.round,
            teacher_bindings=teacher_bindings,
            model_source_kind=artifacts.source_kind,
        )
        _write_shard(paths, core=core, reviews=reviews, pseudos=pseudos)
        print(
            f"v7 pass shard {index}/{len(shards)}: inferred {len(shard_rows)}",
            flush=True,
        )
    _merge_and_report(
        root=root,
        rows=rows,
        shard_paths=[paths for paths, _core, _rows in shards],
        marker=marker,
        artifacts=artifacts,
        previous=previous,
        elapsed_seconds=time.monotonic() - started,
    )
    return validate_output(root)


def _validate_probability_row(
    row: Mapping[str, Any], *, candidate_ids: tuple[str, ...], location: str
) -> None:
    declared = tuple(str(value) for value in row.get("candidate_ids", ()))
    probabilities = tuple(float(value) for value in row.get("probabilities", ()))
    if (
        declared != candidate_ids
        or len(probabilities) != len(candidate_ids)
        or any(not math.isfinite(value) or not 0.0 <= value <= 1.0 for value in probabilities)
        or not math.isclose(sum(probabilities), 1.0, abs_tol=1e-5, rel_tol=0.0)
        or float(row.get("gugi_probability", 0.0)) != 0.0
    ):
        raise MangaFontV7PassError(f"{location}: active21 probability drifted")


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    marker = base.read_json(root / MARKER, location="v7 pass marker")
    report = base.read_json(root / REPORT, location="v7 pass report")
    validate_record_seal(marker, location="v7 pass marker")
    validate_record_seal(report, location="v7 pass report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != REPORT_SCHEMA
        or report.get("source_code_sha256") != sha256_file(Path(__file__).resolve())
        or report.get("marker_record_sha256") != marker.get("record_sha256")
    ):
        raise MangaFontV7PassError("v7 pass metadata drifted")
    candidate_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
    expected = mass21.candidate_projection(
        mass21.legacy15.FULL22_CANDIDATE_IDS
    ).active_ids
    if candidate_ids != expected or mass21.RETIRED_FONT_ID in candidate_ids:
        raise MangaFontV7PassError("v7 pass candidate vocabulary drifted")
    if float(report.get("gugi_probability_mass", -1.0)) != 0.0:
        raise MangaFontV7PassError("v7 pass retained Gugi probability mass")
    marker_visual = _mapping(marker.get("visual_features"), "marker visual features")
    report_visual = _mapping(report.get("visual_features"), "report visual features")
    if marker_visual != report_visual or marker_visual.get("kind") not in {
        "live_pinned_siglip2_raw_pixels",
        "sealed_siglip2_last_hidden_state_patch_tokens",
    }:
        raise MangaFontV7PassError("v7 pass visual feature provenance drifted")
    if marker_visual.get("kind") == "sealed_siglip2_last_hidden_state_patch_tokens":
        required_hashes = (
            "build_contract_sha256",
            "cache_identity_sha256",
            "manifest_sha256",
            "master_manifest_sha256",
            "model_contract_sha256",
            "sample_index_sha256",
            "sample_order_sha256",
            "selected_prefix_order_sha256",
            "view_contract_sha256",
        )
        if any(
            not isinstance(marker_visual.get(name), str)
            or len(str(marker_visual[name])) != 64
            for name in required_hashes
        ) or marker_visual.get("tensor_shape", [None, None, None, None])[1:] != [
            len(VIEW_NAMES),
            v7.PATCH_COUNT,
            v7.HIDDEN_SIZE,
        ]:
            raise MangaFontV7PassError("v7 pass hidden-cache binding drifted")
    marker_model = _mapping(marker.get("model_bindings"), "marker model bindings")
    _validate_v7_r3_model_bindings(marker_model, location="marker model bindings")
    report_model = _mapping(report.get("model"), "report model bindings")
    promotion_source_allowed = marker.get("promotion_source_allowed")
    if not isinstance(promotion_source_allowed, bool) or dict(report_model) != {
        **dict(marker_model),
        "promotion_source_allowed": promotion_source_allowed,
    }:
        raise MangaFontV7PassError("report/model binding drifted")
    expected_teacher_bindings = _expected_teacher_bindings(
        marker, visual_features=marker_visual
    )
    influence = _mapping(
        report.get("nonvisual_logit_influence"), "v7 pass nonvisual influence"
    )
    if set(influence) != set(INFLUENCE_FIELDS) or any(
        float(influence[name]) != 0.0 for name in INFLUENCE_FIELDS
    ):
        raise MangaFontV7PassError("nonvisual logits affected inference")
    authority = _mapping(report.get("authority"), "v7 pass authority")
    required_zero = (
        "human_gold_inputs_read",
        "promotion_allowed_rows",
        "test_training_eligible_rows",
        "training_eligible_rows",
        "val_training_eligible_rows",
    )
    if any(int(authority.get(name, -1)) != 0 for name in required_zero):
        raise MangaFontV7PassError("v7 pass authority boundary drifted")
    artifacts = _mapping(report.get("artifacts"), "v7 pass artifacts")
    review_descriptor = _mapping(
        artifacts.get("review_predictions"), "review descriptor"
    )
    pseudo_descriptor = _mapping(artifacts.get("pseudo_targets"), "pseudo descriptor")
    for name, descriptor in (
        (REVIEW_OUTPUT, review_descriptor),
        (PSEUDO_OUTPUT, pseudo_descriptor),
    ):
        path = root / name
        if (
            descriptor.get("file") != name
            or descriptor.get("sha256") != sha256_file(path)
            or int(descriptor.get("byte_size", -1)) != path.stat().st_size
        ):
            raise MangaFontV7PassError(f"v7 pass artifact drifted: {name}")
    shard_descriptors = artifacts.get("shards")
    if not isinstance(shard_descriptors, list) or not shard_descriptors:
        raise MangaFontV7PassError("v7 pass shard descriptors are missing")
    for shard_index, raw in enumerate(shard_descriptors):
        shard = _mapping(raw, f"v7 pass shard descriptor:{shard_index}")
        for kind in ("metadata", "pseudo", "review"):
            descriptor = _mapping(
                shard.get(kind), f"v7 pass shard descriptor:{shard_index}.{kind}"
            )
            name = str(descriptor.get("file", ""))
            path = root / SHARD_DIR / name
            if (
                not name.startswith(f"shard-{shard_index:05d}")
                or path.is_symlink()
                or not path.is_file()
                or descriptor.get("sha256") != sha256_file(path)
                or int(descriptor.get("byte_size", -1)) != path.stat().st_size
            ):
                raise MangaFontV7PassError("v7 pass shard artifact drifted")
    review_count = 0
    split_counts: Counter[str] = Counter()
    sample_ids: set[str] = set()
    for review in _iter_jsonl(root / REVIEW_OUTPUT, location="v7 pass review"):
        validate_record_seal(review, location="v7 pass review")
        sample_id = str(review.get("sample_id", ""))
        if not sample_id or sample_id in sample_ids:
            raise MangaFontV7PassError("duplicate/empty review identity")
        sample_ids.add(sample_id)
        if (
            review.get("schema_version") != SCHEMA
            or review.get("split") not in VALID_SPLITS
            or review.get("training_eligible") is not False
            or review.get("promotion_allowed") is not False
            or not 0.0 <= float(review.get("confidence", -1.0)) <= 1.0
            or not 0.0 <= float(review.get("weight", -1.0)) <= 1.0
        ):
            raise MangaFontV7PassError("review authority/confidence drifted")
        row_influence = _mapping(
            review.get("family_logit_influence"), "review logit influence"
        )
        if set(row_influence) != set(INFLUENCE_FIELDS) or any(
            float(row_influence[name]) != 0.0 for name in INFLUENCE_FIELDS
        ):
            raise MangaFontV7PassError("review nonvisual influence drifted")
        _validate_probability_row(
            review, candidate_ids=candidate_ids, location="review"
        )
        _validate_teacher_bindings(
            review.get("teacher_bindings"),
            expected=expected_teacher_bindings,
            location="review teacher bindings",
        )
        split_counts[str(review["split"])] += 1
        review_count += 1
    pseudo_count = 0
    for pseudo in _iter_jsonl(root / PSEUDO_OUTPUT, location="v7 pass pseudo"):
        validate_record_seal(pseudo, location="v7 pass pseudo")
        if (
            pseudo.get("schema_version") != mass21.PSEUDO_SCHEMA
            or pseudo.get("split") != "train"
            or pseudo.get("label_authority") != "pseudo_soft_not_gold"
            or pseudo.get("training_eligible") is not False
            or not 0.0 <= float(pseudo.get("weight", -1.0)) <= 1.0
            or pseudo.get("sample_id") not in sample_ids
        ):
            raise MangaFontV7PassError("mass21 pseudo authority drifted")
        _validate_probability_row(
            {**pseudo, "gugi_probability": 0.0},
            candidate_ids=candidate_ids,
            location="pseudo",
        )
        _validate_teacher_bindings(
            pseudo.get("teacher_bindings"),
            expected=expected_teacher_bindings,
            location="pseudo teacher bindings",
        )
        pseudo_count += 1
    counts = _mapping(report.get("counts"), "v7 pass counts")
    if (
        review_count != int(counts.get("review_rows", -1))
        or pseudo_count != int(counts.get("pseudo_train_rows", -1))
        or pseudo_count != split_counts["train"]
        or dict(sorted(split_counts.items())) != counts.get("splits")
    ):
        raise MangaFontV7PassError("v7 pass merged counts drifted")
    return {
        "candidate_count": len(candidate_ids),
        "output_dir": str(root),
        "pseudo_train_rows": pseudo_count,
        "review_rows": review_count,
        "status": "validated_v7_mass21_visual_pass",
        "test_training_eligible_rows": 0,
        "val_training_eligible_rows": 0,
        "visual_feature_kind": marker_visual["kind"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    label_parser = commands.add_parser("label")
    label_parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-v1"),
    )
    label_parser.add_argument(
        "--model-source",
        choices=("v7", "v7-r2", "v7-r3", "r3-fixture"),
        default="v7",
    )
    label_parser.add_argument(
        "--master-dir", type=Path, default=Path("datasets/font-matching-master-v3")
    )
    label_parser.add_argument(
        "--catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    label_parser.add_argument("--previous-pseudo", type=Path)
    label_parser.add_argument("--previous-weight", type=float, default=0.35)
    label_parser.add_argument("--temperature", type=float, default=1.0)
    label_parser.add_argument("--round", type=int, default=2)
    label_parser.add_argument("--batch-size", type=int, default=16)
    label_parser.add_argument("--shard-size", type=int, default=256)
    label_parser.add_argument("--max-samples", type=int, default=0)
    label_parser.add_argument(
        "--hidden-cache-dir",
        type=Path,
        help=(
            "optional sealed (N,3,196,768) SigLIP2 last_hidden_state cache; "
            "omitting it preserves raw-image encoding"
        ),
    )
    label_parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    label_parser.add_argument(
        "--amp-dtype", choices=("bf16", "fp16", "none"), default="bf16"
    )
    label_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = label(args) if args.command == "label" else validate_output(args.output_dir)
    except (
        MangaFontV7PassError,
        legacy_pass.StudentPassError,
        mass21.MangaFontMass21DataError,
        catalog_assets.CatalogAssetError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-v7-pass error: {error}") from error
    print(canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
