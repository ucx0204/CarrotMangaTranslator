#!/usr/bin/env python3
"""Bounded SigLIP2 patch-token font-query research for MangaFont v6.

This trainer deliberately does *not* reuse the pooled v1-v5 embedding cache.
It caches the pinned SigLIP2 ``last_hidden_state`` patch grid for a balanced
synthetic-train subset, the 109 complete-full22 real train rows, and the
adjudicated val33 rows.  Hidden test rows, fresh64, and library QA cohorts are
never deserialized or opened.

The small trainable head uses two to four learned queries to attentively pool
stroke/style patches.  Candidate logits are cosine similarities against a
disjoint synthetic reference bank, so there is no candidate-frequency bias.
The frozen-encoder experiment is intentionally bounded; encoder fine-tuning is
left conditional on this representation first showing useful val33 evidence.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
import shutil
import tempfile
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import sweep_manga_font_student_v3_heads as v3_sweep
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v2 as v2
    from scripts import train_manga_font_student_v3 as v3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import sweep_manga_font_student_v3_heads as v3_sweep
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v2 as v2
    import train_manga_font_student_v3 as v3


CACHE_SCHEMA = "manga-font-student-v6-patch-cache-v1"
CACHE_OWNER = "carrot-manga-translator/manga-font-student-v6-patch-cache-v1"
CACHE_MARKER = ".manga-font-student-v6-patch-cache-v1-owned.json"
CACHE_CONTRACT = "cache-contract.json"
CACHE_ARRAYS = "patch-tokens-and-targets.npz"
CACHE_FILES = frozenset({CACHE_MARKER, CACHE_CONTRACT, CACHE_ARRAYS})

OUTPUT_SCHEMA = "manga-font-student-v6-fontquery-research-v1"
OUTPUT_OWNER = "carrot-manga-translator/manga-font-student-v6-fontquery-research-v1"
OUTPUT_MARKER = ".manga-font-student-v6-fontquery-research-v1-owned.json"
OUTPUT_REPORT = "report.json"
OUTPUT_CHECKPOINT = "best-fontquery-head.safetensors"
OUTPUT_PROTOTYPES = "candidate-query-prototypes.f32"
OUTPUT_PREDICTIONS = "predictions-val.jsonl"
OUTPUT_FILES = frozenset(
    {
        OUTPUT_MARKER,
        OUTPUT_REPORT,
        OUTPUT_CHECKPOINT,
        OUTPUT_PROTOTYPES,
        OUTPUT_PREDICTIONS,
    }
)

PATCH_SIZE = 16
IMAGE_SIZE = 224
PATCH_COUNT = (IMAGE_SIZE // PATCH_SIZE) ** 2
HIDDEN_SIZE = 768
MIN_QUERY_COUNT = 2
MAX_QUERY_COUNT = 4


class MangaFontV6FontQueryError(v3.MangaFontStudentV3Error):
    """Raised when the v6 research or its sealed boundary is invalid."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV6FontQueryError(f"{location}: expected object")
    return value


def _safe_output(path: Path) -> Path:
    return base._safe_output_path(path)  # noqa: SLF001


