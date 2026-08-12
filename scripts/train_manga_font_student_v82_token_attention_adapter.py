#!/usr/bin/env python3
"""Train a pixel-token residual on top of the frozen v8.1 font adapter.

Two deliberately small input paths are supported:

* ``fixed_sketch`` caches a label-free orthogonal 256->R projection after the
  sealed R5 token norm/projection.  It is the fast baseline.
* ``trainable_raw`` preloads only train human/visual raw hidden tokens and
  learns LayerNorm(768)+Linear(768,R).  Validation tokens are streamed from
  the sealed hidden cache, so no validation label enters the optimizer.

Both paths use four token-attention probes and bounded candidate/family
residuals.  The base r3h adapter is frozen.  Checkpoint selection uses only the
work-disjoint visual authority plus all-row Single Day drift; val33 is reported
after selection and never supplies a gradient or checkpoint score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_manga_font_master_v3_siglip2_hidden_cache as hidden
    from scripts import build_manga_font_student_v8_role_family_dataset as dataset
    from scripts import export_manga_font_student_v8_runtime_onnx as exporter
    from scripts import train_manga_font_student_v8_role_family_adapter as base
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_master_v3_siglip2_hidden_cache as hidden
    import build_manga_font_student_v8_role_family_dataset as dataset
    import export_manga_font_student_v8_runtime_onnx as exporter
    import train_manga_font_student_v8_role_family_adapter as base


CACHE_SCHEMA = "manga-font-v82-fixed-token-sketch-cache-v1"
CACHE_OWNER = "carrot-manga-translator/manga-font-v82-fixed-token-sketch-cache-v1"
CACHE_ARRAY = "token-sketch.f16.npy"
CACHE_PROJECTION = "fixed-projection.f32.npy"
CACHE_MANIFEST = "manifest.json"
CACHE_MARKER = ".manga-font-v82-fixed-token-sketch-cache-owned.json"
CACHE_FILES = frozenset(
    {CACHE_ARRAY, CACHE_PROJECTION, CACHE_MANIFEST, CACHE_MARKER}
)

OUTPUT_SCHEMA = "manga-font-student-v82-token-attention-adapter-v1"
OUTPUT_OWNER = "carrot-manga-translator/manga-font-student-v82-token-attention-adapter-v1"
OUTPUT_CHECKPOINT = "token-attention-adapter.safetensors"
OUTPUT_MANIFEST = "manifest.json"
OUTPUT_MARKER = ".manga-font-student-v82-token-attention-adapter-owned.json"
OUTPUT_FILES = frozenset({OUTPUT_CHECKPOINT, OUTPUT_MANIFEST, OUTPUT_MARKER})

INPUT_MODES = ("fixed_sketch", "trainable_raw")
VIEW_COUNT = 3
PATCH_COUNT = hidden.PATCH_COUNT
RAW_DIM = hidden.HIDDEN_SIZE
R5_PROJECTED_DIM = dataset.QUERY_DIM
DEFAULT_RANK = 32
DEFAULT_ATTENTION_QUERIES = 4


class TokenAttentionAdapterError(ValueError):
    """Raised when a v8.2 data or model boundary is violated."""


@dataclass(frozen=True)
class CacheIndexBinding:
    cache_index: int
    output_index: int


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TokenAttentionAdapterError(f"{location}: expected object")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TokenAttentionAdapterError(f"{location}: invalid JSON") from error
    return _mapping(value, location)


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise TokenAttentionAdapterError(f"unsafe output directory: {result}")
    return result


def _sample_order_sha256(sample_ids: Sequence[str]) -> str:
    return hashlib.sha256(("\n".join(sample_ids) + "\n").encode("utf-8")).hexdigest()


def _validate_sealed_record(value: Mapping[str, Any], location: str) -> None:
    core = dict(value)
    expected = core.pop("record_sha256", None)
    actual = base.seal_record(core)["record_sha256"]
    if expected != actual:
        raise TokenAttentionAdapterError(f"{location}: record seal drifted")


def deterministic_orthogonal_projection(
    input_dim: int, output_dim: int, seed: int
) -> np.ndarray:
    """Create a label-free, reproducible JL-style orthogonal projection."""

    if not 1 <= output_dim <= input_dim or input_dim < 2:
        raise TokenAttentionAdapterError("invalid fixed projection dimensions")
    generator = np.random.default_rng(seed)
    values = generator.standard_normal((input_dim, output_dim), dtype=np.float64)
    projection, _ = np.linalg.qr(values, mode="reduced")
    result = np.ascontiguousarray(projection, dtype="<f4")
    error = np.max(np.abs(result.T @ result - np.eye(output_dim, dtype=np.float32)))
    if not np.isfinite(result).all() or float(error) > 2e-5:
        raise TokenAttentionAdapterError("fixed projection orthogonality drifted")
    return result


def _load_dataset_arrays(path: Path) -> tuple[Path, dict[str, np.ndarray]]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise TokenAttentionAdapterError("dataset NPZ is missing or linked")
    with np.load(resolved, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    base.validate_training_arrays(arrays, candidate_count=len(arrays["candidate_ids"]))
    return resolved, arrays


def _cache_indices_for_samples(
    cache_root: Path, sample_ids: Sequence[str]
) -> np.ndarray:
    wanted = frozenset(str(value) for value in sample_ids)
    if len(wanted) != len(sample_ids):
        raise TokenAttentionAdapterError("dataset sample IDs are duplicated")
    found: dict[str, int] = {}
    index_path = cache_root / hidden.SAMPLE_INDEX
    with index_path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise TokenAttentionAdapterError(
                    f"hidden sample index:{line_number}: invalid JSON"
                ) from error
            sample_id = value.get("sample_id")
            if sample_id in wanted:
                if sample_id in found:
                    raise TokenAttentionAdapterError("hidden cache sample duplicated")
                found[str(sample_id)] = int(value["cache_index"])
    if set(found) != set(wanted):
        raise TokenAttentionAdapterError(
            f"hidden cache misses {len(wanted - set(found))} dataset samples"
        )
    return np.asarray([found[str(value)] for value in sample_ids], dtype=np.int64)


def _hidden_batches(
    *,
    cache_root: Path,
    cache_manifest: Mapping[str, Any],
    cache_indices: np.ndarray,
    positions: Sequence[int],
    batch_size: int,
) -> Iterable[tuple[np.ndarray, np.ndarray]]:
    """Yield dataset positions and raw f16 tokens in cache-local IO order."""

    if batch_size < 1 or batch_size > 512:
        raise TokenAttentionAdapterError("hidden batch size must be 1..512")
    ordered = sorted(
        (
            CacheIndexBinding(int(cache_indices[position]), int(position))
            for position in positions
        ),
        key=lambda value: value.cache_index,
    )
    descriptors = tuple(
        _mapping(value, "hidden shard")
        for value in cache_manifest.get("shards", ())
    )
    pointer = 0
    for descriptor in descriptors:
        start = int(descriptor["start_cache_index"])
        stop = int(descriptor["end_cache_index_exclusive"])
        selected: list[CacheIndexBinding] = []
        while pointer < len(ordered) and ordered[pointer].cache_index < stop:
            item = ordered[pointer]
            if item.cache_index < start:
                raise TokenAttentionAdapterError("hidden cache index is uncovered")
            selected.append(item)
            pointer += 1
        if not selected:
            continue
        array_path = (
            cache_root
            / hidden.SHARDS_DIR
            / str(descriptor["directory"])
            / hidden.SHARD_ARRAY
        )
        values = np.load(array_path, mmap_mode="r", allow_pickle=False)
        try:
            local = [item.cache_index - start for item in selected]
            output_positions = [item.output_index for item in selected]
            for offset in range(0, len(local), batch_size):
                local_batch = local[offset : offset + batch_size]
                position_batch = np.asarray(
                    output_positions[offset : offset + batch_size], dtype=np.int64
                )
                tokens = np.array(values[local_batch], dtype="<f2", copy=True)
                if tokens.shape != (
                    len(local_batch),
                    VIEW_COUNT,
                    PATCH_COUNT,
                    RAW_DIM,
                ) or not np.isfinite(tokens).all():
                    raise TokenAttentionAdapterError("hidden token batch drifted")
                yield position_batch, tokens
        finally:
            mapped = getattr(values, "_mmap", None)
            if mapped is not None:
                mapped.close()
    if pointer != len(ordered):
        raise TokenAttentionAdapterError("hidden cache coverage is incomplete")


def _publish_directory(staging: Path, output: Path) -> None:
    if output.exists():
        raise TokenAttentionAdapterError("refusing to replace existing output")
    os.rename(staging, output)


def build_fixed_sketch_cache(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    output = _safe_output(args.output_dir)
    if output.exists():
        raise TokenAttentionAdapterError("fixed sketch output already exists")
    dataset_path, arrays = _load_dataset_arrays(args.dataset_npz)
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    cache_root = args.hidden_cache_dir.expanduser().resolve()
    cache_manifest = _read_json(cache_root / hidden.MANIFEST, "hidden manifest")
    cache_indices = _cache_indices_for_samples(cache_root, sample_ids)
    projection = deterministic_orthogonal_projection(
        R5_PROJECTED_DIM, args.rank, args.projection_seed
    )
    torch, head, _prototypes, model_binding = dataset._load_r5_head_and_prototypes(  # noqa: SLF001
        args.r5_output_dir.expanduser().resolve(), device_name=args.device
    )
    device = torch.device(args.device)
    projection_tensor = torch.from_numpy(projection).to(device)

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        np.save(staging / CACHE_PROJECTION, projection, allow_pickle=False)
        sketch = np.lib.format.open_memmap(
            staging / CACHE_ARRAY,
            mode="w+",
            dtype="<f2",
            shape=(len(sample_ids), VIEW_COUNT, PATCH_COUNT, args.rank),
        )
        written = np.zeros(len(sample_ids), dtype=bool)
        with torch.inference_mode():
            for positions, tokens in _hidden_batches(
                cache_root=cache_root,
                cache_manifest=cache_manifest,
                cache_indices=cache_indices,
                positions=range(len(sample_ids)),
                batch_size=args.batch_size,
            ):
                tensor = torch.from_numpy(tokens).to(device)
                flattened = tensor.reshape(-1, PATCH_COUNT, RAW_DIM)
                projected = head.token_projection(head.token_norm(flattened.float()))
                reduced = torch.matmul(projected, projection_tensor).reshape(
                    len(positions), VIEW_COUNT, PATCH_COUNT, args.rank
                )
                values = reduced.float().cpu().numpy().astype("<f2")
                if not np.isfinite(values).all():
                    raise TokenAttentionAdapterError("fixed token sketch is nonfinite")
                sketch[positions] = values
                written[positions] = True
        sketch.flush()
        del sketch
        if not bool(written.all()):
            raise TokenAttentionAdapterError("fixed sketch write coverage failed")
        manifest = base.seal_record(
            {
                "artifacts": {
                    CACHE_ARRAY: {
                        "byte_size": (staging / CACHE_ARRAY).stat().st_size,
                        "sha256": base.sha256_file(staging / CACHE_ARRAY),
                        "shape": [
                            len(sample_ids),
                            VIEW_COUNT,
                            PATCH_COUNT,
                            args.rank,
                        ],
                        "dtype": "float16",
                    },
                    CACHE_PROJECTION: {
                        "byte_size": (staging / CACHE_PROJECTION).stat().st_size,
                        "sha256": base.sha256_file(staging / CACHE_PROJECTION),
                        "shape": [R5_PROJECTED_DIM, args.rank],
                        "dtype": "float32",
                    },
                },
                "build_seconds": time.perf_counter() - started,
                "projection": {
                    "input": "sealed_r5_token_norm_and_projection_768_to_256",
                    "kind": "label_free_seeded_orthogonal",
                    "output_rank": args.rank,
                    "seed": args.projection_seed,
                },
                "record_type": "manga_font_v82_fixed_token_sketch_cache",
                "sample_count": len(sample_ids),
                "sample_order_sha256": _sample_order_sha256(sample_ids),
                "schema_version": CACHE_SCHEMA,
                "sources": {
                    "dataset_npz_sha256": base.sha256_file(dataset_path),
                    "hidden_manifest_sha256": base.sha256_file(
                        cache_root / hidden.MANIFEST
                    ),
                    "hidden_sample_index_sha256": base.sha256_file(
                        cache_root / hidden.SAMPLE_INDEX
                    ),
                    "r5_model": dict(model_binding),
                },
                "training_labels_read": False,
            }
        )
        (staging / CACHE_MANIFEST).write_bytes(base.json_bytes(manifest, pretty=True))
        marker = base.seal_record(
            {
                "artifacts": {
                    name: base.sha256_file(staging / name)
                    for name in (CACHE_ARRAY, CACHE_PROJECTION, CACHE_MANIFEST)
                },
                "owner": CACHE_OWNER,
                "safe_replace": True,
                "schema_version": CACHE_SCHEMA,
            }
        )
        (staging / CACHE_MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_fixed_sketch_cache(
            output_dir=staging, dataset_npz=dataset_path, verify_payload=True
        )
        _publish_directory(staging, output)
        published = True
        return validate_fixed_sketch_cache(
            output_dir=output, dataset_npz=dataset_path, verify_payload=False
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_fixed_sketch_cache(
    *, output_dir: Path, dataset_npz: Path, verify_payload: bool
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or set(path.name for path in root.iterdir()) != CACHE_FILES:
        raise TokenAttentionAdapterError("fixed sketch cache inventory drifted")
    marker = _read_json(root / CACHE_MARKER, "fixed sketch marker")
    manifest = _read_json(root / CACHE_MANIFEST, "fixed sketch manifest")
    _validate_sealed_record(marker, "fixed sketch marker")
    _validate_sealed_record(manifest, "fixed sketch manifest")
    if (
        marker.get("owner") != CACHE_OWNER
        or marker.get("schema_version") != CACHE_SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != CACHE_SCHEMA
        or manifest.get("training_labels_read") is not False
    ):
        raise TokenAttentionAdapterError("fixed sketch metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "fixed sketch artifacts")
    for name in (CACHE_ARRAY, CACHE_PROJECTION, CACHE_MANIFEST):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise TokenAttentionAdapterError(f"fixed sketch hash drifted: {name}")
    dataset_path, arrays = _load_dataset_arrays(dataset_npz)
    sources = _mapping(manifest.get("sources"), "fixed sketch sources")
    if sources.get("dataset_npz_sha256") != base.sha256_file(dataset_path):
        raise TokenAttentionAdapterError("fixed sketch dataset binding drifted")
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    if manifest.get("sample_order_sha256") != _sample_order_sha256(sample_ids):
        raise TokenAttentionAdapterError("fixed sketch sample order drifted")
    rank = int(_mapping(manifest.get("projection"), "projection").get("output_rank", 0))
    sketch = np.load(root / CACHE_ARRAY, mmap_mode="r", allow_pickle=False)
    projection = np.load(root / CACHE_PROJECTION, allow_pickle=False)
    try:
        if (
            sketch.shape != (len(sample_ids), VIEW_COUNT, PATCH_COUNT, rank)
            or sketch.dtype != np.dtype("<f2")
            or projection.shape != (R5_PROJECTED_DIM, rank)
            or projection.dtype != np.dtype("<f4")
            or not np.isfinite(projection).all()
        ):
            raise TokenAttentionAdapterError("fixed sketch tensor contract drifted")
        if verify_payload and not np.isfinite(sketch).all():
            raise TokenAttentionAdapterError("fixed sketch payload is nonfinite")
    finally:
        mapped = getattr(sketch, "_mmap", None)
        if mapped is not None:
            mapped.close()
    return {
        "output_dir": str(root),
        "rank": rank,
        "row_count": len(sample_ids),
        "schema_version": CACHE_SCHEMA,
        "status": "valid_fixed_token_sketch_cache",
    }


def build_token_attention_residual(
    torch: Any,
    *,
    candidate_count: int,
    input_mode: str,
    rank: int,
    attention_queries: int,
    hidden_dim: int,
    dropout: float,
    maximum_candidate_residual: float,
    maximum_family_residual: float,
) -> Any:
    """Build the tiny token-attention residual; the r3h base stays external."""

    if input_mode not in INPUT_MODES:
        raise TokenAttentionAdapterError("unsupported token input mode")
    if not 8 <= rank <= 128 or not 1 <= attention_queries <= 8:
        raise TokenAttentionAdapterError("token adapter rank/query count is invalid")
    if hidden_dim < 16 or not 0 <= dropout < 0.5:
        raise TokenAttentionAdapterError("token adapter hidden/dropout is invalid")
    input_dim = rank if input_mode == "fixed_sketch" else RAW_DIM

    class TokenAttentionResidual(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.input_norm = torch.nn.LayerNorm(input_dim)
            self.input_projection = (
                torch.nn.Identity()
                if input_mode == "fixed_sketch"
                else torch.nn.Linear(input_dim, rank, bias=False)
            )
            self.attention_queries = torch.nn.Parameter(
                torch.empty(attention_queries, rank)
            )
            self.value_projection = torch.nn.Linear(rank, rank, bias=False)
            self.dropout = torch.nn.Dropout(dropout)
            self.trunk = torch.nn.Sequential(
                torch.nn.LayerNorm(attention_queries * rank),
                torch.nn.Linear(attention_queries * rank, hidden_dim),
                torch.nn.GELU(),
                torch.nn.Dropout(dropout),
            )
            self.candidate_head = torch.nn.Linear(
                hidden_dim, 2 * candidate_count
            )
            self.family_head = torch.nn.Linear(hidden_dim, 2)
            torch.nn.init.normal_(self.attention_queries, std=0.02)
            torch.nn.init.zeros_(self.candidate_head.weight)
            torch.nn.init.zeros_(self.candidate_head.bias)
            torch.nn.init.zeros_(self.family_head.weight)
            torch.nn.init.zeros_(self.family_head.bias)

        def forward(self, tokens: Any) -> Mapping[str, Any]:
            expected_dim = rank if input_mode == "fixed_sketch" else RAW_DIM
            if tokens.ndim != 4 or tuple(tokens.shape[1:4]) != (
                VIEW_COUNT,
                PATCH_COUNT,
                expected_dim,
            ):
                raise TokenAttentionAdapterError("token residual input shape drifted")
            normalized = self.input_norm(tokens.float())
            projected = self.dropout(self.input_projection(normalized))
            queries = torch.nn.functional.normalize(
                self.attention_queries.float(), p=2, dim=-1
            )
            attention = torch.softmax(
                torch.einsum("qd,bvpd->bvqp", queries, projected)
                / math.sqrt(rank),
                dim=-1,
            )
            values = self.value_projection(projected)
            pooled = torch.einsum("bvqp,bvpd->bvqd", attention, values).mean(dim=1)
            features = self.trunk(pooled.flatten(start_dim=1))
            candidate = float(maximum_candidate_residual) * torch.tanh(
                self.candidate_head(features).reshape(-1, 2, candidate_count)
            )
            family = float(maximum_family_residual) * torch.tanh(
                self.family_head(features)
            )
            return {
                "attention": attention,
                "candidate_residual": candidate,
                "family_residual": family,
            }

    return TokenAttentionResidual()


def combine_with_base(
    base_outputs: Mapping[str, Any], residual_outputs: Mapping[str, Any]
) -> Mapping[str, Any]:
    candidate = residual_outputs["candidate_residual"]
    return {
        "body_candidate_scores": base_outputs["body_candidate_scores"] + candidate[:, 0],
        "variant_candidate_scores": base_outputs["variant_candidate_scores"] + candidate[:, 1],
        "family_logits": base_outputs["family_logits"] + residual_outputs["family_residual"],
        "family_candidate_bias": candidate.mean(dim=0),
        "sample_candidate_residual": candidate,
    }


def _base_outputs(
    *, torch: Any, adapter: Any, arrays: Mapping[str, np.ndarray], device: Any, batch_size: int
) -> dict[str, np.ndarray]:
    names = ("body_candidate_scores", "variant_candidate_scores", "family_logits")
    collected: dict[str, list[np.ndarray]] = {name: [] for name in names}
    prototypes = torch.from_numpy(arrays["prototype_queries"].astype(np.float32)).to(device)
    adapter.to(device).eval().requires_grad_(False)
    with torch.inference_mode():
        for start in range(0, len(arrays["sample_ids"]), batch_size):
            views = torch.from_numpy(
                arrays["query_views"][start : start + batch_size].astype(np.float32)
            ).to(device)
            output = adapter(views, prototypes)
            for name in names:
                collected[name].append(output[name].float().cpu().numpy())
    return {name: np.concatenate(values) for name, values in collected.items()}


def _preload_raw_train(
    *,
    cache_root: Path,
    cache_manifest: Mapping[str, Any],
    cache_indices: np.ndarray,
    train_positions: np.ndarray,
    batch_size: int,
) -> np.ndarray:
    output = np.empty(
        (len(train_positions), VIEW_COUNT, PATCH_COUNT, RAW_DIM), dtype="<f2"
    )
    local = {int(position): index for index, position in enumerate(train_positions.tolist())}
    written = np.zeros(len(train_positions), dtype=bool)
    for positions, tokens in _hidden_batches(
        cache_root=cache_root,
        cache_manifest=cache_manifest,
        cache_indices=cache_indices,
        positions=train_positions.tolist(),
        batch_size=batch_size,
    ):
        local_positions = np.asarray([local[int(value)] for value in positions], dtype=np.int64)
        output[local_positions] = tokens
        written[local_positions] = True
    if not bool(written.all()):
        raise TokenAttentionAdapterError("raw train preload coverage failed")
    return output


def _infer_residuals_fixed(
    *, torch: Any, model: Any, sketch: Any, positions: np.ndarray, device: Any, batch_size: int
) -> dict[str, np.ndarray]:
    candidates: list[np.ndarray] = []
    families: list[np.ndarray] = []
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(positions), batch_size):
            selected = positions[start : start + batch_size]
            tokens = torch.from_numpy(np.array(sketch[selected], dtype="<f2", copy=True)).to(device)
            output = model(tokens)
            candidates.append(output["candidate_residual"].float().cpu().numpy())
            families.append(output["family_residual"].float().cpu().numpy())
    return {
        "candidate_residual": np.concatenate(candidates),
        "family_residual": np.concatenate(families),
    }


def _infer_residuals_raw_streaming(
    *,
    torch: Any,
    model: Any,
    cache_root: Path,
    cache_manifest: Mapping[str, Any],
    cache_indices: np.ndarray,
    positions: np.ndarray,
    device: Any,
    batch_size: int,
) -> dict[str, np.ndarray]:
    candidate_count = int(model.candidate_head.out_features // 2)
    candidate = np.empty((len(positions), 2, candidate_count), dtype="<f4")
    family = np.empty((len(positions), 2), dtype="<f4")
    local = {int(position): index for index, position in enumerate(positions.tolist())}
    written = np.zeros(len(positions), dtype=bool)
    model.eval()
    with torch.inference_mode():
        for dataset_positions, tokens in _hidden_batches(
            cache_root=cache_root,
            cache_manifest=cache_manifest,
            cache_indices=cache_indices,
            positions=positions.tolist(),
            batch_size=batch_size,
        ):
            output = model(torch.from_numpy(tokens).to(device))
            target = np.asarray(
                [local[int(value)] for value in dataset_positions], dtype=np.int64
            )
            candidate[target] = output["candidate_residual"].float().cpu().numpy()
            family[target] = output["family_residual"].float().cpu().numpy()
            written[target] = True
    if not bool(written.all()):
        raise TokenAttentionAdapterError("raw validation stream coverage failed")
    return {"candidate_residual": candidate, "family_residual": family}


def _numpy_outputs_for_positions(
    base_outputs: Mapping[str, np.ndarray],
    residuals: Mapping[str, np.ndarray],
    positions: np.ndarray,
) -> dict[str, np.ndarray]:
    candidate = residuals["candidate_residual"]
    return {
        "body_candidate_scores": base_outputs["body_candidate_scores"][positions] + candidate[:, 0],
        "variant_candidate_scores": base_outputs["variant_candidate_scores"][positions] + candidate[:, 1],
        "family_logits": base_outputs["family_logits"][positions] + residuals["family_residual"],
    }


def _metrics(
    *,
    torch: Any,
    outputs: Mapping[str, np.ndarray],
    arrays: Mapping[str, np.ndarray],
    positions: np.ndarray,
    font_weights: np.ndarray,
    candidate_ids: Sequence[str],
    device: Any,
) -> Mapping[str, Any]:
    tensor_outputs = {
        name: torch.from_numpy(value.astype(np.float32)).to(device)
        for name, value in outputs.items()
    }
    return base.compute_metrics(
        torch,
        tensor_outputs,
        family_labels=torch.from_numpy(arrays["family_labels"][positions]).to(device),
        positive_mask=torch.from_numpy(arrays["positive_mask"][positions]).to(device),
        preferred_mask=torch.from_numpy(arrays["preferred_mask"][positions]).to(device),
        font_supervision_weights=torch.from_numpy(font_weights.astype(np.float32)).to(device),
        single_day_body_negative=torch.from_numpy(
            arrays["single_day_body_negative"][positions]
        ).to(device),
        single_day_index=candidate_ids.index("single-day"),
        candidate_ids=candidate_ids,
    )


def _val33_positions(sample_ids: np.ndarray, finals_path: Path) -> np.ndarray:
    ids: list[str] = []
    with finals_path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                ids.append(str(value["sample_id"]))
    if len(ids) != 33 or len(set(ids)) != 33:
        raise TokenAttentionAdapterError("val33 identity inventory drifted")
    lookup = {str(value): index for index, value in enumerate(sample_ids.tolist())}
    if set(ids) - set(lookup):
        raise TokenAttentionAdapterError("val33 rows are absent from v8.2 dataset")
    return np.asarray([lookup[value] for value in ids], dtype=np.int64)


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    output = _safe_output(args.output_dir)
    if output.exists():
        raise TokenAttentionAdapterError("v8.2 output already exists")
    dataset_path, arrays = _load_dataset_arrays(args.dataset_npz)
    candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    authorities = arrays["font_authority"].astype(str)
    train_rows = (
        (arrays["split"] == 0)
        & np.isin(authorities, ("human", "visual"))
        & (arrays["font_supervision_weights"] > 0)
    )
    train_positions = np.flatnonzero(train_rows)
    if len(train_positions) != 2117:
        raise TokenAttentionAdapterError("optimizer authority must be exact train human+visual")
    val_positions = np.flatnonzero(arrays["split"] == 1)
    visual_val_mask = authorities[val_positions] == "visual"
    if len(val_positions) != 9033 or int(visual_val_mask.sum()) != 1047:
        raise TokenAttentionAdapterError("r3 work-holdout validation boundary drifted")

    import torch
    from safetensors.torch import save_file

    if args.device == "cuda" and not torch.cuda.is_available():
        raise TokenAttentionAdapterError("CUDA requested but unavailable")
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda":
        torch.set_float32_matmul_precision("high")
    base_adapter = exporter.load_adapter(
        adapter_dir=args.base_adapter_dir,
        candidate_ids=candidate_ids,
        allow_failed_quality=False,
    )
    frozen_outputs = _base_outputs(
        torch=torch,
        adapter=base_adapter,
        arrays=arrays,
        device=device,
        batch_size=args.base_batch_size,
    )
    del base_adapter
    if device.type == "cuda":
        torch.cuda.empty_cache()

    cache_root = args.hidden_cache_dir.expanduser().resolve()
    cache_manifest = _read_json(cache_root / hidden.MANIFEST, "hidden manifest")
    sample_ids = tuple(str(value) for value in arrays["sample_ids"].tolist())
    cache_indices = _cache_indices_for_samples(cache_root, sample_ids)
    sketch = None
    raw_train_tensor = None
    cache_binding: Mapping[str, Any] | None = None
    if args.input_mode == "fixed_sketch":
        if args.fixed_sketch_cache is None:
            raise TokenAttentionAdapterError("fixed_sketch mode requires its cache")
        cache_validation = validate_fixed_sketch_cache(
            output_dir=args.fixed_sketch_cache,
            dataset_npz=dataset_path,
            verify_payload=False,
        )
        if int(cache_validation["rank"]) != args.rank:
            raise TokenAttentionAdapterError("fixed sketch rank differs from model rank")
        sketch = np.load(
            args.fixed_sketch_cache.expanduser().resolve() / CACHE_ARRAY,
            mmap_mode="r",
            allow_pickle=False,
        )
        cache_binding = {
            "fixed_sketch_manifest_sha256": base.sha256_file(
                args.fixed_sketch_cache.expanduser().resolve() / CACHE_MANIFEST
            ),
            "fixed_projection_sha256": base.sha256_file(
                args.fixed_sketch_cache.expanduser().resolve() / CACHE_PROJECTION
            ),
        }
    else:
        raw_train = _preload_raw_train(
            cache_root=cache_root,
            cache_manifest=cache_manifest,
            cache_indices=cache_indices,
            train_positions=train_positions,
            batch_size=args.hidden_batch_size,
        )
        preload_device = (
            device
            if args.raw_preload_device == "cuda" and device.type == "cuda"
            else torch.device("cpu")
        )
        raw_train_tensor = torch.from_numpy(raw_train).to(preload_device)
        del raw_train
        cache_binding = {
            "hidden_manifest_sha256": base.sha256_file(cache_root / hidden.MANIFEST),
            "raw_train_preload_device": str(preload_device),
        }

    model = build_token_attention_residual(
        torch,
        candidate_count=len(candidate_ids),
        input_mode=args.input_mode,
        rank=args.rank,
        attention_queries=args.attention_queries,
        hidden_dim=args.hidden_dim,
        dropout=args.dropout,
        maximum_candidate_residual=args.maximum_candidate_residual,
        maximum_family_residual=args.maximum_family_residual,
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    candidate_weight_values, candidate_weight_report = base.build_candidate_training_weights(
        arrays,
        rare_class_cap=args.rare_class_weight_cap,
        human_multiplier=args.human_candidate_weight_multiplier,
    )
    train_local_by_position = {
        int(position): local for local, position in enumerate(train_positions.tolist())
    }
    generator = np.random.default_rng(args.seed)
    best_state: dict[str, Any] | None = None
    best_epoch: Mapping[str, Any] | None = None
    best_key: tuple[float, ...] | None = None
    history: list[Mapping[str, Any]] = []

    def batch_array(name: str, selected: np.ndarray, dtype: Any | None = None) -> Any:
        values = arrays[name][selected]
        if dtype is not None:
            values = values.astype(dtype, copy=False)
        return torch.from_numpy(values).to(device)

    for epoch in range(1, args.epochs + 1):
        model.train()
        shuffled = generator.permutation(train_positions)
        losses: list[float] = []
        for start in range(0, len(shuffled), args.batch_size):
            selected = shuffled[start : start + args.batch_size]
            if args.input_mode == "fixed_sketch":
                assert sketch is not None
                token_tensor = torch.from_numpy(
                    np.array(sketch[selected], dtype="<f2", copy=True)
                ).to(device)
            else:
                assert raw_train_tensor is not None
                local = torch.as_tensor(
                    [train_local_by_position[int(value)] for value in selected],
                    dtype=torch.long,
                    device=raw_train_tensor.device,
                )
                token_tensor = raw_train_tensor[local]
                if token_tensor.device != device:
                    token_tensor = token_tensor.to(device)
            residual = model(token_tensor)
            base_batch = {
                name: torch.from_numpy(values[selected].astype(np.float32)).to(device)
                for name, values in frozen_outputs.items()
            }
            outputs = combine_with_base(base_batch, residual)
            optimizer.zero_grad(set_to_none=True)
            loss, _parts = base.role_family_training_loss(
                torch,
                outputs,
                family_labels=batch_array("family_labels", selected),
                positive_mask=batch_array("positive_mask", selected),
                preferred_mask=batch_array("preferred_mask", selected),
                candidate_eligible_mask=batch_array("candidate_eligible_mask", selected),
                font_supervision_weights=batch_array(
                    "font_supervision_weights", selected, np.float32
                ),
                candidate_loss_weights=torch.from_numpy(
                    candidate_weight_values[selected].astype(np.float32)
                ).to(device),
                family_label_weights=batch_array(
                    "family_label_weights", selected, np.float32
                ),
                single_day_body_negative=batch_array(
                    "single_day_body_negative", selected
                ),
                single_day_index=candidate_ids.index("single-day"),
                family_weight=args.family_weight,
                hard_negative_weight=args.single_day_hard_negative_weight,
                hard_negative_margin=args.single_day_hard_negative_margin,
                bias_l2_weight=args.residual_l2_weight,
                candidate_distribution_weight=args.candidate_distribution_weight,
                candidate_distribution_slack=args.candidate_distribution_slack,
                candidate_distribution_temperature=args.candidate_distribution_temperature,
                sample_residual_l2_weight=args.residual_l2_weight,
                supervised_single_day_hard_negative_weight=(
                    args.supervised_single_day_hard_negative_weight
                ),
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))

        should_evaluate = epoch == args.epochs or epoch % args.evaluation_interval == 0
        epoch_record: dict[str, Any] = {
            "epoch": epoch,
            "mean_train_loss": sum(losses) / max(1, len(losses)),
            "selection_evaluated": should_evaluate,
        }
        if should_evaluate:
            if args.input_mode == "fixed_sketch":
                assert sketch is not None
                residuals = _infer_residuals_fixed(
                    torch=torch,
                    model=model,
                    sketch=sketch,
                    positions=val_positions,
                    device=device,
                    batch_size=args.validation_batch_size,
                )
            else:
                residuals = _infer_residuals_raw_streaming(
                    torch=torch,
                    model=model,
                    cache_root=cache_root,
                    cache_manifest=cache_manifest,
                    cache_indices=cache_indices,
                    positions=val_positions,
                    device=device,
                    batch_size=args.hidden_batch_size,
                )
            outputs = _numpy_outputs_for_positions(
                frozen_outputs, residuals, val_positions
            )
            visual_only_weights = np.where(
                visual_val_mask,
                arrays["font_supervision_weights"][val_positions],
                0.0,
            ).astype(np.float32)
            selection_metrics = _metrics(
                torch=torch,
                outputs=outputs,
                arrays=arrays,
                positions=val_positions,
                font_weights=visual_only_weights,
                candidate_ids=candidate_ids,
                device=device,
            )
            visual_local = np.flatnonzero(visual_val_mask)
            visual_positions = val_positions[visual_local]
            visual_outputs = {name: value[visual_local] for name, value in outputs.items()}
            visual_metrics = _metrics(
                torch=torch,
                outputs=visual_outputs,
                arrays=arrays,
                positions=visual_positions,
                font_weights=arrays["font_supervision_weights"][visual_positions],
                candidate_ids=candidate_ids,
                device=device,
            )
            checks = base.build_quality_gate_checks(selection_metrics, visual_metrics)
            passed = all(checks.values())
            epoch_record.update(
                {
                    "quality_checks": checks,
                    "quality_passed": passed,
                    "selection_metrics": selection_metrics,
                    "visual_metrics": visual_metrics,
                }
            )
            key = (
                float(passed),
                float(visual_metrics["acceptable_at1"]),
                float(visual_metrics["preferred_at1"]),
                float(selection_metrics["family_accuracy"]),
                -float(selection_metrics["single_day_eligibility"]["eligible_top1_all_rows_rate"]),
            )
            if best_key is None or key > best_key:
                best_key = key
                best_epoch = json.loads(json.dumps(epoch_record))
                best_state = {
                    name: value.detach().cpu().clone()
                    for name, value in model.state_dict().items()
                }
        history.append(epoch_record)

    if best_state is None or best_epoch is None:
        raise TokenAttentionAdapterError("v8.2 produced no evaluated checkpoint")
    model.load_state_dict(best_state, strict=True)

    val33 = _val33_positions(arrays["sample_ids"], args.val33_finals)
    if args.input_mode == "fixed_sketch":
        assert sketch is not None
        val33_residual = _infer_residuals_fixed(
            torch=torch,
            model=model,
            sketch=sketch,
            positions=val33,
            device=device,
            batch_size=args.validation_batch_size,
        )
    else:
        val33_residual = _infer_residuals_raw_streaming(
            torch=torch,
            model=model,
            cache_root=cache_root,
            cache_manifest=cache_manifest,
            cache_indices=cache_indices,
            positions=val33,
            device=device,
            batch_size=args.hidden_batch_size,
        )
    val33_outputs = _numpy_outputs_for_positions(
        frozen_outputs, val33_residual, val33
    )
    val33_metrics = _metrics(
        torch=torch,
        outputs=val33_outputs,
        arrays=arrays,
        positions=val33,
        font_weights=arrays["font_supervision_weights"][val33],
        candidate_ids=candidate_ids,
        device=device,
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        checkpoint = staging / OUTPUT_CHECKPOINT
        save_file(best_state, str(checkpoint))
        quality_checks = dict(best_epoch["quality_checks"])
        manifest = base.seal_record(
            {
                "architecture": {
                    "attention_queries": args.attention_queries,
                    "base_adapter_frozen": True,
                    "dropout": args.dropout,
                    "hidden_dim": args.hidden_dim,
                    "input_mode": args.input_mode,
                    "maximum_candidate_residual": args.maximum_candidate_residual,
                    "maximum_family_residual": args.maximum_family_residual,
                    "rank": args.rank,
                    "token_input_shape": [VIEW_COUNT, PATCH_COUNT, RAW_DIM if args.input_mode == "trainable_raw" else args.rank],
                    "token_text_font_name_gemma_inputs": False,
                },
                "best_epoch": best_epoch,
                "boundaries": {
                    "optimizer_authorities": ["human", "visual"],
                    "optimizer_row_count": len(train_positions),
                    "pseudo_rows_used_for_gradient": 0,
                    "train_split_only": True,
                    "val33_used_for_checkpoint_selection": False,
                    "val33_used_for_gradient": False,
                    "validation_visual_rows": 1047,
                    "validation_work_disjoint": True,
                },
                "candidate_ids": list(candidate_ids),
                "candidate_weighting": dict(candidate_weight_report),
                "configuration": {
                    "batch_size": args.batch_size,
                    "candidate_distribution_slack": args.candidate_distribution_slack,
                    "candidate_distribution_temperature": args.candidate_distribution_temperature,
                    "candidate_distribution_weight": args.candidate_distribution_weight,
                    "epochs": args.epochs,
                    "evaluation_interval": args.evaluation_interval,
                    "family_weight": args.family_weight,
                    "gradient_clip": args.gradient_clip,
                    "learning_rate": args.learning_rate,
                    "residual_l2_weight": args.residual_l2_weight,
                    "seed": args.seed,
                    "weight_decay": args.weight_decay,
                },
                "dataset": {
                    "file": str(dataset_path),
                    "sha256": base.sha256_file(dataset_path),
                },
                "files": {
                    OUTPUT_CHECKPOINT: {
                        "byte_size": checkpoint.stat().st_size,
                        "sha256": base.sha256_file(checkpoint),
                    }
                },
                "history": history,
                "input_cache": dict(cache_binding or {}),
                "quality_gate": {
                    "checks": quality_checks,
                    "passed": all(quality_checks.values()),
                    "routing_authority": "predicted_pixel_family_with_single_day_eligibility",
                },
                "record_type": "manga_font_student_v82_token_attention_adapter",
                "schema_version": OUTPUT_SCHEMA,
                "sources": {
                    "base_adapter_checkpoint_sha256": base.sha256_file(
                        args.base_adapter_dir.expanduser().resolve() / base.CHECKPOINT_FILE
                    ),
                    "base_adapter_manifest_sha256": base.sha256_file(
                        args.base_adapter_dir.expanduser().resolve() / base.MANIFEST_FILE
                    ),
                    "hidden_manifest_sha256": base.sha256_file(cache_root / hidden.MANIFEST),
                },
                "training_seconds": time.perf_counter() - started,
                "val33_diagnostic_after_selection": val33_metrics,
            }
        )
        (staging / OUTPUT_MANIFEST).write_bytes(base.json_bytes(manifest, pretty=True))
        marker = base.seal_record(
            {
                "artifacts": {
                    OUTPUT_CHECKPOINT: base.sha256_file(checkpoint),
                    OUTPUT_MANIFEST: base.sha256_file(staging / OUTPUT_MANIFEST),
                },
                "owner": OUTPUT_OWNER,
                "safe_replace": True,
                "schema_version": OUTPUT_SCHEMA,
            }
        )
        (staging / OUTPUT_MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging)
        _publish_directory(staging, output)
        published = True
        return validate_output(output)
    finally:
        if sketch is not None:
            mapped = getattr(sketch, "_mmap", None)
            if mapped is not None:
                mapped.close()
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or set(path.name for path in root.iterdir()) != OUTPUT_FILES:
        raise TokenAttentionAdapterError("v8.2 output inventory drifted")
    marker = _read_json(root / OUTPUT_MARKER, "v8.2 marker")
    manifest = _read_json(root / OUTPUT_MANIFEST, "v8.2 manifest")
    _validate_sealed_record(marker, "v8.2 marker")
    _validate_sealed_record(manifest, "v8.2 manifest")
    if (
        marker.get("owner") != OUTPUT_OWNER
        or marker.get("schema_version") != OUTPUT_SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != OUTPUT_SCHEMA
    ):
        raise TokenAttentionAdapterError("v8.2 metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v8.2 artifacts")
    for name in (OUTPUT_CHECKPOINT, OUTPUT_MANIFEST):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise TokenAttentionAdapterError(f"v8.2 hash drifted: {name}")
    boundaries = _mapping(manifest.get("boundaries"), "v8.2 boundaries")
    if (
        boundaries.get("optimizer_authorities") != ["human", "visual"]
        or int(boundaries.get("optimizer_row_count", 0)) != 2117
        or boundaries.get("pseudo_rows_used_for_gradient") != 0
        or boundaries.get("train_split_only") is not True
        or boundaries.get("val33_used_for_gradient") is not False
        or boundaries.get("val33_used_for_checkpoint_selection") is not False
        or boundaries.get("validation_work_disjoint") is not True
    ):
        raise TokenAttentionAdapterError("v8.2 optimizer/validation boundary drifted")
    quality = _mapping(manifest.get("quality_gate"), "v8.2 quality gate")
    checks = _mapping(quality.get("checks"), "v8.2 quality checks")
    if quality.get("passed") != all(bool(value) for value in checks.values()):
        raise TokenAttentionAdapterError("v8.2 quality gate seal drifted")
    return {
        "checkpoint_sha256": base.sha256_file(root / OUTPUT_CHECKPOINT),
        "input_mode": _mapping(manifest.get("architecture"), "architecture").get("input_mode"),
        "output_dir": str(root),
        "quality_gate_passed": quality.get("passed"),
        "status": "validated_v82_token_attention_adapter",
        "training_seconds": manifest.get("training_seconds"),
        "val33_preferred_at1": _mapping(
            manifest.get("val33_diagnostic_after_selection"), "val33 diagnostic"
        ).get("preferred_at1"),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    cache = commands.add_parser("build-cache")
    cache.add_argument("--dataset-npz", type=Path, required=True)
    cache.add_argument("--hidden-cache-dir", type=Path, required=True)
    cache.add_argument("--r5-output-dir", type=Path, required=True)
    cache.add_argument("--output-dir", type=Path, required=True)
    cache.add_argument("--rank", type=int, default=DEFAULT_RANK)
    cache.add_argument("--projection-seed", type=int, default=20260823)
    cache.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    cache.add_argument("--batch-size", type=int, default=128)
    validate_cache = commands.add_parser("validate-cache")
    validate_cache.add_argument("--dataset-npz", type=Path, required=True)
    validate_cache.add_argument("--output-dir", type=Path, required=True)
    validate_cache.add_argument("--verify-payload", action="store_true")

    train_parser = commands.add_parser("train")
    train_parser.add_argument("--dataset-npz", type=Path, required=True)
    train_parser.add_argument("--hidden-cache-dir", type=Path, required=True)
    train_parser.add_argument("--base-adapter-dir", type=Path, required=True)
    train_parser.add_argument("--fixed-sketch-cache", type=Path)
    train_parser.add_argument("--val33-finals", type=Path, required=True)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    train_parser.add_argument("--input-mode", choices=INPUT_MODES, required=True)
    train_parser.add_argument("--rank", type=int, default=DEFAULT_RANK)
    train_parser.add_argument("--attention-queries", type=int, default=4)
    train_parser.add_argument("--hidden-dim", type=int, default=64)
    train_parser.add_argument("--dropout", type=float, default=0.10)
    train_parser.add_argument("--maximum-candidate-residual", type=float, default=0.50)
    train_parser.add_argument("--maximum-family-residual", type=float, default=0.50)
    train_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    train_parser.add_argument("--raw-preload-device", choices=("cpu", "cuda"), default="cuda")
    train_parser.add_argument("--epochs", type=int, default=30)
    train_parser.add_argument("--evaluation-interval", type=int, default=5)
    train_parser.add_argument("--batch-size", type=int, default=64)
    train_parser.add_argument("--base-batch-size", type=int, default=512)
    train_parser.add_argument("--hidden-batch-size", type=int, default=64)
    train_parser.add_argument("--validation-batch-size", type=int, default=512)
    train_parser.add_argument("--learning-rate", type=float, default=3e-4)
    train_parser.add_argument("--weight-decay", type=float, default=1e-3)
    train_parser.add_argument("--gradient-clip", type=float, default=1.0)
    train_parser.add_argument("--family-weight", type=float, default=0.35)
    train_parser.add_argument("--single-day-hard-negative-weight", type=float, default=5.0)
    train_parser.add_argument("--single-day-hard-negative-margin", type=float, default=0.5)
    train_parser.add_argument("--supervised-single-day-hard-negative-weight", type=float, default=10.0)
    train_parser.add_argument("--candidate-distribution-weight", type=float, default=1.0)
    train_parser.add_argument("--candidate-distribution-slack", type=float, default=0.0)
    train_parser.add_argument("--candidate-distribution-temperature", type=float, default=0.12)
    train_parser.add_argument("--residual-l2-weight", type=float, default=0.02)
    train_parser.add_argument("--rare-class-weight-cap", type=float, default=3.0)
    train_parser.add_argument("--human-candidate-weight-multiplier", type=float, default=1.0)
    train_parser.add_argument("--seed", type=int, default=20260823)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def _validate_train_args(args: argparse.Namespace) -> None:
    positive_ints = (
        "epochs",
        "evaluation_interval",
        "batch_size",
        "base_batch_size",
        "hidden_batch_size",
        "validation_batch_size",
        "rank",
        "attention_queries",
        "hidden_dim",
    )
    if any(int(getattr(args, name)) < 1 for name in positive_ints):
        raise TokenAttentionAdapterError("v8.2 integer training option must be positive")
    finite_positive = (
        "learning_rate",
        "gradient_clip",
        "maximum_candidate_residual",
        "maximum_family_residual",
        "candidate_distribution_temperature",
    )
    if any(
        not math.isfinite(float(getattr(args, name))) or float(getattr(args, name)) <= 0
        for name in finite_positive
    ):
        raise TokenAttentionAdapterError("v8.2 positive option is invalid")
    finite_nonnegative = (
        "weight_decay",
        "family_weight",
        "single_day_hard_negative_weight",
        "single_day_hard_negative_margin",
        "supervised_single_day_hard_negative_weight",
        "candidate_distribution_weight",
        "candidate_distribution_slack",
        "residual_l2_weight",
    )
    if any(
        not math.isfinite(float(getattr(args, name))) or float(getattr(args, name)) < 0
        for name in finite_nonnegative
    ):
        raise TokenAttentionAdapterError("v8.2 nonnegative option is invalid")
    if not 0 <= args.dropout < 0.5 or args.rare_class_weight_cap < 1 or args.human_candidate_weight_multiplier < 1:
        raise TokenAttentionAdapterError("v8.2 dropout/weight cap is invalid")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build-cache":
            result = build_fixed_sketch_cache(args)
        elif args.command == "validate-cache":
            result = validate_fixed_sketch_cache(
                output_dir=args.output_dir,
                dataset_npz=args.dataset_npz,
                verify_payload=args.verify_payload,
            )
        elif args.command == "train":
            _validate_train_args(args)
            result = train(args)
        else:
            result = validate_output(args.output_dir)
    except (OSError, RuntimeError, TokenAttentionAdapterError, base.MangaFontV8RoleFamilyError) as error:
        print(json.dumps({"error": str(error), "status": "blocked"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
