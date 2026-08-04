#!/usr/bin/env python3
"""Build a sealed, resumable SigLIP2 patch-token cache for master-v3.

The cache contains deterministic pixel features only.  It never contains or
creates font labels, pseudo labels, rankings, or training targets.  Every row
is bound to the ordered master-v3 identity, its exact manifest line, its three
ordered view descriptors, the pinned SigLIP2 revision, and the tensor contract.

Each shard is published as one directory via ``os.replace`` only after its
``float16`` ``last_hidden_state`` array and sample index have been hashed and
sealed.  A stopped build can therefore resume at the first missing shard while
fail-closing on changed inputs or malformed/pooled feature caches.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, BinaryIO, Protocol

import numpy as np

try:
    from scripts import build_font_matching_master as master
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import train_manga_font_student_v1 as base
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_font_matching_master as master
    import font_matching_catalog_assets as catalog_assets
    import train_manga_font_student_v1 as base


SCHEMA = "manga-font-master-v3-siglip2-hidden-cache-v1"
OWNER = "carrot-manga-translator/manga-font-master-v3-siglip2-hidden-cache-v1"
RECORD_TYPE = "manga_font_master_v3_siglip2_hidden_cache"
MARKER = ".manga-font-master-v3-siglip2-hidden-cache-v1-owned.json"
BUILD_CONTRACT = "build-contract.json"
SAMPLE_INDEX = "sample-index.jsonl"
MANIFEST = "manifest.json"
SHARDS_DIR = "shards"

SHARD_SCHEMA = "manga-font-master-v3-siglip2-hidden-shard-v1"
SHARD_OWNER = "carrot-manga-translator/manga-font-master-v3-siglip2-hidden-shard-v1"
SHARD_MARKER = ".manga-font-master-v3-siglip2-hidden-shard-v1-owned.json"
SHARD_ARRAY = "hidden-states.f16.npy"
SHARD_INDEX = "sample-index.jsonl"
SHARD_SEAL = "seal.json"
SHARD_FILES = frozenset({SHARD_MARKER, SHARD_ARRAY, SHARD_INDEX, SHARD_SEAL})

VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
MODEL_ID = "google/siglip2-base-patch16-224"
MODEL_REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
PROCESSOR_USE_FAST = False
IMAGE_SIZE = 224
PATCH_SIZE = 16
PATCH_COUNT = 196
HIDDEN_SIZE = 768
VIEW_COUNT = 3
OUTPUT_DTYPE = np.dtype("<f2")
BYTES_PER_SAMPLE = VIEW_COUNT * PATCH_COUNT * HIDDEN_SIZE * OUTPUT_DTYPE.itemsize

DEFAULT_MASTER_DIR = Path("datasets/font-matching-master-v3")
DEFAULT_CATALOG_REGISTRY = Path("datasets/font-matching-catalog-registry-v3.json")
DEFAULT_SHARD_SIZE = 128
DEFAULT_IMAGE_BATCH_SIZE = 48
MAX_CPU_SMOKE_SAMPLES = 256

FINAL_ROOT_FILES = frozenset(
    {MARKER, BUILD_CONTRACT, SAMPLE_INDEX, MANIFEST, SHARDS_DIR}
)
BUILDING_ROOT_FILES = frozenset({MARKER, BUILD_CONTRACT, SAMPLE_INDEX, SHARDS_DIR})
SHARD_PATTERN = re.compile(
    r"^shard-(?P<ordinal>\d{5})-(?P<start>\d{8})-"
    r"(?P<stop>\d{8})-(?P<seal>[0-9a-f]{64})$"
)
STAGING_PATTERN = re.compile(r"^\.staging-shard-(?P<ordinal>\d{5})-")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class HiddenStateCacheError(ValueError):
    """Raised when cache construction or validation would escape its contract."""


@dataclass(frozen=True)
class MasterRowBinding:
    cache_index: int
    master_row_index: int
    line_number: int
    byte_offset: int
    byte_length: int
    sample_id: str
    split: str
    work_id: str
    source_catalog_id: str
    master_line_sha256: str
    view_contract_sha256: str


@dataclass(frozen=True)
class MasterCachePlan:
    master_dir: Path
    manifest_path: Path
    catalog_registry: Path
    source_bindings: Mapping[str, Any]
    rows: tuple[MasterRowBinding, ...]
    master_total_rows: int
    master_split_counts: Mapping[str, int]
    selected_split_counts: Mapping[str, int]
    max_samples: int | None
    sample_index_payload: bytes
    sample_index_sha256: str
    sample_order_sha256: str


class ImageEncoder(Protocol):
    def encode(self, images: Sequence[Any]) -> np.ndarray: ...

    def close(self) -> None: ...


ImageLoader = Callable[[MasterRowBinding, BinaryIO | None], Sequence[Any]]


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HiddenStateCacheError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise HiddenStateCacheError(f"{location}: expected array")
    return value


def _require_sha256(value: Any, location: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise HiddenStateCacheError(f"{location}: expected lowercase SHA-256")
    return value


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (_canonical_json(value) + "\n").encode("utf-8")


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result["record_sha256"] = _sha256_bytes(
        _canonical_json(core).encode("utf-8")
    )
    return result


def _validate_record_seal(record: Mapping[str, Any], location: str) -> str:
    declared = _require_sha256(record.get("record_sha256"), f"{location}.record_sha256")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = _sha256_bytes(_canonical_json(core).encode("utf-8"))
    if actual != declared:
        raise HiddenStateCacheError(f"{location}: record seal mismatch")
    return actual


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise HiddenStateCacheError(f"{location}: missing regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HiddenStateCacheError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise HiddenStateCacheError(f"missing regular artifact: {path}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": _sha256_file(path),
    }


def _model_contract(device: str) -> dict[str, Any]:
    if device not in {"cpu", "cuda"}:
        raise HiddenStateCacheError("device must be cpu or cuda")
    return {
        "base_model_id": MODEL_ID,
        "base_model_revision": MODEL_REVISION,
        "cached_tensor": "last_hidden_state",
        "compute_device_kind": device,
        "compute_dtype": "float32" if device == "cpu" else "bfloat16",
        "hidden_size": HIDDEN_SIZE,
        "image_size": IMAGE_SIZE,
        "patch_count": PATCH_COUNT,
        "patch_size": PATCH_SIZE,
        "pooler_output_used": False,
        "processor_use_fast": PROCESSOR_USE_FAST,
    }


def _view_contract() -> dict[str, Any]:
    return {
        "order": list(VIEW_NAMES),
        "preprocessing": {
            "do_convert_rgb": True,
            "do_resize": False,
            "expected_input_mode": "RGB",
            "expected_input_size_px": [IMAGE_SIZE, IMAGE_SIZE],
            "processor": "SiglipImageProcessor.from_pretrained",
            "return_tensors": "pt",
        },
        "raw_224_derivation": dict(catalog_assets.RAW_224_RECIPE),
        "view_count": VIEW_COUNT,
    }


def _tensor_contract() -> dict[str, Any]:
    return {
        "bytes_per_sample": BYTES_PER_SAMPLE,
        "dtype": "float16",
        "endianness": "little",
        "per_sample_shape": [VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE],
        "representation": "siglip2_vision_last_hidden_state_patch_tokens",
    }


def _authority_contract() -> dict[str, Any]:
    return {
        "artifact_kind": "deterministic_pixel_features_only",
        "cache_is_label_authority": False,
        "contains_font_labels": False,
        "contains_pseudo_labels": False,
        "contains_rankings": False,
        "label_authority": "none_pixel_features_are_not_labels",
        "split_policy": {
            "test": "final_evaluation_only_never_optimizer_or_model_selection",
            "train": (
                "optimizer_use_requires_separate_sealed_training_authority_"
                "or_an_explicit_label_free_objective"
            ),
            "val": "evaluation_or_model_selection_only_never_optimizer",
        },
        "training_eligible_by_itself": False,
    }


def _view_binding_sha256(sample_id: str, views: Mapping[str, Any]) -> str:
    ordered = []
    for view_name in VIEW_NAMES:
        if view_name not in views:
            raise HiddenStateCacheError(f"{sample_id}: missing view {view_name}")
        ordered.append({"descriptor": copy.deepcopy(views[view_name]), "name": view_name})
    return _sha256_bytes(
        _canonical_json(
            {"sample_id": sample_id, "view_order": list(VIEW_NAMES), "views": ordered}
        ).encode("utf-8")
    )


def _index_core(binding: MasterRowBinding) -> dict[str, Any]:
    return {
        "cache_index": binding.cache_index,
        "master_line_number": binding.line_number,
        "master_line_sha256": binding.master_line_sha256,
        "master_row_index": binding.master_row_index,
        "sample_id": binding.sample_id,
        "source_catalog_id": binding.source_catalog_id,
        "split": binding.split,
        "view_contract_sha256": binding.view_contract_sha256,
        "work_id": binding.work_id,
    }


def _index_payload(rows: Sequence[MasterRowBinding]) -> bytes:
    return b"".join(_json_bytes(_seal_record(_index_core(row))) for row in rows)


def _validate_master_row(
    row: Mapping[str, Any],
    *,
    row_index: int,
    line_number: int,
    split: str,
    catalogs: Mapping[str, Any],
    assignments: Mapping[str, Any],
) -> tuple[str, str, str, str]:
    location = f"master row {line_number}"
    sample_id = str(row.get("id", ""))
    provenance = _mapping(row.get("provenance"), f"{location}.provenance")
    if (
        not sample_id
        or row.get("schema_version") != master.MASTER_SCHEMA_VERSION
        or row.get("catalog_version") != master.CATALOG_SCHEMA_VERSION
        or row.get("split") != split
        or row.get("label_status") != "unlabeled"
        or row.get("font_label") is not None
        or provenance.get("synthetic") is not False
        or provenance.get("qa_overlay") is not False
    ):
        raise HiddenStateCacheError(f"{location}: unsafe or labeled master row")
    work = _mapping(row.get("work"), f"{location}.work")
    work_id = str(work.get("id", ""))
    if not work_id or assignments.get(work_id) != split:
        raise HiddenStateCacheError(f"{location}: work/split assignment drifted")
    source_catalog_id = str(provenance.get("source_catalog_id", ""))
    if source_catalog_id not in catalogs:
        raise HiddenStateCacheError(f"{location}: unknown source catalog")
    views = _mapping(row.get("views"), f"{location}.views")
    if tuple(views) != VIEW_NAMES and set(views) != set(VIEW_NAMES):
        raise HiddenStateCacheError(f"{location}: three-view inventory drifted")
    for view_name in VIEW_NAMES:
        try:
            master.validate_view_contract(
                views[view_name],
                view_name=view_name,
                item_id=sample_id,
                catalogs=catalogs,
                verify_assets=False,
            )
        except Exception as error:
            raise HiddenStateCacheError(
                f"{location}.{view_name}: invalid master view contract"
            ) from error
    try:
        master.validate_source_page_locator(row, item_id=sample_id)
    except Exception as error:
        raise HiddenStateCacheError(f"{location}: invalid source page locator") from error
    del row_index
    return sample_id, work_id, source_catalog_id, _view_binding_sha256(sample_id, views)


def load_master_plan(
    master_dir: Path,
    *,
    catalog_registry: Path,
    max_samples: int | None = None,
) -> MasterCachePlan:
    root = master_dir.expanduser().resolve()
    expected_inventory = {"manifest.jsonl", "report.json", "split_map.json"}
    if (
        root.is_symlink()
        or not root.is_dir()
        or {item.name for item in root.iterdir()} != expected_inventory
        or any(item.is_symlink() for item in root.iterdir())
    ):
        raise HiddenStateCacheError("master-v3 exact inventory drifted")
    if max_samples is not None and (
        isinstance(max_samples, bool) or not isinstance(max_samples, int) or max_samples < 1
    ):
        raise HiddenStateCacheError("max-samples must be a positive integer")

    manifest_path = root / "manifest.jsonl"
    report_path = root / "report.json"
    split_map_path = root / "split_map.json"
    report = _read_json(report_path, "master-v3 report")
    split_map = _read_json(split_map_path, "master-v3 split map")
    outputs = _mapping(report.get("outputs"), "master-v3 report.outputs")
    statistics = _mapping(report.get("statistics"), "master-v3 statistics")
    reported_counts = {
        str(key): int(value)
        for key, value in _mapping(
            statistics.get("by_split"), "master-v3 statistics.by_split"
        ).items()
    }
    if (
        report.get("tool") != master.TOOL_ID
        or set(reported_counts) != {"train", "val", "test"}
        or int(statistics.get("record_count", -1)) != sum(reported_counts.values())
    ):
        raise HiddenStateCacheError("master-v3 report/count contract drifted")
    total_rows = sum(reported_counts.values())
    if max_samples is not None and max_samples > total_rows:
        raise HiddenStateCacheError("max-samples exceeds the sealed master row count")

    registry_path = catalog_registry.expanduser().resolve()
    if registry_path.is_symlink() or not registry_path.is_file():
        raise HiddenStateCacheError("catalog registry is missing or linked")
    try:
        configuration = master.load_catalog_registry(registry_path)
    except Exception as error:
        raise HiddenStateCacheError("catalog registry validation failed") from error
    catalogs = {item.catalog_id: item for item in configuration.catalogs}
    attestation = _mapping(
        _mapping(report.get("inputs"), "master-v3 report.inputs").get("attestation"),
        "master-v3 attestation",
    )
    registry_binding = _mapping(
        attestation.get("catalog_registry"), "master-v3 catalog registry binding"
    )
    registry_sha = _sha256_file(registry_path)
    if registry_binding.get("sha256") != registry_sha:
        raise HiddenStateCacheError("master-v3 catalog registry binding drifted")

    split_map_sha = _sha256_file(split_map_path)
    if outputs.get("split_map_sha256") != split_map_sha:
        raise HiddenStateCacheError("master-v3 split map hash drifted")
    assignments = _mapping(split_map.get("work_assignments"), "work assignments")
    selected_limit = total_rows if max_samples is None else max_samples
    selected_rows: list[MasterRowBinding] = []
    selected_seen: set[str] = set()
    actual_counts: Counter[str] = Counter()
    digest = hashlib.sha256()
    physical_rows = 0
    with manifest_path.open("rb") as handle:
        while True:
            offset = handle.tell()
            raw_line = handle.readline()
            if not raw_line:
                break
            digest.update(raw_line)
            if not raw_line.strip():
                continue
            row_index = physical_rows
            physical_rows += 1
            split = base.top_level_string_field_without_deserializing(raw_line, "split")
            if split not in {"train", "val", "test"}:
                raise HiddenStateCacheError(
                    f"master row {physical_rows}: unsupported split {split!r}"
                )
            actual_counts[split] += 1
            if row_index >= selected_limit:
                continue
            try:
                row = _mapping(json.loads(raw_line), f"master row {physical_rows}")
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise HiddenStateCacheError(
                    f"master row {physical_rows}: invalid JSON"
                ) from error
            sample_id, work_id, source_catalog_id, view_sha = _validate_master_row(
                row,
                row_index=row_index,
                line_number=physical_rows,
                split=split,
                catalogs=catalogs,
                assignments=assignments,
            )
            if sample_id in selected_seen:
                raise HiddenStateCacheError("duplicate selected master sample identity")
            selected_seen.add(sample_id)
            selected_rows.append(
                MasterRowBinding(
                    cache_index=len(selected_rows),
                    master_row_index=row_index,
                    line_number=physical_rows,
                    byte_offset=offset,
                    byte_length=len(raw_line),
                    sample_id=sample_id,
                    split=split,
                    work_id=work_id,
                    source_catalog_id=source_catalog_id,
                    master_line_sha256=_sha256_bytes(raw_line),
                    view_contract_sha256=view_sha,
                )
            )
    manifest_sha = digest.hexdigest()
    if (
        physical_rows != total_rows
        or dict(actual_counts) != reported_counts
        or len(selected_rows) != selected_limit
        or outputs.get("master_manifest_sha256") != manifest_sha
    ):
        raise HiddenStateCacheError("master-v3 manifest/report binding drifted")
    payload = _index_payload(selected_rows)
    selected_counts = Counter(row.split for row in selected_rows)
    source_bindings = MappingProxyType(
        {
            "catalog_registry_record_sha256": registry_binding.get("record_sha256"),
            "catalog_registry_sha256": registry_sha,
            "master_manifest_sha256": manifest_sha,
            "master_report_sha256": _sha256_file(report_path),
            "master_split_map_sha256": split_map_sha,
        }
    )
    return MasterCachePlan(
        master_dir=root,
        manifest_path=manifest_path,
        catalog_registry=registry_path,
        source_bindings=source_bindings,
        rows=tuple(selected_rows),
        master_total_rows=total_rows,
        master_split_counts=MappingProxyType(dict(sorted(reported_counts.items()))),
        selected_split_counts=MappingProxyType(
            {name: int(selected_counts.get(name, 0)) for name in ("train", "val", "test")}
        ),
        max_samples=max_samples,
        sample_index_payload=payload,
        sample_index_sha256=_sha256_bytes(payload),
        sample_order_sha256=_sha256_bytes(
            "\n".join(row.sample_id for row in selected_rows).encode("utf-8")
        ),
    )


def _build_contract_core(
    plan: MasterCachePlan, *, shard_size: int, device: str
) -> dict[str, Any]:
    selection = {
        "is_bounded_prefix": len(plan.rows) != plan.master_total_rows,
        "master_row_count": plan.master_total_rows,
        "max_samples": plan.max_samples,
        "selected_row_count": len(plan.rows),
        "selected_split_counts": dict(plan.selected_split_counts),
    }
    semantic_identity = {
        "authority": _authority_contract(),
        "model": _model_contract(device),
        "sample_index_sha256": plan.sample_index_sha256,
        "sample_order_sha256": plan.sample_order_sha256,
        "selection": selection,
        "sources": dict(plan.source_bindings),
        "tensor": _tensor_contract(),
        "views": _view_contract(),
    }
    cache_identity = _sha256_bytes(
        _canonical_json(semantic_identity).encode("utf-8")
    )
    return {
        **semantic_identity,
        "builder_source_code_sha256": _sha256_file(Path(__file__).resolve()),
        "cache_identity_sha256": cache_identity,
        "index": {
            "byte_size": len(plan.sample_index_payload),
            "file": SAMPLE_INDEX,
            "record_count": len(plan.rows),
            "sha256": plan.sample_index_sha256,
        },
        "record_type": f"{RECORD_TYPE}_build_contract",
        "schema_version": SCHEMA,
        "sharding": {
            "atomic_publication": "same_volume_staging_directory_os_replace",
            "format": "npy_plus_sealed_jsonl_directory",
            "shard_count": math.ceil(len(plan.rows) / shard_size),
            "shard_size": shard_size,
        },
    }


def make_build_contract(
    plan: MasterCachePlan, *, shard_size: int, device: str
) -> Mapping[str, Any]:
    if isinstance(shard_size, bool) or not 1 <= shard_size <= 1024:
        raise HiddenStateCacheError("shard-size must be 1..1024")
    return _seal_record(_build_contract_core(plan, shard_size=shard_size, device=device))


def _semantic_build_contract(record: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        key: copy.deepcopy(value)
        for key, value in record.items()
        if key not in {"builder_source_code_sha256", "record_sha256"}
    }


def _read_bound_master_row(
    plan: MasterCachePlan,
    binding: MasterRowBinding,
    *,
    handle: BinaryIO | None = None,
) -> Mapping[str, Any]:
    owned = handle is None
    stream = plan.manifest_path.open("rb") if handle is None else handle
    try:
        stream.seek(binding.byte_offset)
        raw_line = stream.read(binding.byte_length)
    finally:
        if owned:
            stream.close()
    if (
        len(raw_line) != binding.byte_length
        or _sha256_bytes(raw_line) != binding.master_line_sha256
    ):
        raise HiddenStateCacheError("master row changed after cache preflight")
    try:
        row = _mapping(json.loads(raw_line), f"master row {binding.line_number}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HiddenStateCacheError("bound master row is invalid") from error
    views = _mapping(row.get("views"), f"master row {binding.line_number}.views")
    if (
        row.get("id") != binding.sample_id
        or row.get("split") != binding.split
        or _view_binding_sha256(binding.sample_id, views)
        != binding.view_contract_sha256
    ):
        raise HiddenStateCacheError("bound master identity/view contract drifted")
    return row


class MasterViewLoader:
    def __init__(self, plan: MasterCachePlan) -> None:
        self.plan = plan
        self.resolver = catalog_assets.CatalogAssetResolver(plan.catalog_registry)
        if self.resolver.registry_sha256 != plan.source_bindings["catalog_registry_sha256"]:
            raise HiddenStateCacheError("catalog registry changed after preflight")

    def __call__(
        self, binding: MasterRowBinding, handle: BinaryIO | None
    ) -> Sequence[Any]:
        row = _read_bound_master_row(self.plan, binding, handle=handle)
        views = _mapping(row.get("views"), f"master row {binding.line_number}.views")
        images: list[Any] = []
        try:
            for view_name in VIEW_NAMES:
                with self.resolver.resolve_view_descriptor(
                    views[view_name],
                    sample_id=binding.sample_id,
                    view_name=view_name,
                    location=f"master[{binding.sample_id}].views.{view_name}",
                ) as resolved:
                    if resolved.image.mode != "RGB" or resolved.image.size != (
                        IMAGE_SIZE,
                        IMAGE_SIZE,
                    ):
                        raise HiddenStateCacheError(
                            f"{binding.sample_id}/{view_name}: invalid resolved pixels"
                        )
                    images.append(resolved.image.copy())
            return images
        except BaseException:
            for image in images:
                image.close()
            raise


class Siglip2HiddenStateEncoder:
    """Pinned frozen SigLIP2 encoder used only by the cache build command."""

    def __init__(self, *, device: str) -> None:
        try:
            torch, processor_class, vision_class, _save_file = (
                base._load_training_dependencies()  # noqa: SLF001
            )
        except Exception as error:
            raise HiddenStateCacheError("SigLIP2 dependencies could not be loaded") from error
        if device == "cuda":
            if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
                raise HiddenStateCacheError("CUDA build requires bf16-capable CUDA")
        elif device != "cpu":
            raise HiddenStateCacheError("device must be cpu or cuda")
        self.torch = torch
        self.device = device
        self.processor = processor_class.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            use_fast=PROCESSOR_USE_FAST,
            local_files_only=True,
        )
        self.encoder = (
            vision_class.from_pretrained(
                MODEL_ID,
                revision=MODEL_REVISION,
                local_files_only=True,
            )
            .eval()
            .requires_grad_(False)
            .to(device)
        )
        config = self.encoder.config
        if (
            int(getattr(config, "hidden_size", 0)) != HIDDEN_SIZE
            or int(getattr(config, "patch_size", 0)) != PATCH_SIZE
            or int(getattr(config, "image_size", 0)) != IMAGE_SIZE
        ):
            raise HiddenStateCacheError("pinned SigLIP2 patch contract drifted")
        torch.use_deterministic_algorithms(True)
        if hasattr(torch.backends, "cudnn"):
            torch.backends.cudnn.benchmark = False
            torch.backends.cudnn.deterministic = True
        if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "matmul"):
            torch.backends.cuda.matmul.allow_tf32 = False

    def encode(self, images: Sequence[Any]) -> np.ndarray:
        torch = self.torch
        processed = self.processor(
            images=list(images),
            return_tensors="pt",
            do_resize=False,
            do_convert_rgb=True,
        )
        pixels = processed["pixel_values"].to(self.device, non_blocking=False)
        with torch.inference_mode():
            if self.device == "cuda":
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    tokens = self.encoder(pixel_values=pixels).last_hidden_state
            else:
                tokens = self.encoder(pixel_values=pixels).last_hidden_state
        expected = (len(images), PATCH_COUNT, HIDDEN_SIZE)
        if tuple(tokens.shape) != expected:
            raise HiddenStateCacheError(
                f"SigLIP2 last_hidden_state shape drifted: {tuple(tokens.shape)}"
            )
        result = np.ascontiguousarray(
            tokens.float().cpu().numpy().astype(OUTPUT_DTYPE, copy=False)
        )
        _validate_encoded_batch(result, len(images))
        return result

    def close(self) -> None:
        encoder = getattr(self, "encoder", None)
        if encoder is not None:
            del self.encoder
        if self.device == "cuda":
            self.torch.cuda.empty_cache()


def _validate_encoded_batch(array: np.ndarray, image_count: int) -> None:
    if array.dtype != OUTPUT_DTYPE:
        raise HiddenStateCacheError("encoder output must be little-endian float16")
    if array.shape != (image_count, PATCH_COUNT, HIDDEN_SIZE):
        if array.shape == (image_count, HIDDEN_SIZE):
            raise HiddenStateCacheError(
                "pooled SigLIP2 output is forbidden; last_hidden_state patches required"
            )
        raise HiddenStateCacheError(f"encoder output shape drifted: {array.shape}")
    if not np.isfinite(array).all():
        raise HiddenStateCacheError("encoder output contains non-finite values")


def validate_hidden_states_array(path: Path, expected_rows: int) -> np.ndarray:
    try:
        array = np.load(path, mmap_mode="r", allow_pickle=False)
    except (OSError, ValueError) as error:
        raise HiddenStateCacheError("hidden-state shard is not a valid NPY array") from error
    expected = (expected_rows, VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE)
    if array.dtype != OUTPUT_DTYPE:
        raise HiddenStateCacheError("hidden-state shard dtype must be float16")
    if array.shape == (expected_rows, VIEW_COUNT, HIDDEN_SIZE):
        raise HiddenStateCacheError(
            "pooled (N,3,768) cache is forbidden; expected (N,3,196,768)"
        )
    if array.shape != expected:
        raise HiddenStateCacheError(
            f"hidden-state shard shape {array.shape} does not match {expected}"
        )
    for start in range(0, expected_rows, 16):
        if not np.isfinite(array[start : start + 16]).all():
            raise HiddenStateCacheError("hidden-state shard contains non-finite values")
    return array


def _close_images(images: Sequence[Any]) -> None:
    for image in images:
        close = getattr(image, "close", None)
        if callable(close):
            close()


def _shard_ranges(row_count: int, shard_size: int) -> tuple[tuple[int, int, int], ...]:
    return tuple(
        (ordinal, start, min(row_count, start + shard_size))
        for ordinal, start in enumerate(range(0, row_count, shard_size))
    )


def _shard_index_payload(rows: Sequence[MasterRowBinding]) -> bytes:
    return _index_payload(rows)


def _write_shard(
    *,
    shards_root: Path,
    ordinal: int,
    start: int,
    stop: int,
    rows: Sequence[MasterRowBinding],
    build_contract: Mapping[str, Any],
    encoder: ImageEncoder,
    image_loader: ImageLoader,
    image_batch_size: int,
    manifest_handle: BinaryIO | None,
) -> Path:
    staging = Path(
        tempfile.mkdtemp(prefix=f".staging-shard-{ordinal:05d}-", dir=shards_root)
    )
    contract_sha = _require_sha256(
        build_contract.get("record_sha256"), "build contract record_sha256"
    )
    marker = _seal_record(
        {
            "build_contract_record_sha256": contract_sha,
            "owner": SHARD_OWNER,
            "schema_version": SHARD_SCHEMA,
            "shard_ordinal": ordinal,
            "status": "staging",
        }
    )
    try:
        _atomic_write(staging / SHARD_MARKER, _json_bytes(marker, pretty=True))
        shard_rows = tuple(rows[start:stop])
        index_payload = _shard_index_payload(shard_rows)
        _atomic_write(staging / SHARD_INDEX, index_payload)
        array_path = staging / SHARD_ARRAY
        output = np.lib.format.open_memmap(
            array_path,
            mode="w+",
            dtype=OUTPUT_DTYPE,
            shape=(len(shard_rows), VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE),
        )
        filled = np.zeros((len(shard_rows), VIEW_COUNT), dtype=np.bool_)
        images: list[Any] = []
        positions: list[tuple[int, int]] = []

        def flush(target_array: np.ndarray) -> None:
            if not images:
                return
            try:
                encoded = np.asarray(encoder.encode(tuple(images)))
                _validate_encoded_batch(encoded, len(images))
                for encoded_row, (local_row, view_index) in zip(
                    encoded, positions, strict=True
                ):
                    if filled[local_row, view_index]:
                        raise HiddenStateCacheError("shard position encoded twice")
                    target_array[local_row, view_index] = encoded_row
                    filled[local_row, view_index] = True
            finally:
                _close_images(images)
                images.clear()
                positions.clear()

        try:
            try:
                for local_row, binding in enumerate(shard_rows):
                    group = tuple(image_loader(binding, manifest_handle))
                    if len(group) != VIEW_COUNT:
                        _close_images(group)
                        raise HiddenStateCacheError(
                            "image loader violated three-view contract"
                        )
                    images.extend(group)
                    positions.extend(
                        (local_row, view_index) for view_index in range(VIEW_COUNT)
                    )
                    if len(images) >= image_batch_size:
                        flush(output)
                flush(output)
            finally:
                _close_images(images)
            if not filled.all():
                raise HiddenStateCacheError("shard has unfilled hidden-state positions")
            output.flush()
        finally:
            mapped_file = getattr(output, "_mmap", None)
            if mapped_file is not None:
                mapped_file.close()
        with array_path.open("r+b") as handle:
            os.fsync(handle.fileno())
        validate_hidden_states_array(array_path, len(shard_rows))
        hidden_descriptor = _descriptor(array_path)
        index_descriptor = _descriptor(staging / SHARD_INDEX)
        split_counts = Counter(row.split for row in shard_rows)
        seal = _seal_record(
            {
                "authority": _authority_contract(),
                "build_contract_record_sha256": contract_sha,
                "cache_identity_sha256": build_contract["cache_identity_sha256"],
                "end_cache_index_exclusive": stop,
                "first_sample_id": shard_rows[0].sample_id,
                "hidden_states": {
                    **hidden_descriptor,
                    "dtype": "float16",
                    "shape": [len(shard_rows), VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE],
                },
                "index": {**index_descriptor, "record_count": len(shard_rows)},
                "last_sample_id": shard_rows[-1].sample_id,
                "record_type": "manga_font_master_v3_siglip2_hidden_shard",
                "row_count": len(shard_rows),
                "schema_version": SHARD_SCHEMA,
                "shard_ordinal": ordinal,
                "split_counts": {
                    name: int(split_counts.get(name, 0))
                    for name in ("train", "val", "test")
                },
                "start_cache_index": start,
                "tensor": _tensor_contract(),
            }
        )
        _atomic_write(staging / SHARD_SEAL, _json_bytes(seal, pretty=True))
        complete_marker = _seal_record(
            {
                "build_contract_record_sha256": contract_sha,
                "owner": SHARD_OWNER,
                "schema_version": SHARD_SCHEMA,
                "shard_ordinal": ordinal,
                "status": "complete",
            }
        )
        _atomic_write(staging / SHARD_MARKER, _json_bytes(complete_marker, pretty=True))
        seal_sha = str(seal["record_sha256"])
        target = shards_root / (
            f"shard-{ordinal:05d}-{start:08d}-{stop:08d}-{seal_sha}"
        )
        if target.exists():
            raise HiddenStateCacheError(f"refusing to replace existing shard {target.name}")
        os.replace(staging, target)
        return target
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def _validate_shard(
    path: Path,
    *,
    ordinal: int,
    start: int,
    stop: int,
    plan: MasterCachePlan,
    build_contract: Mapping[str, Any],
) -> Mapping[str, Any]:
    match = SHARD_PATTERN.fullmatch(path.name)
    if path.is_symlink() or not path.is_dir() or match is None:
        raise HiddenStateCacheError(f"invalid shard directory: {path.name}")
    if (
        int(match.group("ordinal")) != ordinal
        or int(match.group("start")) != start
        or int(match.group("stop")) != stop
    ):
        raise HiddenStateCacheError(f"shard range/name drifted: {path.name}")
    children = tuple(path.iterdir())
    if {item.name for item in children} != SHARD_FILES or any(
        item.is_symlink() for item in children
    ):
        raise HiddenStateCacheError(f"shard exact inventory drifted: {path.name}")
    marker = _read_json(path / SHARD_MARKER, f"{path.name} marker")
    _validate_record_seal(marker, f"{path.name} marker")
    contract_sha = str(build_contract["record_sha256"])
    if (
        marker.get("owner") != SHARD_OWNER
        or marker.get("schema_version") != SHARD_SCHEMA
        or marker.get("status") != "complete"
        or marker.get("build_contract_record_sha256") != contract_sha
        or marker.get("shard_ordinal") != ordinal
    ):
        raise HiddenStateCacheError(f"shard ownership drifted: {path.name}")
    seal = _read_json(path / SHARD_SEAL, f"{path.name} seal")
    seal_sha = _validate_record_seal(seal, f"{path.name} seal")
    if match.group("seal") != seal_sha:
        raise HiddenStateCacheError(f"shard directory/seal hash mismatch: {path.name}")
    expected_rows = tuple(plan.rows[start:stop])
    expected_index = _shard_index_payload(expected_rows)
    index_path = path / SHARD_INDEX
    index_descriptor = _mapping(seal.get("index"), f"{path.name} seal.index")
    if (
        index_path.read_bytes() != expected_index
        or index_descriptor.get("file") != SHARD_INDEX
        or index_descriptor.get("sha256") != _sha256_file(index_path)
        or index_descriptor.get("byte_size") != index_path.stat().st_size
        or index_descriptor.get("record_count") != len(expected_rows)
    ):
        raise HiddenStateCacheError(f"shard sample identity/order drifted: {path.name}")
    hidden_path = path / SHARD_ARRAY
    hidden_descriptor = _mapping(
        seal.get("hidden_states"), f"{path.name} seal.hidden_states"
    )
    if (
        hidden_descriptor.get("file") != SHARD_ARRAY
        or hidden_descriptor.get("sha256") != _sha256_file(hidden_path)
        or hidden_descriptor.get("byte_size") != hidden_path.stat().st_size
        or hidden_descriptor.get("dtype") != "float16"
        or hidden_descriptor.get("shape")
        != [len(expected_rows), VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE]
    ):
        raise HiddenStateCacheError(f"shard hidden-state descriptor drifted: {path.name}")
    validate_hidden_states_array(hidden_path, len(expected_rows))
    split_counts = Counter(row.split for row in expected_rows)
    expected_split_counts = {
        name: int(split_counts.get(name, 0)) for name in ("train", "val", "test")
    }
    if (
        seal.get("schema_version") != SHARD_SCHEMA
        or seal.get("record_type")
        != "manga_font_master_v3_siglip2_hidden_shard"
        or seal.get("build_contract_record_sha256") != contract_sha
        or seal.get("cache_identity_sha256")
        != build_contract.get("cache_identity_sha256")
        or seal.get("shard_ordinal") != ordinal
        or seal.get("start_cache_index") != start
        or seal.get("end_cache_index_exclusive") != stop
        or seal.get("row_count") != len(expected_rows)
        or seal.get("first_sample_id") != expected_rows[0].sample_id
        or seal.get("last_sample_id") != expected_rows[-1].sample_id
        or seal.get("split_counts") != expected_split_counts
        or seal.get("tensor") != _tensor_contract()
        or seal.get("authority") != _authority_contract()
    ):
        raise HiddenStateCacheError(f"shard semantic contract drifted: {path.name}")
    return {
        "byte_size": sum(item.stat().st_size for item in children),
        "directory": path.name,
        "end_cache_index_exclusive": stop,
        "hidden_states_sha256": hidden_descriptor["sha256"],
        "row_count": len(expected_rows),
        "seal_record_sha256": seal_sha,
        "shard_ordinal": ordinal,
        "split_counts": expected_split_counts,
        "start_cache_index": start,
    }


def _reject_pooled_cache(root: Path) -> None:
    pooled_names = {
        "sample-features.npy",
        "prototype-features.npy",
        "feature-manifest.json",
    }
    found = pooled_names & {item.name for item in root.iterdir()}
    if found:
        raise HiddenStateCacheError(
            "pooled (N,3,768) feature cache cannot be used as a patch-token cache: "
            + ", ".join(sorted(found))
        )


def _clean_owned_staging(shards_root: Path, build_contract: Mapping[str, Any]) -> None:
    contract_sha = str(build_contract["record_sha256"])
    for child in tuple(shards_root.iterdir()):
        if not child.name.startswith(".staging-shard-"):
            continue
        if child.is_symlink() or not child.is_dir() or STAGING_PATTERN.match(child.name) is None:
            raise HiddenStateCacheError("untrusted staging shard encountered")
        marker_path = child / SHARD_MARKER
        marker = _read_json(marker_path, f"{child.name} staging marker")
        _validate_record_seal(marker, f"{child.name} staging marker")
        if (
            marker.get("owner") != SHARD_OWNER
            or marker.get("schema_version") != SHARD_SCHEMA
            or marker.get("build_contract_record_sha256") != contract_sha
        ):
            raise HiddenStateCacheError("staging shard is not owned by this build")
        shutil.rmtree(child)


def _collect_shards(
    shards_root: Path,
    *,
    plan: MasterCachePlan,
    build_contract: Mapping[str, Any],
    clean_staging: bool,
) -> dict[int, tuple[Path, Mapping[str, Any]]]:
    if shards_root.is_symlink() or not shards_root.is_dir():
        raise HiddenStateCacheError("shards root is missing or linked")
    if clean_staging:
        _clean_owned_staging(shards_root, build_contract)
    shard_size = int(_mapping(build_contract["sharding"], "sharding")["shard_size"])
    expected_ranges = {
        ordinal: (start, stop)
        for ordinal, start, stop in _shard_ranges(len(plan.rows), shard_size)
    }
    result: dict[int, tuple[Path, Mapping[str, Any]]] = {}
    for child in sorted(shards_root.iterdir(), key=lambda item: item.name):
        match = SHARD_PATTERN.fullmatch(child.name)
        if match is None:
            raise HiddenStateCacheError(f"unexpected shard inventory entry: {child.name}")
        ordinal = int(match.group("ordinal"))
        if ordinal not in expected_ranges or ordinal in result:
            raise HiddenStateCacheError("unexpected or duplicate shard ordinal")
        start, stop = expected_ranges[ordinal]
        result[ordinal] = (
            child,
            _validate_shard(
                child,
                ordinal=ordinal,
                start=start,
                stop=stop,
                plan=plan,
                build_contract=build_contract,
            ),
        )
    return result


def _building_marker(build_contract: Mapping[str, Any]) -> Mapping[str, Any]:
    return _seal_record(
        {
            "build_contract_record_sha256": build_contract["record_sha256"],
            "cache_identity_sha256": build_contract["cache_identity_sha256"],
            "owner": OWNER,
            "schema_version": SCHEMA,
            "status": "building",
        }
    )


def _complete_marker(
    root: Path, build_contract: Mapping[str, Any]
) -> Mapping[str, Any]:
    return _seal_record(
        {
            "artifacts": {
                name: _descriptor(root / name)
                for name in (BUILD_CONTRACT, SAMPLE_INDEX, MANIFEST)
            },
            "build_contract_record_sha256": build_contract["record_sha256"],
            "cache_identity_sha256": build_contract["cache_identity_sha256"],
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
            "status": "complete",
        }
    )


def _prepare_output(
    root: Path,
    *,
    plan: MasterCachePlan,
    build_contract: Mapping[str, Any],
    resume: bool,
) -> str:
    if root.exists():
        if root.is_symlink() or not root.is_dir():
            raise HiddenStateCacheError("output exists but is not a regular directory")
        _reject_pooled_cache(root)
        if not resume:
            raise HiddenStateCacheError("output exists; pass --resume for the exact build")
        marker = _read_json(root / MARKER, "cache ownership marker")
        _validate_record_seal(marker, "cache ownership marker")
        if (
            marker.get("owner") != OWNER
            or marker.get("schema_version") != SCHEMA
            or marker.get("build_contract_record_sha256")
            != build_contract["record_sha256"]
            or marker.get("cache_identity_sha256")
            != build_contract["cache_identity_sha256"]
        ):
            raise HiddenStateCacheError("resume ownership/build contract drifted")
        allowed = FINAL_ROOT_FILES if (root / MANIFEST).exists() else BUILDING_ROOT_FILES
        if {item.name for item in root.iterdir()} != allowed:
            raise HiddenStateCacheError("resume root inventory drifted")
        stored_contract = _read_json(root / BUILD_CONTRACT, "stored build contract")
        _validate_record_seal(stored_contract, "stored build contract")
        if stored_contract != build_contract:
            raise HiddenStateCacheError("resume build contract changed")
        if (root / SAMPLE_INDEX).read_bytes() != plan.sample_index_payload:
            raise HiddenStateCacheError("resume sample identity/order changed")
        return str(marker.get("status"))

    root.parent.mkdir(parents=True, exist_ok=True)
    root.mkdir()
    (root / SHARDS_DIR).mkdir()
    _atomic_write(root / SAMPLE_INDEX, plan.sample_index_payload)
    _atomic_write(root / BUILD_CONTRACT, _json_bytes(build_contract, pretty=True))
    _atomic_write(root / MARKER, _json_bytes(_building_marker(build_contract), pretty=True))
    return "new"


def _manifest_core(
    *,
    root: Path,
    plan: MasterCachePlan,
    build_contract: Mapping[str, Any],
    shard_descriptors: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    selected_counts = dict(plan.selected_split_counts)
    actual_bytes = sum(int(item["byte_size"]) for item in shard_descriptors)
    return {
        "authority": _authority_contract(),
        "boundaries": {
            "cache_is_label_authority": False,
            "includes_test_features": selected_counts["test"] > 0,
            "includes_train_features": selected_counts["train"] > 0,
            "includes_validation_features": selected_counts["val"] > 0,
            "authoritative_label_records_deserialized": 0,
            "labels_stored": 0,
            "non_null_font_labels_deserialized": 0,
            "test_feature_count": selected_counts["test"],
            "train_feature_count": selected_counts["train"],
            "validation_feature_count": selected_counts["val"],
        },
        "build_contract_record_sha256": build_contract["record_sha256"],
        "cache_identity_sha256": build_contract["cache_identity_sha256"],
        "capacity": {
            "actual_shard_bytes": actual_bytes,
            "float16_payload_bytes": len(plan.rows) * BYTES_PER_SAMPLE,
            "float16_payload_gib": len(plan.rows) * BYTES_PER_SAMPLE / (1024**3),
            "per_sample_bytes": BYTES_PER_SAMPLE,
        },
        "index": {
            **_descriptor(root / SAMPLE_INDEX),
            "record_count": len(plan.rows),
            "sample_order_sha256": plan.sample_order_sha256,
        },
        "model": copy.deepcopy(build_contract["model"]),
        "record_type": RECORD_TYPE,
        "schema_version": SCHEMA,
        "selection": copy.deepcopy(build_contract["selection"]),
        "shards": [copy.deepcopy(dict(item)) for item in shard_descriptors],
        "sources": copy.deepcopy(build_contract["sources"]),
        "tensor": _tensor_contract(),
        "views": _view_contract(),
    }


def build_cache(
    *,
    plan: MasterCachePlan,
    output_dir: Path,
    shard_size: int,
    image_batch_size: int,
    device: str,
    resume: bool,
    encoder_factory: Callable[[], ImageEncoder],
    image_loader: ImageLoader | None = None,
) -> Mapping[str, Any]:
    if isinstance(image_batch_size, bool) or not 1 <= image_batch_size <= 1024:
        raise HiddenStateCacheError("image-batch-size must be 1..1024")
    root = output_dir.expanduser().resolve()
    build_contract = make_build_contract(plan, shard_size=shard_size, device=device)
    initial_status = _prepare_output(
        root, plan=plan, build_contract=build_contract, resume=resume
    )
    if initial_status == "complete":
        return validate_cache_against_plan(root, plan=plan)
    shards_root = root / SHARDS_DIR
    existing = _collect_shards(
        shards_root,
        plan=plan,
        build_contract=build_contract,
        clean_staging=True,
    )
    loader = image_loader if image_loader is not None else MasterViewLoader(plan)
    encoder: ImageEncoder | None = None
    manifest_handle: BinaryIO | None = None
    if image_loader is None:
        manifest_handle = plan.manifest_path.open("rb")
    try:
        for ordinal, start, stop in _shard_ranges(len(plan.rows), shard_size):
            if ordinal in existing:
                print(
                    _canonical_json(
                        {
                            "event": "hidden_cache_shard_resumed",
                            "row_count": stop - start,
                            "shard_ordinal": ordinal,
                        }
                    ),
                    flush=True,
                )
                continue
            if encoder is None:
                encoder = encoder_factory()
            target = _write_shard(
                shards_root=shards_root,
                ordinal=ordinal,
                start=start,
                stop=stop,
                rows=plan.rows,
                build_contract=build_contract,
                encoder=encoder,
                image_loader=loader,
                image_batch_size=image_batch_size,
                manifest_handle=manifest_handle,
            )
            descriptor = _validate_shard(
                target,
                ordinal=ordinal,
                start=start,
                stop=stop,
                plan=plan,
                build_contract=build_contract,
            )
            existing[ordinal] = (target, descriptor)
            print(
                _canonical_json(
                    {
                        "event": "hidden_cache_shard_published",
                        "row_count": stop - start,
                        "shard_ordinal": ordinal,
                    }
                ),
                flush=True,
            )
    finally:
        if manifest_handle is not None:
            manifest_handle.close()
        if encoder is not None:
            encoder.close()
    expected_shards = math.ceil(len(plan.rows) / shard_size)
    if len(existing) != expected_shards:
        raise HiddenStateCacheError("cache build ended without every shard")
    descriptors = [existing[index][1] for index in range(expected_shards)]
    manifest = _seal_record(
        _manifest_core(
            root=root,
            plan=plan,
            build_contract=build_contract,
            shard_descriptors=descriptors,
        )
    )
    _atomic_write(root / MANIFEST, _json_bytes(manifest, pretty=True))
    _atomic_write(root / MARKER, _json_bytes(_complete_marker(root, build_contract), pretty=True))
    return validate_cache_against_plan(root, plan=plan)


def validate_cache_against_plan(
    cache_dir: Path, *, plan: MasterCachePlan
) -> Mapping[str, Any]:
    root = cache_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise HiddenStateCacheError("cache directory is missing or linked")
    _reject_pooled_cache(root)
    children = tuple(root.iterdir())
    if {item.name for item in children} != FINAL_ROOT_FILES or any(
        item.is_symlink() for item in children
    ):
        raise HiddenStateCacheError("completed cache exact inventory drifted")
    marker = _read_json(root / MARKER, "cache marker")
    _validate_record_seal(marker, "cache marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("status") != "complete"
    ):
        raise HiddenStateCacheError("cache ownership/status drifted")
    build_contract = _read_json(root / BUILD_CONTRACT, "build contract")
    _validate_record_seal(build_contract, "build contract")
    builder_source_sha = _require_sha256(
        build_contract.get("builder_source_code_sha256"),
        "build contract.builder_source_code_sha256",
    )
    del builder_source_sha
    sharding = _mapping(build_contract.get("sharding"), "build contract.sharding")
    device = str(_mapping(build_contract.get("model"), "build contract.model").get(
        "compute_device_kind", ""
    ))
    expected_contract = make_build_contract(
        plan, shard_size=int(sharding.get("shard_size", 0)), device=device
    )
    if _semantic_build_contract(build_contract) != _semantic_build_contract(
        expected_contract
    ):
        raise HiddenStateCacheError("cache semantic build contract drifted")
    if (root / SAMPLE_INDEX).read_bytes() != plan.sample_index_payload:
        raise HiddenStateCacheError("cache sample identity/order/master binding drifted")
    manifest = _read_json(root / MANIFEST, "cache manifest")
    _validate_record_seal(manifest, "cache manifest")
    artifacts = _mapping(marker.get("artifacts"), "cache marker.artifacts")
    for name in (BUILD_CONTRACT, SAMPLE_INDEX, MANIFEST):
        descriptor = _mapping(artifacts.get(name), f"cache marker.artifacts.{name}")
        if (
            descriptor.get("file") != name
            or descriptor.get("sha256") != _sha256_file(root / name)
            or descriptor.get("byte_size") != (root / name).stat().st_size
        ):
            raise HiddenStateCacheError(f"cache artifact descriptor drifted: {name}")
    if (
        marker.get("build_contract_record_sha256")
        != build_contract.get("record_sha256")
        or marker.get("cache_identity_sha256")
        != build_contract.get("cache_identity_sha256")
    ):
        raise HiddenStateCacheError("cache marker/build identity drifted")
    shards = _collect_shards(
        root / SHARDS_DIR,
        plan=plan,
        build_contract=build_contract,
        clean_staging=False,
    )
    expected_count = int(sharding["shard_count"])
    if len(shards) != expected_count:
        raise HiddenStateCacheError("cache shard count drifted")
    descriptors = [shards[index][1] for index in range(expected_count)]
    expected_manifest = _seal_record(
        _manifest_core(
            root=root,
            plan=plan,
            build_contract=build_contract,
            shard_descriptors=descriptors,
        )
    )
    if manifest != expected_manifest:
        raise HiddenStateCacheError("cache manifest does not match sealed shards")
    return {
        "build_contract_sha256": _sha256_file(root / BUILD_CONTRACT),
        "cache_dir": str(root),
        "cache_identity_sha256": build_contract["cache_identity_sha256"],
        "float16_payload_gib": len(plan.rows) * BYTES_PER_SAMPLE / (1024**3),
        "includes_test_features": plan.selected_split_counts["test"] > 0,
        "includes_validation_features": plan.selected_split_counts["val"] > 0,
        "label_authority": "none_pixel_features_are_not_labels",
        "master_manifest_sha256": plan.source_bindings["master_manifest_sha256"],
        "manifest_sha256": _sha256_file(root / MANIFEST),
        "model_contract_sha256": _sha256_bytes(
            _canonical_json(build_contract["model"]).encode("utf-8")
        ),
        "model_revision": MODEL_REVISION,
        "row_count": len(plan.rows),
        "sample_order_sha256": plan.sample_order_sha256,
        "sample_index_sha256": plan.sample_index_sha256,
        "schema_version": SCHEMA,
        "shard_count": expected_count,
        "status": "valid_siglip2_last_hidden_state_cache",
        "tensor_shape": [len(plan.rows), VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE],
        "training_eligible_by_itself": False,
        "view_contract_sha256": _sha256_bytes(
            _canonical_json(build_contract["views"]).encode("utf-8")
        ),
    }


def validate_cache(
    cache_dir: Path,
    *,
    master_dir: Path,
    catalog_registry: Path,
) -> Mapping[str, Any]:
    root = cache_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise HiddenStateCacheError("cache directory is missing or linked")
    _reject_pooled_cache(root)
    contract = _read_json(root / BUILD_CONTRACT, "build contract")
    _validate_record_seal(contract, "build contract")
    selection = _mapping(contract.get("selection"), "build contract.selection")
    max_samples_raw = selection.get("max_samples")
    max_samples = None if max_samples_raw is None else int(max_samples_raw)
    plan = load_master_plan(
        master_dir,
        catalog_registry=catalog_registry,
        max_samples=max_samples,
    )
    return validate_cache_against_plan(root, plan=plan)


def preflight_summary(
    plan: MasterCachePlan, *, shard_size: int, device: str
) -> Mapping[str, Any]:
    contract = make_build_contract(plan, shard_size=shard_size, device=device)
    full_payload = plan.master_total_rows * BYTES_PER_SAMPLE
    selected_payload = len(plan.rows) * BYTES_PER_SAMPLE
    return {
        "authority": _authority_contract(),
        "cache_identity_sha256": contract["cache_identity_sha256"],
        "estimated_full_master_payload_bytes": full_payload,
        "estimated_full_master_payload_gib": full_payload / (1024**3),
        "estimated_selected_payload_bytes": selected_payload,
        "estimated_selected_payload_gib": selected_payload / (1024**3),
        "master_manifest_sha256": plan.source_bindings["master_manifest_sha256"],
        "master_row_count": plan.master_total_rows,
        "model": contract["model"],
        "model_contract_sha256": _sha256_bytes(
            _canonical_json(contract["model"]).encode("utf-8")
        ),
        "sample_order_sha256": plan.sample_order_sha256,
        "schema_version": SCHEMA,
        "selected_row_count": len(plan.rows),
        "selected_split_counts": dict(plan.selected_split_counts),
        "shard_count": contract["sharding"]["shard_count"],
        "status": "ready_to_build_siglip2_last_hidden_state_cache",
        "tensor_shape": [len(plan.rows), VIEW_COUNT, PATCH_COUNT, HIDDEN_SIZE],
        "views": contract["views"],
        "view_contract_sha256": _sha256_bytes(
            _canonical_json(contract["views"]).encode("utf-8")
        ),
    }


def _add_source_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--master-dir", type=Path, default=DEFAULT_MASTER_DIR)
    parser.add_argument(
        "--catalog-registry", type=Path, default=DEFAULT_CATALOG_REGISTRY
    )


def _add_plan_arguments(parser: argparse.ArgumentParser) -> None:
    _add_source_arguments(parser)
    parser.add_argument("--max-samples", type=int)
    parser.add_argument("--shard-size", type=int, default=DEFAULT_SHARD_SIZE)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("preflight", help="validate metadata and size only")
    _add_plan_arguments(preflight)
    build = commands.add_parser("build", help="build or resume sealed hidden-state shards")
    _add_plan_arguments(build)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--image-batch-size", type=int, default=DEFAULT_IMAGE_BATCH_SIZE)
    build.add_argument("--resume", action="store_true")
    validate = commands.add_parser("validate", help="validate a completed cache")
    _add_source_arguments(validate)
    validate.add_argument("--cache-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "validate":
        result = validate_cache(
            args.cache_dir,
            master_dir=args.master_dir,
            catalog_registry=args.catalog_registry,
        )
    else:
        if args.device == "cpu" and (
            args.max_samples is None or args.max_samples > MAX_CPU_SMOKE_SAMPLES
        ):
            raise HiddenStateCacheError(
                f"CPU builds require --max-samples <= {MAX_CPU_SMOKE_SAMPLES}"
            )
        plan = load_master_plan(
            args.master_dir,
            catalog_registry=args.catalog_registry,
            max_samples=args.max_samples,
        )
        if args.command == "preflight":
            result = preflight_summary(
                plan, shard_size=args.shard_size, device=args.device
            )
        else:
            result = build_cache(
                plan=plan,
                output_dir=args.output_dir,
                shard_size=args.shard_size,
                image_batch_size=args.image_batch_size,
                device=args.device,
                resume=args.resume,
                encoder_factory=lambda: Siglip2HiddenStateEncoder(device=args.device),
            )
    print(_canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