def _descriptor(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise MangaFontV6FontQueryError(f"missing owned file: {path.name}")
    return {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": base.sha256_file(path),
    }


def _assert_inventory(root: Path, expected: frozenset[str], location: str) -> None:
    if root.is_symlink() or not root.is_dir():
        raise MangaFontV6FontQueryError(f"{location}: missing regular directory")
    children = tuple(root.iterdir())
    if {path.name for path in children} != expected or any(
        path.is_symlink() for path in children
    ):
        raise MangaFontV6FontQueryError(f"{location}: exact inventory drifted")


def _array_contract(arrays: Mapping[str, np.ndarray]) -> dict[str, Any]:
    return {
        name: {"dtype": str(value.dtype), "shape": list(value.shape)}
        for name, value in sorted(arrays.items())
    }


def select_disjoint_synthetic_train(
    examples: Sequence[base.SyntheticExample],
    *,
    candidate_ids: tuple[str, ...],
    metadata: Mapping[str, Mapping[str, Any]],
    reference_examples: Sequence[base.SyntheticExample],
    per_font: int,
) -> tuple[base.SyntheticExample, ...]:
    """Choose balanced synthetic train rows disjoint from reference identities."""

    if not 16 <= per_font <= 96:
        raise MangaFontV6FontQueryError("synthetic-per-font must be 16..96")
    reference_ids = {row.sample_id for row in reference_examples}
    pool = v3_sweep.select_balanced_synthetic_subset(
        examples,
        candidate_ids=candidate_ids,
        metadata=metadata,
        per_font=min(128, per_font + 16),
    )
    grouped: dict[str, list[base.SyntheticExample]] = {
        candidate_id: [] for candidate_id in candidate_ids
    }
    for example in pool:
        if example.sample_id not in reference_ids:
            grouped[example.font_id].append(example)
    selected: list[base.SyntheticExample] = []
    for candidate_id in candidate_ids:
        rows = grouped[candidate_id]
        if len(rows) < per_font:
            raise MangaFontV6FontQueryError(
                f"{candidate_id}: insufficient reference-disjoint synthetic rows"
            )
        selected.extend(rows[:per_font])
    if {row.sample_id for row in selected} & reference_ids:
        raise MangaFontV6FontQueryError("synthetic train/reference identity overlap")
    return tuple(selected)


def complete_full22_train_rows(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> tuple[base.HumanExample, ...]:
    result = tuple(
        example
        for example in examples
        if not v3.candidate_supervision_scope(example, candidate_ids)[
            "partial_candidate_supervision"
        ]
    )
    if len(result) != 109:
        raise MangaFontV6FontQueryError(
            f"expected exactly 109 complete-full22 train rows, found {len(result)}"
        )
    return result


def _encode_image_groups(
    *,
    torch: Any,
    encoder: Any,
    processor: Any,
    examples: Sequence[Any],
    opener: Any,
    view_count: int,
    batch_size: int,
) -> np.ndarray:
    chunks: list[np.ndarray] = []
    encoder.eval()
    with torch.inference_mode():
        for offset in range(0, len(examples), batch_size):
            rows = examples[offset : offset + batch_size]
            groups = [opener(row) for row in rows]
            images = [image for group in groups for image in group]
            try:
                processed = processor(
                    images=images,
                    return_tensors="pt",
                    do_resize=False,
                    do_convert_rgb=True,
                )
            finally:
                for image in images:
                    image.close()
            pixels = processed["pixel_values"].to("cuda", non_blocking=False)
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                output = encoder(pixel_values=pixels)
                tokens = output.last_hidden_state
            expected = (len(rows) * view_count, PATCH_COUNT, HIDDEN_SIZE)
            if tuple(tokens.shape) != expected:
                raise MangaFontV6FontQueryError(
                    f"SigLIP2 patch-token shape drifted: {tuple(tokens.shape)}"
                )
            shaped = tokens.reshape(len(rows), view_count, PATCH_COUNT, HIDDEN_SIZE)
            chunks.append(shaped.float().cpu().numpy().astype("<f2"))
    result = np.ascontiguousarray(np.concatenate(chunks, axis=0), dtype="<f2")
    expected_shape = (len(examples), view_count, PATCH_COUNT, HIDDEN_SIZE)
    if result.shape != expected_shape or not np.isfinite(result).all():
        raise MangaFontV6FontQueryError("cached patch-token array is invalid")
    return result


def _open_reference(example: base.SyntheticExample) -> list[Any]:
    return [base._open_synthetic_view(example, "glyph_224")]  # noqa: SLF001


def _human_arrays(
    examples: Sequence[base.HumanExample], candidate_ids: tuple[str, ...]
) -> dict[str, np.ndarray]:
    targets = np.asarray(
        [v2.tier_code_target(example, candidate_ids) for example in examples],
        dtype="<f4",
    )
    masks = np.zeros((len(examples), len(candidate_ids)), dtype=np.bool_)
    for row, example in enumerate(examples):
        masks[row, list(example.eligible_indices)] = True
    return {
        "masks": masks,
        "roles": np.asarray([example.role_index for example in examples], dtype="<i8"),
        "targets": targets,
    }


def build_patch_cache(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise MangaFontV6FontQueryError("patch-cache output already exists")
    _registry, synthetic, human, bindings = v3._load_inputs(args)  # noqa: SLF001
    metadata = v2.load_synthetic_train_metadata(synthetic)
    references, reference_bags = v2.select_stratified_prototypes(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        per_font=args.references_per_font,
        metadata=metadata,
    )
    selected = select_disjoint_synthetic_train(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        metadata=metadata,
        reference_examples=references,
        per_font=args.synthetic_per_font,
    )
    human_train = complete_full22_train_rows(
        human.train_examples, synthetic.candidate_ids
    )
    if len(human.val_examples) != 33:
        raise MangaFontV6FontQueryError("adjudicated validation must contain val33")
    if {row.sample_id for row in human_train} & {
        row.sample_id for row in human.val_examples
    }:
        raise MangaFontV6FontQueryError("human train/val overlap")

    torch, processor_class, vision_class, _save_file = (
        base._load_training_dependencies()
    )  # noqa: SLF001
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise MangaFontV6FontQueryError("patch cache requires CUDA bf16")
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
        .to("cuda")
    )
    if (
        int(getattr(encoder.config, "hidden_size", 0)) != HIDDEN_SIZE
        or int(getattr(encoder.config, "patch_size", 0)) != PATCH_SIZE
        or int(getattr(encoder.config, "image_size", 0)) != IMAGE_SIZE
    ):
        raise MangaFontV6FontQueryError("pinned SigLIP2 patch contract drifted")
    try:
        from font_matching_catalog_assets import CatalogAssetResolver
    except ImportError:  # pragma: no cover - repository-root import
        from scripts.font_matching_catalog_assets import CatalogAssetResolver
    resolver = CatalogAssetResolver(args.catalog_registry.expanduser().resolve())

    print(
        base.canonical_json(
            {
                "event": "v6_patch_cache_encoding_started",
                "human_train_full22": len(human_train),
                "human_val": len(human.val_examples),
                "references": len(references),
                "synthetic": len(selected),
            }
        ),
        flush=True,
    )
    started = time.monotonic()
    synthetic_tokens = _encode_image_groups(
        torch=torch,
        encoder=encoder,
        processor=processor,
        examples=selected,
        opener=base._open_synthetic_views,  # noqa: SLF001
        view_count=len(base.VIEW_NAMES),
        batch_size=args.encode_batch_size,
    )
    reference_tokens = _encode_image_groups(
        torch=torch,
        encoder=encoder,
        processor=processor,
        examples=references,
        opener=_open_reference,
        view_count=1,
        batch_size=args.encode_batch_size,
    )[:, 0]
    human_train_tokens = _encode_image_groups(
        torch=torch,
        encoder=encoder,
        processor=processor,
        examples=human_train,
        opener=lambda row: base._open_human_views(row, resolver),  # noqa: SLF001
        view_count=len(base.VIEW_NAMES),
        batch_size=args.encode_batch_size,
    )
    human_val_tokens = _encode_image_groups(
        torch=torch,
        encoder=encoder,
        processor=processor,
        examples=human.val_examples,
        opener=lambda row: base._open_human_views(row, resolver),  # noqa: SLF001
        view_count=len(base.VIEW_NAMES),
        batch_size=args.encode_batch_size,
    )
    train_arrays = _human_arrays(human_train, synthetic.candidate_ids)
    val_arrays = _human_arrays(human.val_examples, synthetic.candidate_ids)
    reference_labels = np.asarray([row.label_index for row in references], dtype="<i8")
    arrays = {
        "human_train_masks": train_arrays["masks"],
        "human_train_roles": train_arrays["roles"],
        "human_train_targets": train_arrays["targets"],
        "human_train_tokens": human_train_tokens,
        "human_val_masks": val_arrays["masks"],
        "human_val_roles": val_arrays["roles"],
        "human_val_targets": val_arrays["targets"],
        "human_val_tokens": human_val_tokens,
        "reference_labels": reference_labels,
        "reference_tokens": reference_tokens,
        "synthetic_labels": np.asarray(
            [row.label_index for row in selected], dtype="<i8"
        ),
        "synthetic_tokens": synthetic_tokens,
    }
    baseline = v3.constant_candidate_baseline(
        human.val_examples, synthetic.candidate_ids
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        np.savez(staging / CACHE_ARRAYS, **arrays)
        contract = base.seal_record(
            {
                "arrays": {
                    **_descriptor(staging / CACHE_ARRAYS),
                    "contract": _array_contract(arrays),
                },
                "boundaries": {
                    "fresh64_labels_deserialized": 0,
                    "fresh64_pixels_opened": 0,
                    "human_partial_train_rows_used": 0,
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "human_train_full22_count": len(human_train),
                    "human_val_count": len(human.val_examples),
                    "library_qa_labels_deserialized": 0,
                    "library_qa_pixels_opened": 0,
                    "synthetic_reference_count": len(references),
                    "synthetic_test_pixels_opened": 0,
                    "synthetic_train_count": len(selected),
                    "synthetic_train_reference_overlap": 0,
                    "train_val_identity_overlap": 0,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(synthetic.candidate_ids),
                "human_train": [
                    v3_sweep._human_metadata(row, synthetic.candidate_ids)  # noqa: SLF001
                    for row in human_train
                ],
                "human_val": [
                    v3_sweep._human_metadata(row, synthetic.candidate_ids)  # noqa: SLF001
                    for row in human.val_examples
                ],
                "model": {
                    "base_model_id": base.MODEL_ID,
                    "base_model_revision": base.MODEL_REVISION,
                    "cached_tensor": "last_hidden_state",
                    "hidden_size": HIDDEN_SIZE,
                    "image_size": IMAGE_SIZE,
                    "patch_count": PATCH_COUNT,
                    "patch_size": PATCH_SIZE,
                    "pooler_output_used": False,
                },
                "overlays": copy.deepcopy(bindings),
                "quality_gate_constant_baseline": baseline,
                "record_type": "manga_font_student_v6_patch_cache",
                "reference_bags": [dict(row) for row in reference_bags],
                "schema_version": CACHE_SCHEMA,
                "selection": {
                    "references_per_font": args.references_per_font,
                    "synthetic_per_font": args.synthetic_per_font,
                    "synthetic_reference_identity_disjoint": True,
                },
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "sources": {
                    "catalog_registry_sha256": base.sha256_file(
                        args.catalog_registry.expanduser().resolve()
                    ),
                    "human_export_manifest_sha256": human.manifest_sha256,
                    "synthetic_manifest_sha256": synthetic.manifest_sha256,
                },
                "timing_seconds": {"patch_encoding": time.monotonic() - started},
            }
        )
        (staging / CACHE_CONTRACT).write_bytes(base.json_bytes(contract, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (CACHE_ARRAYS, CACHE_CONTRACT)
            },
            "owner": CACHE_OWNER,
            "safe_replace": True,
            "schema_version": CACHE_SCHEMA,
        }
        (staging / CACHE_MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_patch_cache(staging)
        os.rename(staging, output)
        published = True
        return validate_patch_cache(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_patch_cache(cache_dir: Path) -> Mapping[str, Any]:
    root = cache_dir.expanduser().resolve()
    _assert_inventory(root, CACHE_FILES, "v6 patch cache")
    marker = base.read_json(root / CACHE_MARKER, location="v6 cache marker")
    contract = base.read_json(root / CACHE_CONTRACT, location="v6 cache contract")
    base.validate_record_seal(contract, location="v6 cache contract")
    if (
        marker.get("owner") != CACHE_OWNER
        or marker.get("schema_version") != CACHE_SCHEMA
        or marker.get("safe_replace") is not True
        or contract.get("schema_version") != CACHE_SCHEMA
        or contract.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV6FontQueryError("v6 cache metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v6 cache artifacts")
    for name in (CACHE_ARRAYS, CACHE_CONTRACT):
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV6FontQueryError(f"v6 cache hash drifted: {name}")
    descriptor = _mapping(contract.get("arrays"), "v6 cache arrays")
    if (
        descriptor.get("sha256") != base.sha256_file(root / CACHE_ARRAYS)
        or descriptor.get("byte_size") != (root / CACHE_ARRAYS).stat().st_size
    ):
        raise MangaFontV6FontQueryError("v6 cache array descriptor drifted")
    expected = _mapping(descriptor.get("contract"), "v6 cache array contract")
    with np.load(root / CACHE_ARRAYS, allow_pickle=False) as arrays:
        if set(arrays.files) != set(expected):
            raise MangaFontV6FontQueryError("v6 cache array inventory drifted")
        for name in arrays.files:
            value = arrays[name]
            item = _mapping(expected[name], f"v6 cache array {name}")
            if list(value.shape) != item.get("shape") or str(value.dtype) != item.get(
                "dtype"
            ):
                raise MangaFontV6FontQueryError(f"v6 cache array drifted: {name}")
            if value.dtype.kind == "f" and not np.isfinite(value).all():
                raise MangaFontV6FontQueryError(f"v6 cache nonfinite: {name}")
    boundaries = _mapping(contract.get("boundaries"), "v6 cache boundaries")
    required_zero = (
        "fresh64_labels_deserialized",
        "fresh64_pixels_opened",
        "human_partial_train_rows_used",
        "human_test_labels_deserialized",
        "human_test_pixels_opened",
        "library_qa_labels_deserialized",
        "library_qa_pixels_opened",
        "synthetic_test_pixels_opened",
        "synthetic_train_reference_overlap",
        "train_val_identity_overlap",
    )
    if (
        any(int(boundaries.get(name, -1)) != 0 for name in required_zero)
        or boundaries.get("val_used_for_optimizer") is not False
        or int(boundaries.get("human_train_full22_count", 0)) != 109
        or int(boundaries.get("human_val_count", 0)) != 33
    ):
        raise MangaFontV6FontQueryError("v6 cache leakage boundary drifted")
    model = _mapping(contract.get("model"), "v6 cache model")
    if (
        model.get("cached_tensor") != "last_hidden_state"
        or model.get("pooler_output_used") is not False
        or int(model.get("patch_count", 0)) != PATCH_COUNT
    ):
        raise MangaFontV6FontQueryError("v6 cache representation drifted")
    return {
        "cache_contract_sha256": base.sha256_file(root / CACHE_CONTRACT),
        "cache_dir": str(root),
        "candidate_count": len(contract.get("candidate_ids", ())),
        "human_train_full22_count": boundaries.get("human_train_full22_count"),
        "human_val_count": boundaries.get("human_val_count"),
        "status": "ready_for_bounded_v6_fontquery_training",
        "synthetic_train_count": boundaries.get("synthetic_train_count"),
    }


def _load_cache(
    cache_dir: Path,
) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    validate_patch_cache(cache_dir)
    root = cache_dir.expanduser().resolve()
    contract = dict(base.read_json(root / CACHE_CONTRACT, location="v6 cache"))
    with np.load(root / CACHE_ARRAYS, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    return contract, arrays


def build_font_query_head(
    torch: Any,
    *,
    query_count: int,
    query_dim: int,
    hidden_size: int = HIDDEN_SIZE,
) -> Any:
    """Build attentive style queries over patch tokens (never pooled output)."""

    if not MIN_QUERY_COUNT <= query_count <= MAX_QUERY_COUNT:
        raise MangaFontV6FontQueryError("font query count must be 2..4")
    if query_dim not in {128, 192, 256}:
        raise MangaFontV6FontQueryError("font query dim must be 128, 192, or 256")

    class FontQueryHead(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.token_norm = torch.nn.LayerNorm(hidden_size)
            self.token_projection = torch.nn.Linear(hidden_size, query_dim, bias=False)
            self.queries = torch.nn.Parameter(torch.empty(query_count, query_dim))
            self.output_projection = torch.nn.Sequential(
                torch.nn.Linear(query_dim, query_dim, bias=False),
                torch.nn.GELU(),
                torch.nn.LayerNorm(query_dim),
            )
            self.query_weight_logits = torch.nn.Parameter(torch.zeros(query_count))
            self.logit_scale = torch.nn.Parameter(torch.tensor(math.log(10.0)))
            torch.nn.init.normal_(self.queries, std=0.02)

        def encode(self, patch_tokens: Any) -> tuple[Any, Any]:
            if patch_tokens.ndim != 3 or patch_tokens.shape[-1] != hidden_size:
                raise MangaFontV6FontQueryError("font-query patch shape drifted")
            projected = self.token_projection(self.token_norm(patch_tokens.float()))
            normalized_queries = torch.nn.functional.normalize(
                self.queries.float(), p=2, dim=-1
            )
            attention_logits = torch.einsum(
                "qd,bpd->bqp", normalized_queries, projected
            ) / math.sqrt(query_dim)
            attention = torch.softmax(attention_logits, dim=-1)
            pooled = torch.einsum("bqp,bpd->bqd", attention, projected)
            embedded = self.output_projection(pooled)
            return (
                torch.nn.functional.normalize(embedded.float(), p=2, dim=-1),
                attention,
            )

        def candidate_prototypes(
            self, reference_tokens: Any, reference_labels: Any, candidate_count: int
        ) -> Any:
            reference_embeddings, _ = self.encode(reference_tokens)
            values = []
            for candidate_index in range(candidate_count):
                selected = reference_embeddings[reference_labels == candidate_index]
                if selected.shape[0] < 1:
                    raise MangaFontV6FontQueryError("candidate reference bag is empty")
                values.append(
                    torch.nn.functional.normalize(selected.mean(dim=0), p=2, dim=-1)
                )
            return torch.stack(values, dim=0)

        def forward(
            self,
            view_tokens: Any,
            reference_tokens: Any,
            reference_labels: Any,
            candidate_count: int,
        ) -> Mapping[str, Any]:
            if view_tokens.ndim != 4:
                raise MangaFontV6FontQueryError("font-query view tensor drifted")
            batch, views, patches, hidden = view_tokens.shape
            encoded, attention = self.encode(
                view_tokens.reshape(batch * views, patches, hidden)
            )
            view_embeddings = encoded.reshape(batch, views, query_count, query_dim)
            sample_embeddings = torch.nn.functional.normalize(
                view_embeddings.mean(dim=1), p=2, dim=-1
            )
            prototypes = self.candidate_prototypes(
                reference_tokens, reference_labels, candidate_count
            )
            per_query = torch.einsum("bqd,cqd->bcq", sample_embeddings, prototypes)
            query_weights = torch.softmax(self.query_weight_logits.float(), dim=0)
            scale = self.logit_scale.float().exp().clamp(max=100.0)
            scores = scale * torch.einsum("bcq,q->bc", per_query, query_weights)
            return {
                "attention": attention.reshape(batch, views, query_count, patches),
                "candidate_prototypes": prototypes,
                "candidate_scores": scores,
                "per_query_scores": per_query,
                "query_weights": query_weights,
                "view_embeddings": view_embeddings,
            }

    return FontQueryHead()


def view_invariance_loss(torch: Any, view_embeddings: Any) -> Any:
    if view_embeddings.ndim != 4 or view_embeddings.shape[1] != len(base.VIEW_NAMES):
        raise MangaFontV6FontQueryError("view-invariance tensor drifted")
    center = torch.nn.functional.normalize(view_embeddings.mean(dim=1), p=2, dim=-1)
    similarity = (view_embeddings * center[:, None]).sum(dim=-1)
    return (1.0 - similarity).mean()


def attention_diversity_loss(torch: Any, attention: Any) -> Any:
    if attention.ndim != 4:
        raise MangaFontV6FontQueryError("attention diversity tensor drifted")
    normalized = torch.nn.functional.normalize(attention.float(), p=2, dim=-1)
    gram = torch.einsum("bvqp,bvkp->bvqk", normalized, normalized)
    query_count = attention.shape[2]
    identity = torch.eye(query_count, device=attention.device)[None, None]
    return ((gram - identity) ** 2).mean()


def compute_val_metrics(
    *,
    torch: Any,
    logits: Any,
    targets: Any,
    masks: Any,
    roles: Any,
    candidate_ids: tuple[str, ...],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    masked = logits.float().masked_fill(~masks, -torch.inf)
    probabilities = torch.softmax(masked, dim=-1)
    order = torch.argsort(masked, dim=-1, descending=True)
    loss = v3.tiered_deployment_loss(
        torch,
        logits,
        targets,
        masks,
        preferred_weight=1.0,
        acceptable_weight=0.20,
    )
    total = 0
    counters: Counter[str] = Counter()
    variant: Counter[str] = Counter()
    distribution: Counter[str] = Counter()
    predictions: list[dict[str, Any]] = []
    for row in range(targets.shape[0]):
        preferred = set(torch.where(targets[row] == v3.PREFERRED_CODE)[0].tolist())
        acceptable = set(torch.where(targets[row] >= v3.ACCEPTABLE_CODE)[0].tolist())
        if not acceptable:
            continue
        total += 1
        top1 = int(order[row, 0].item())
        top3 = set(order[row, :3].tolist())
        role = base.ROLE_VALUES[int(roles[row].item())]
        distribution[candidate_ids[top1]] += 1
        counters["preferred_at1"] += int(top1 in preferred)
        counters["acceptable_at1"] += int(top1 in acceptable)
        counters["preferred_hit_at3"] += int(bool(preferred & top3))
        counters["acceptable_hit_at3"] += int(bool(acceptable & top3))
        if role not in v2.ORDINARY_ROLES:
            variant["rows"] += 1
            variant["preferred_at1"] += int(top1 in preferred)
            variant["acceptable_at1"] += int(top1 in acceptable)
            variant["preferred_hit_at3"] += int(bool(preferred & top3))
            variant["acceptable_hit_at3"] += int(bool(acceptable & top3))
        ranked = [int(value) for value in order[row].tolist()]
        predictions.append(
            base.seal_record(
                {
                    "acceptable_at1": top1 in acceptable,
                    "acceptable_candidate_ids": [
                        candidate_ids[value] for value in sorted(acceptable)
                    ],
                    "preferred_at1": top1 in preferred,
                    "preferred_candidate_ids": [
                        candidate_ids[value] for value in sorted(preferred)
                    ],
                    "ranked_candidates": [
                        {
                            "candidate_id": candidate_ids[value],
                            "probability": float(probabilities[row, value].item()),
                        }
                        for value in ranked
                    ],
                    "role": role,
                    "row_index": row,
                    "schema_version": OUTPUT_SCHEMA,
                    "split": "val",
                }
            )
        )
    if total != 33 or variant["rows"] != 28:
        raise MangaFontV6FontQueryError("val33 positive/variant boundary drifted")
    metrics = {
        "acceptable_at1": counters["acceptable_at1"] / total,
        "acceptable_hit_at3": counters["acceptable_hit_at3"] / total,
        "evaluated_positive_rows": total,
        "preferred_at1": counters["preferred_at1"] / total,
        "preferred_hit_at3": counters["preferred_hit_at3"] / total,
        "tiered_gold_loss": float(loss.item()),
        "top1_candidate_distribution": dict(sorted(distribution.items())),
        "top1_max_candidate_share": max(distribution.values()) / total,
        "top1_unique_candidate_count": len(distribution),
        "variant_acceptable_at1": variant["acceptable_at1"] / variant["rows"],
        "variant_acceptable_hit_at3": variant["acceptable_hit_at3"] / variant["rows"],
        "variant_preferred_at1": variant["preferred_at1"] / variant["rows"],
        "variant_preferred_hit_at3": variant["preferred_hit_at3"] / variant["rows"],
        "variant_val_rows": variant["rows"],
    }
    return metrics, predictions


def research_gate(metrics: Mapping[str, Any]) -> dict[str, Any]:
    checks = {
        "acceptable_at1_at_least_0_60": float(metrics["acceptable_at1"]) >= 0.60,
        "preferred_at1_at_least_0_45": float(metrics["preferred_at1"]) >= 0.45,
        "top1_distribution_not_collapsed": int(metrics["top1_unique_candidate_count"])
        >= 4
        and float(metrics["top1_max_candidate_share"]) <= 0.55,
        "variant_acceptable_at1_at_least_0_60": float(metrics["variant_acceptable_at1"])
        >= 0.60,
        "variant_preferred_at1_at_least_0_50": float(metrics["variant_preferred_at1"])
        >= 0.50,
    }
    return {
        "checks": checks,
        "passed": all(checks.values()),
        "policy": {
            "global_preferred_at1": 0.45,
            "global_acceptable_at1": 0.60,
            "variant_preferred_at1": 0.50,
            "variant_acceptable_at1": 0.60,
            "maximum_top1_share": 0.55,
            "minimum_unique_top1": 4,
        },
    }


def _metric_key(metrics: Mapping[str, Any]) -> tuple[float, ...]:
    gate = research_gate(metrics)
    return (
        float(gate["passed"]),
        float(metrics["variant_preferred_at1"]),
        float(metrics["preferred_at1"]),
        float(metrics["variant_acceptable_at1"]),
        float(metrics["acceptable_at1"]),
        float(metrics["acceptable_hit_at3"]),
        -float(metrics["tiered_gold_loss"]),
    )


def _trial_grid(max_trials: int) -> list[dict[str, Any]]:
    values = [
        {
            "attention_diversity_weight": 0.01,
            "consistency_weight": 0.05,
            "head_lr": 3e-4,
            "human_weight": 2.0,
            "query_count": 2,
            "query_dim": 192,
        },
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.08,
            "head_lr": 2e-4,
            "human_weight": 3.0,
            "query_count": 4,
            "query_dim": 192,
        },
        {
            "attention_diversity_weight": 0.02,
            "consistency_weight": 0.10,
            "head_lr": 1e-4,
            "human_weight": 4.0,
            "query_count": 4,
            "query_dim": 256,
        },
    ]
    if not 1 <= max_trials <= len(values):
        raise MangaFontV6FontQueryError("font-query trials must be 1..3")
    return values[:max_trials]


def _to_gpu(torch: Any, value: np.ndarray, *, dtype: Any | None = None) -> Any:
    tensor = torch.from_numpy(value)
    if dtype is not None:
        tensor = tensor.to(dtype=dtype)
    return tensor.to("cuda", non_blocking=False)


def _state_cpu(model: Any) -> dict[str, Any]:
    return {
        name: value.detach().float().cpu().clone()
        for name, value in model.state_dict().items()
    }


def train_font_queries(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise MangaFontV6FontQueryError("font-query output already exists")
    contract, arrays = _load_cache(args.cache_dir)
    candidate_ids = tuple(str(value) for value in contract.get("candidate_ids", ()))
    if len(candidate_ids) != 22:
        raise MangaFontV6FontQueryError("font-query candidate vocabulary drifted")
    torch, _processor, _vision, save_file = base._load_training_dependencies()  # noqa: SLF001
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise MangaFontV6FontQueryError("font-query training requires CUDA bf16")
    base._configure_reproducibility(torch, seed=args.seed)  # noqa: SLF001

    synthetic_tokens = torch.from_numpy(arrays["synthetic_tokens"])
    synthetic_labels = torch.from_numpy(arrays["synthetic_labels"]).long()
    human_tokens = torch.from_numpy(arrays["human_train_tokens"])
    human_targets = torch.from_numpy(arrays["human_train_targets"]).float()
    human_masks = torch.from_numpy(arrays["human_train_masks"]).bool()
    val_tokens = _to_gpu(torch, arrays["human_val_tokens"], dtype=torch.float16)
    val_targets = _to_gpu(torch, arrays["human_val_targets"], dtype=torch.float32)
    val_masks = _to_gpu(torch, arrays["human_val_masks"], dtype=torch.bool)
    val_roles = _to_gpu(torch, arrays["human_val_roles"], dtype=torch.long)
    reference_tokens = _to_gpu(torch, arrays["reference_tokens"], dtype=torch.float16)
    reference_labels = _to_gpu(torch, arrays["reference_labels"], dtype=torch.long)
    del arrays

    best_metrics: dict[str, Any] | None = None
    best_predictions: list[dict[str, Any]] | None = None
    best_state: dict[str, Any] | None = None
    best_prototypes: Any | None = None
    best_trial = 0
    best_epoch = 0
    trials: list[dict[str, Any]] = []
    started = time.monotonic()

    for trial_index, trial in enumerate(_trial_grid(args.max_trials), 1):
        base._configure_reproducibility(torch, seed=args.seed + trial_index)  # noqa: SLF001
        model = build_font_query_head(
            torch,
            query_count=int(trial["query_count"]),
            query_dim=int(trial["query_dim"]),
        ).to("cuda")
        optimizer = torch.optim.AdamW(
            model.parameters(),
            lr=float(trial["head_lr"]),
            weight_decay=args.weight_decay,
        )
        generator = torch.Generator(device="cpu").manual_seed(args.seed + trial_index)
        trial_history: list[dict[str, Any]] = []
        trial_best: dict[str, Any] | None = None
        stale = 0
        for epoch in range(1, args.epochs + 1):
            order = torch.randperm(len(synthetic_tokens), generator=generator)
            model.train(True)
            sums: Counter[str] = Counter()
            steps = 0
            for offset in range(0, len(order), args.synthetic_batch_size):
                synthetic_index = order[offset : offset + args.synthetic_batch_size]
                human_index = torch.randint(
                    0,
                    len(human_tokens),
                    (args.human_batch_size,),
                    generator=generator,
                )
                batch_tokens = torch.cat(
                    (synthetic_tokens[synthetic_index], human_tokens[human_index]),
                    dim=0,
                ).to("cuda", dtype=torch.float16, non_blocking=False)
                batch_size = len(synthetic_index)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    result = model(
                        batch_tokens,
                        reference_tokens,
                        reference_labels,
                        len(candidate_ids),
                    )
                    synthetic_loss = torch.nn.functional.cross_entropy(
                        result["candidate_scores"][:batch_size],
                        synthetic_labels[synthetic_index].to("cuda"),
                    )
                    selected_targets = human_targets[human_index].to("cuda")
                    selected_masks = human_masks[human_index].to("cuda")
                    human_loss = v3.tiered_deployment_loss(
                        torch,
                        result["candidate_scores"][batch_size:],
                        selected_targets,
                        selected_masks,
                        preferred_weight=1.0,
                        acceptable_weight=0.20,
                    )
                    consistency = view_invariance_loss(torch, result["view_embeddings"])
                    diversity = attention_diversity_loss(torch, result["attention"])
                    loss = (
                        synthetic_loss
                        + float(trial["human_weight"]) * human_loss
                        + float(trial["consistency_weight"]) * consistency
                        + float(trial["attention_diversity_weight"]) * diversity
                    )
                if not bool(torch.isfinite(loss)):
                    raise MangaFontV6FontQueryError("font-query loss became nonfinite")
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
                optimizer.step()
                sums["loss"] += float(loss.detach().item())
                sums["synthetic"] += float(synthetic_loss.detach().item())
                sums["human"] += float(human_loss.detach().item())
                sums["consistency"] += float(consistency.detach().item())
                sums["diversity"] += float(diversity.detach().item())
                steps += 1
            model.eval()
            with (
                torch.inference_mode(),
                torch.autocast(device_type="cuda", dtype=torch.bfloat16),
            ):
                val_result = model(
                    val_tokens,
                    reference_tokens,
                    reference_labels,
                    len(candidate_ids),
                )
            metrics, predictions = compute_val_metrics(
                torch=torch,
                logits=val_result["candidate_scores"],
                targets=val_targets,
                masks=val_masks,
                roles=val_roles,
                candidate_ids=candidate_ids,
            )
            record = {
                "epoch": epoch,
                "gate": research_gate(metrics),
                "train": {
                    key: sums[key] / steps
                    for key in (
                        "consistency",
                        "diversity",
                        "human",
                        "loss",
                        "synthetic",
                    )
                },
                "val": metrics,
            }
            trial_history.append(record)
            if trial_best is None or _metric_key(metrics) > _metric_key(trial_best):
                trial_best = copy.deepcopy(metrics)
                stale = 0
            else:
                stale += 1
            if best_metrics is None or _metric_key(metrics) > _metric_key(best_metrics):
                best_metrics = copy.deepcopy(metrics)
                best_predictions = copy.deepcopy(predictions)
                best_state = _state_cpu(model)
                best_prototypes = (
                    val_result["candidate_prototypes"].detach().float().cpu()
                )
                best_trial = trial_index
                best_epoch = epoch
            if stale >= args.patience:
                break
        if trial_best is None:
            raise MangaFontV6FontQueryError("font-query trial produced no epoch")
        trials.append(
            {
                "best_val": trial_best,
                "config": copy.deepcopy(trial),
                "history": trial_history,
                "trial": trial_index,
            }
        )
        del model, optimizer
        torch.cuda.empty_cache()

    if (
        best_metrics is None
        or best_predictions is None
        or best_state is None
        or best_prototypes is None
    ):
        raise MangaFontV6FontQueryError("font-query sweep has no best state")
    best_config = trials[best_trial - 1]["config"]
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        save_file(
            best_state,
            str(staging / OUTPUT_CHECKPOINT),
            metadata={
                "format": OUTPUT_SCHEMA,
                "kind": "frozen-siglip2-patch-query-head",
            },
        )
        prototype_array = np.ascontiguousarray(best_prototypes.numpy(), dtype="<f4")
        (staging / OUTPUT_PROTOTYPES).write_bytes(prototype_array.tobytes())
        with (staging / OUTPUT_PREDICTIONS).open("wb") as handle:
            for row in best_predictions:
                handle.write(base.json_bytes(row))
        gate = research_gate(best_metrics)
        report = base.seal_record(
            {
                "architecture": {
                    "candidate_bias": False,
                    "candidate_scoring": "query-wise-cosine-to-synthetic-reference-prototypes",
                    "content_view_invariance": "three-view-query-cosine",
                    "encoder": base.MODEL_ID,
                    "encoder_revision": base.MODEL_REVISION,
                    "encoder_trainable_blocks": 0,
                    "input_representation": "last_hidden_state_patch_tokens",
                    "pooler_output_used": False,
                    "query_count": best_config["query_count"],
                    "query_dim": best_config["query_dim"],
                },
                "best_epoch": best_epoch,
                "best_trial": best_trial,
                "best_val": best_metrics,
                "boundaries": {
                    "fresh64_labels_deserialized": 0,
                    "fresh64_pixels_opened": 0,
                    "human_partial_train_rows_used": 0,
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "human_train_full22_count": 109,
                    "human_val_count": 33,
                    "library_qa_labels_deserialized": 0,
                    "library_qa_pixels_opened": 0,
                    "synthetic_test_pixels_opened": 0,
                    "test30_used_for_selection": False,
                    "val_used_for_early_stop": True,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(candidate_ids),
                "checks": {
                    "cache_contract_validated": True,
                    "candidate_frequency_bias_absent": True,
                    "full_encoder_frozen": True,
                    "pooler_output_absent": True,
                    "reference_train_identity_disjoint": True,
                    "research_gate_passed": gate["passed"],
                },
                "deployment": {
                    "approved": False,
                    "encoder_finetune_attempted": False,
                    "encoder_finetune_reason": (
                        "head_only_gate_passed_promising_followup_allowed"
                        if gate["passed"]
                        else "head_only_gate_failed_no_encoder_finetune"
                    ),
                    "onnx_feasibility": "feasible_softmax_einsum_matmul_with_constant_candidate_prototypes",
                    "onnx_io_change_required": True,
                    "runtime_status": "research_only_never_staged",
                },
                "files": {
                    "checkpoint": _descriptor(staging / OUTPUT_CHECKPOINT),
                    "predictions": _descriptor(staging / OUTPUT_PREDICTIONS),
                    "prototypes": {
                        **_descriptor(staging / OUTPUT_PROTOTYPES),
                        "dtype": "float32",
                        "shape": list(prototype_array.shape),
                    },
                },
                "quality_gate": gate,
                "record_type": "manga_font_student_v6_fontquery_research",
                "schema_version": OUTPUT_SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
                "sources": {
                    "patch_cache_contract_sha256": base.sha256_file(
                        args.cache_dir.expanduser().resolve() / CACHE_CONTRACT
                    )
                },
                "timing_seconds": {"head_sweep": time.monotonic() - started},
                "trials": trials,
            }
        )
        (staging / OUTPUT_REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                name: base.sha256_file(staging / name)
                for name in (
                    OUTPUT_CHECKPOINT,
                    OUTPUT_PREDICTIONS,
                    OUTPUT_PROTOTYPES,
                    OUTPUT_REPORT,
                )
            },
            "owner": OUTPUT_OWNER,
            "safe_replace": True,
            "schema_version": OUTPUT_SCHEMA,
        }
        (staging / OUTPUT_MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging)
        os.rename(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    _assert_inventory(root, OUTPUT_FILES, "v6 font-query output")
    marker = base.read_json(root / OUTPUT_MARKER, location="v6 output marker")
    report = base.read_json(root / OUTPUT_REPORT, location="v6 output report")
    base.validate_record_seal(report, location="v6 output report")
    if (
        marker.get("owner") != OUTPUT_OWNER
        or marker.get("schema_version") != OUTPUT_SCHEMA
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != OUTPUT_SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV6FontQueryError("v6 output metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "v6 output artifacts")
    for name in OUTPUT_FILES - {OUTPUT_MARKER}:
        if artifacts.get(name) != base.sha256_file(root / name):
            raise MangaFontV6FontQueryError(f"v6 output hash drifted: {name}")
    boundaries = _mapping(report.get("boundaries"), "v6 output boundaries")
    required_zero = (
        "fresh64_labels_deserialized",
        "fresh64_pixels_opened",
        "human_partial_train_rows_used",
        "human_test_labels_deserialized",
        "human_test_pixels_opened",
        "library_qa_labels_deserialized",
        "library_qa_pixels_opened",
        "synthetic_test_pixels_opened",
    )
    if (
        any(int(boundaries.get(name, -1)) != 0 for name in required_zero)
        or boundaries.get("test30_used_for_selection") is not False
        or boundaries.get("val_used_for_optimizer") is not False
        or int(boundaries.get("human_train_full22_count", 0)) != 109
        or int(boundaries.get("human_val_count", 0)) != 33
    ):
        raise MangaFontV6FontQueryError("v6 output leakage boundary drifted")
    architecture = _mapping(report.get("architecture"), "v6 architecture")
    deployment = _mapping(report.get("deployment"), "v6 deployment")
    if (
        architecture.get("input_representation") != "last_hidden_state_patch_tokens"
        or architecture.get("pooler_output_used") is not False
        or architecture.get("candidate_bias") is not False
        or deployment.get("approved") is not False
        or deployment.get("runtime_status") != "research_only_never_staged"
    ):
        raise MangaFontV6FontQueryError("v6 research-only contract drifted")
    prediction_count = sum(
        bool(line.strip())
        for line in (root / OUTPUT_PREDICTIONS).read_text(encoding="utf-8").splitlines()
    )
    if prediction_count != 33:
        raise MangaFontV6FontQueryError("v6 prediction count drifted")
    metrics = _mapping(report.get("best_val"), "v6 best val")
    for name in (
        "acceptable_at1",
        "acceptable_hit_at3",
        "preferred_at1",
        "preferred_hit_at3",
        "variant_acceptable_at1",
        "variant_acceptable_hit_at3",
        "variant_preferred_at1",
        "variant_preferred_hit_at3",
    ):
        base.require_probability(metrics.get(name), f"v6 best val {name}")
    return {
        "acceptable_at1": metrics.get("acceptable_at1"),
        "acceptable_hit_at3": metrics.get("acceptable_hit_at3"),
        "output_dir": str(root),
        "preferred_at1": metrics.get("preferred_at1"),
        "quality_gate_passed": _mapping(
            report.get("quality_gate"), "v6 quality gate"
        ).get("passed"),
        "report_sha256": base.sha256_file(root / OUTPUT_REPORT),
        "status": "sealed_research_only",
        "variant_acceptable_at1": metrics.get("variant_acceptable_at1"),
        "variant_preferred_at1": metrics.get("variant_preferred_at1"),
    }


def _add_v3_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--synthetic-dir", type=Path, required=True)
    parser.add_argument("--human-export-dir", type=Path, required=True)
    parser.add_argument("--human-val-overlay-dir", type=Path, required=True)
    parser.add_argument("--human-val-finals-dir", type=Path, required=True)
    parser.add_argument("--human-train-overlay-dir", type=Path, required=True)
    parser.add_argument("--human-train-secondary-overlay-dir", type=Path, required=True)
    parser.add_argument("--human-train-secondary-corrections", type=Path, required=True)
    parser.add_argument("--human-train-legacy15-overlay-dir", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    # v3 input loader itself does not consume this, but its common namespace and
    # overlay validation expect the field to exist in some diagnostic paths.
    parser.add_argument("--warm-start-student-dir", type=Path, required=True)
    parser.add_argument("--head-sweep-dir", type=Path)
    parser.add_argument("--prototypes-per-font", type=int, default=16)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    cache = commands.add_parser("cache")
    _add_v3_inputs(cache)
    cache.add_argument("--output-dir", type=Path, required=True)
    cache.add_argument("--synthetic-per-font", type=int, default=48)
    cache.add_argument("--references-per-font", type=int, default=16)
    cache.add_argument("--encode-batch-size", type=int, default=24)
    train = commands.add_parser("train")
    train.add_argument("--cache-dir", type=Path, required=True)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--max-trials", type=int, default=3)
    train.add_argument("--epochs", type=int, default=14)
    train.add_argument("--patience", type=int, default=4)
    train.add_argument("--synthetic-batch-size", type=int, default=40)
    train.add_argument("--human-batch-size", type=int, default=16)
    train.add_argument("--weight-decay", type=float, default=0.01)
    train.add_argument("--gradient-clip", type=float, default=1.0)
    train.add_argument("--seed", type=int, default=20260803)
    validate_cache = commands.add_parser("validate-cache")
    validate_cache.add_argument("--cache-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "cache":
            result = build_patch_cache(args)
        elif args.command == "train":
            result = train_font_queries(args)
        elif args.command == "validate-cache":
            result = validate_patch_cache(args.cache_dir)
        else:
            result = validate_output(args.output_dir)
    except (base.MangaFontStudentError, OSError) as error:
        raise SystemExit(f"manga-font-student-v6-fontquery error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
