#!/usr/bin/env python3
"""Run a teacher-preserving MangaFont mass21 continuation.

This runner is intentionally separate from the immutable v7/r2 experiments.
Every master-v3 train crop is still consumed exactly once per epoch, but weak
pseudo labels may only perturb a frozen v6-r3 active21 teacher by a small,
confidence-gated residual.  Frozen-teacher KL, frozen query-prototype
distillation, and three-view consistency therefore make every real crop useful
without treating automatically generated labels as gold.

With ``--master-hidden-cache-dir``, train-crop patch tokens are read from the
fully sealed master cache while val/test cache rows remain inaccessible to the
optimizer.  The 675 human rows and 1,008 synthetic rows are uniformly interleaved exactly
once per epoch.  In particular, legacy15 partial labels are no longer cycled
three times and allowed to dominate the active21 head.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
import random
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

import numpy as np

try:
    from scripts import build_manga_font_master_v3_siglip2_hidden_cache as hidden_cache
    from scripts import train_manga_font_student_v7_mass21 as v7
    from scripts import train_manga_font_student_v7_mass21_r2 as r2
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_master_v3_siglip2_hidden_cache as hidden_cache
    import train_manga_font_student_v7_mass21 as v7
    import train_manga_font_student_v7_mass21_r2 as r2


SCHEMA = "manga-font-student-v7-mass21-r3-teacher-stable-v1"
OWNER = "carrot-manga-translator/manga-font-student-v7-mass21-r3-teacher-stable-v1"
MARKER = ".manga-font-student-v7-mass21-r3-teacher-stable-v1-owned.json"
RUN_STATE_SCHEMA = "manga-font-student-v7-mass21-r3-teacher-stable-run-state-v1"
RUN_STATE_MARKER = ".manga-font-student-v7-mass21-r3-teacher-stable-run-state-owned.json"
RUN_STATE_CHECKPOINT_A = "checkpoint-a.pt"
RUN_STATE_CHECKPOINT_B = "checkpoint-b.pt"
RUN_STATE_MARKER_A = "checkpoint-a.json"
RUN_STATE_MARKER_B = "checkpoint-b.json"
MIN_PSEUDO_ROWS = 18_000
TEACHER_MODE = "frozen_v6_r3_active21_logits"
PROTOTYPE_MODE = "frozen_v6_r3_active21_query_prototypes"
PSEUDO_MODE = "confidence_gated_teacher_residual"
SOURCE_SCHEDULE_MODE = "uniform_sparse_exactly_once_per_epoch"
LIVE_REAL_VISUAL_MODE = "live_pinned_siglip2_three_view_patch_tokens"
CACHED_REAL_VISUAL_MODE = "sealed_master_v3_siglip2_patch_tokens_train_only"

OUTPUT_FILES = frozenset(
    {
        MARKER,
        v7.MANIFEST,
        v7.HISTORY,
        v7.BEST_HEAD,
        v7.PROTOTYPES,
        v7.PREDICTIONS,
        v7.LATEST_CHECKPOINT,
    }
)
RUN_STATE_FILES = frozenset(
    {
        RUN_STATE_CHECKPOINT_A,
        RUN_STATE_CHECKPOINT_B,
        RUN_STATE_MARKER_A,
        RUN_STATE_MARKER_B,
    }
)


class MangaFontV7Mass21R3Error(r2.MangaFontV7Mass21R2Error):
    """Raised when the stable continuation crosses a safety boundary."""


@dataclass(frozen=True)
class StableLossWeights:
    synthetic: float
    full_human: float
    partial_human: float
    real_consistency: float
    domain_moment: float
    pseudo: float
    attention_diversity: float
    teacher_kl: float
    prototype: float
    distillation_temperature: float
    pseudo_residual_mix: float


_BASE_RUNTIME = v7._runtime  # noqa: SLF001
_BASE_CONFIGURATION = r2._configuration  # noqa: SLF001
_BASE_CHECKPOINT_PAYLOAD = v7._checkpoint_payload  # noqa: SLF001
_BASE_SOURCE_FINGERPRINT = v7._source_fingerprint  # noqa: SLF001
_BASE_VALIDATE_OUTPUT = v7.validate_output


@dataclass(frozen=True)
class MasterTrainCacheRow:
    cache_index: int
    master_line_number: int
    master_line_sha256: str
    sample_id: str


@dataclass(frozen=True)
class MasterTrainHiddenCacheBinding:
    root: Path
    build_contract_sha256: str
    cache_identity_sha256: str
    manifest_sha256: str
    master_manifest_sha256: str
    model_contract_sha256: str
    row_count: int
    sample_index_sha256: str
    sample_order_sha256: str
    train_sample_ids_sha256: str
    view_contract_sha256: str

    def record(self) -> dict[str, Any]:
        return {
            "build_contract_sha256": self.build_contract_sha256,
            "cache_identity_sha256": self.cache_identity_sha256,
            "cache_is_label_authority": False,
            "kind": CACHED_REAL_VISUAL_MODE,
            "manifest_sha256": self.manifest_sha256,
            "master_manifest_sha256": self.master_manifest_sha256,
            "model_contract_sha256": self.model_contract_sha256,
            "optimizer_feature_splits": ["train"],
            "row_count": self.row_count,
            "sample_index_sha256": self.sample_index_sha256,
            "sample_order_sha256": self.sample_order_sha256,
            "tensor_shape": [
                self.row_count,
                len(v7.base.VIEW_NAMES),
                v7.PATCH_COUNT,
                v7.HIDDEN_SIZE,
            ],
            "test_feature_rows_read_by_optimizer": 0,
            "train_feature_rows_available": v7.mass21.MASTER_TRAIN_ROWS,
            "train_sample_ids_sha256": self.train_sample_ids_sha256,
            "training_eligible_without_separate_labels": False,
            "validation_feature_rows_read_by_optimizer": 0,
            "view_contract_sha256": self.view_contract_sha256,
        }


@dataclass(frozen=True)
class MasterTrainHiddenCacheReader:
    """Read only master-v3 train rows from a fully validated patch-token cache."""

    binding: MasterTrainHiddenCacheBinding
    shards: tuple[Mapping[str, Any], ...]
    shard_by_cache_index: tuple[int, ...]
    shard_array_stats: tuple[tuple[int, int], ...]
    train_rows: tuple[MasterTrainCacheRow, ...]

    def read_real_entries(self, entries: Sequence[Any]) -> np.ndarray:
        if not entries:
            raise MangaFontV7Mass21R3Error("cached real batch cannot be empty")
        requests: dict[int, list[tuple[int, int]]] = {}
        for output_index, entry in enumerate(entries):
            train_index = int(entry.row_index)
            if not 0 <= train_index < len(self.train_rows):
                raise MangaFontV7Mass21R3Error(
                    "cached real batch escaped the train-only index"
                )
            binding = self.train_rows[train_index]
            if binding.sample_id != entry.sample_id:
                raise MangaFontV7Mass21R3Error(
                    "cached real batch sample identity drifted"
                )
            shard_index = self.shard_by_cache_index[binding.cache_index]
            requests.setdefault(shard_index, []).append(
                (output_index, binding.cache_index)
            )

        result = np.empty(
            (
                len(entries),
                len(v7.base.VIEW_NAMES),
                v7.PATCH_COUNT,
                v7.HIDDEN_SIZE,
            ),
            dtype="<f2",
        )
        for shard_index, selected in requests.items():
            descriptor = self.shards[shard_index]
            shard_start = int(descriptor["start_cache_index"])
            shard_dir = self.binding.root / hidden_cache.SHARDS_DIR / str(
                descriptor["directory"]
            )
            array_path = shard_dir / hidden_cache.SHARD_ARRAY
            if (
                shard_dir.is_symlink()
                or not shard_dir.is_dir()
                or array_path.is_symlink()
                or not array_path.is_file()
            ):
                raise MangaFontV7Mass21R3Error(
                    "validated hidden-cache shard disappeared or became linked"
                )
            stat = array_path.stat()
            if (stat.st_size, stat.st_mtime_ns) != self.shard_array_stats[shard_index]:
                raise MangaFontV7Mass21R3Error(
                    "validated hidden-cache shard changed after preflight"
                )
            try:
                values = np.load(array_path, mmap_mode="r", allow_pickle=False)
            except (OSError, ValueError) as error:
                raise MangaFontV7Mass21R3Error(
                    "validated hidden-cache shard could not be reopened"
                ) from error
            expected_shape = (
                int(descriptor["row_count"]),
                len(v7.base.VIEW_NAMES),
                v7.PATCH_COUNT,
                v7.HIDDEN_SIZE,
            )
            try:
                if values.dtype != np.dtype("<f2"):
                    raise MangaFontV7Mass21R3Error(
                        "pooled or non-float16 hidden cache is forbidden"
                    )
                if values.shape == (
                    expected_shape[0],
                    len(v7.base.VIEW_NAMES),
                    v7.HIDDEN_SIZE,
                ):
                    raise MangaFontV7Mass21R3Error(
                        "pooled (N,3,768) hidden cache is forbidden"
                    )
                if values.shape != expected_shape:
                    raise MangaFontV7Mass21R3Error(
                        "hidden-cache shard patch shape drifted"
                    )
                output_positions = [item[0] for item in selected]
                local_indices = [item[1] - shard_start for item in selected]
                result[output_positions] = values[local_indices]
            finally:
                mapped = getattr(values, "_mmap", None)
                if mapped is not None:
                    mapped.close()
        if not np.isfinite(result).all():
            raise MangaFontV7Mass21R3Error(
                "hidden-cache train batch contains non-finite values"
            )
        return result


_ACTIVE_MASTER_HIDDEN_CACHE: MasterTrainHiddenCacheReader | None = None


def _uses_master_hidden_cache(args: argparse.Namespace) -> bool:
    return getattr(args, "master_hidden_cache_dir", None) is not None


def _load_master_train_hidden_cache_reader(
    args: argparse.Namespace,
    real: Any,
) -> MasterTrainHiddenCacheReader | None:
    if not _uses_master_hidden_cache(args):
        return None
    root = args.master_hidden_cache_dir.expanduser().resolve()
    try:
        # Validate against the complete master plan, rather than accepting a
        # bounded cache prefix.  The plan contains metadata only; no val/test
        # feature row is exposed through the training reader below.
        plan = hidden_cache.load_master_plan(
            args.master_dir,
            catalog_registry=args.master_catalog_registry,
            max_samples=None,
        )
        validation = hidden_cache.validate_cache_against_plan(root, plan=plan)
    except (hidden_cache.HiddenStateCacheError, OSError) as error:
        raise MangaFontV7Mass21R3Error(
            f"master hidden-cache validation failed: {error}"
        ) from error
    build_contract = v7.base.read_json(
        root / hidden_cache.BUILD_CONTRACT,
        location="master hidden-cache build contract",
    )
    manifest = v7.base.read_json(
        root / hidden_cache.MANIFEST,
        location="master hidden-cache manifest",
    )
    model = v7._mapping(build_contract.get("model"), "master hidden-cache model")  # noqa: SLF001
    views = v7._mapping(build_contract.get("views"), "master hidden-cache views")  # noqa: SLF001
    tensor = v7._mapping(build_contract.get("tensor"), "master hidden-cache tensor")  # noqa: SLF001
    row_count = int(validation.get("row_count", -1))
    if (
        validation.get("status") != "valid_siglip2_last_hidden_state_cache"
        or row_count != v7.mass21.MASTER_TOTAL_ROWS
        or validation.get("master_manifest_sha256") != real.manifest_sha256
        or plan.source_bindings.get("master_manifest_sha256")
        != real.manifest_sha256
        or validation.get("training_eligible_by_itself") is not False
        or validation.get("tensor_shape")
        != [
            row_count,
            len(v7.base.VIEW_NAMES),
            v7.PATCH_COUNT,
            v7.HIDDEN_SIZE,
        ]
    ):
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache validation/master boundary drifted"
        )
    if (
        model.get("base_model_id") != v7.base.MODEL_ID
        or model.get("base_model_revision") != v7.base.MODEL_REVISION
        or model.get("cached_tensor") != "last_hidden_state"
        or model.get("pooler_output_used") is not False
        or int(model.get("hidden_size", 0)) != v7.HIDDEN_SIZE
        or int(model.get("image_size", 0)) != hidden_cache.IMAGE_SIZE
        or int(model.get("patch_count", 0)) != v7.PATCH_COUNT
        or int(model.get("patch_size", 0)) != hidden_cache.PATCH_SIZE
        or model.get("processor_use_fast") != v7.base.PROCESSOR_USE_FAST
        or views != hidden_cache._view_contract()  # noqa: SLF001
        or tensor != hidden_cache._tensor_contract()  # noqa: SLF001
    ):
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache model/view/patch contract drifted"
        )
    model_sha = v7.base.sha256_bytes(
        v7.base.canonical_json(model).encode("utf-8")
    )
    view_sha = v7.base.sha256_bytes(
        v7.base.canonical_json(views).encode("utf-8")
    )
    if (
        validation.get("model_contract_sha256") != model_sha
        or validation.get("view_contract_sha256") != view_sha
        or validation.get("build_contract_sha256")
        != v7.base.sha256_file(root / hidden_cache.BUILD_CONTRACT)
        or validation.get("manifest_sha256")
        != v7.base.sha256_file(root / hidden_cache.MANIFEST)
        or validation.get("sample_index_sha256")
        != v7.base.sha256_file(root / hidden_cache.SAMPLE_INDEX)
    ):
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache model/view/index SHA drifted"
        )

    planned_train = tuple(row for row in plan.rows if row.split == "train")
    if len(planned_train) != len(real.entries) or len(planned_train) != v7.mass21.MASTER_TRAIN_ROWS:
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache train inventory drifted"
        )
    train_rows: list[MasterTrainCacheRow] = []
    for train_index, (cache_row, entry) in enumerate(
        zip(planned_train, real.entries, strict=True)
    ):
        if (
            entry.row_index != train_index
            or cache_row.cache_index != cache_row.master_row_index
            or cache_row.master_row_index != entry.line_number - 1
            or cache_row.line_number != entry.line_number
            or cache_row.master_line_sha256 != entry.line_sha256
            or cache_row.sample_id != entry.sample_id
            or cache_row.work_id != entry.work_id
            or cache_row.source_catalog_id != entry.source_catalog_id
            or cache_row.split != "train"
        ):
            raise MangaFontV7Mass21R3Error(
                "master hidden-cache train sample/order/split binding drifted"
            )
        train_rows.append(
            MasterTrainCacheRow(
                cache_index=cache_row.cache_index,
                master_line_number=cache_row.line_number,
                master_line_sha256=cache_row.master_line_sha256,
                sample_id=cache_row.sample_id,
            )
        )

    raw_shards = manifest.get("shards")
    if not isinstance(raw_shards, Sequence) or isinstance(
        raw_shards, (str, bytes, bytearray)
    ):
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache shard manifest drifted"
        )
    shards = tuple(
        v7._mapping(value, f"master hidden-cache shard:{index}")  # noqa: SLF001
        for index, value in enumerate(raw_shards)
    )
    shard_by_cache_index = [-1] * row_count
    shard_array_stats: list[tuple[int, int]] = []
    cursor = 0
    for shard_index, descriptor in enumerate(shards):
        start = int(descriptor.get("start_cache_index", -1))
        stop = int(descriptor.get("end_cache_index_exclusive", -1))
        count = int(descriptor.get("row_count", -1))
        if (
            int(descriptor.get("shard_ordinal", -1)) != shard_index
            or start != cursor
            or stop <= start
            or count != stop - start
            or stop > row_count
        ):
            raise MangaFontV7Mass21R3Error(
                "master hidden-cache shard coverage drifted"
            )
        shard_by_cache_index[start:stop] = [shard_index] * count
        shard_dir = root / hidden_cache.SHARDS_DIR / str(descriptor.get("directory", ""))
        array_path = shard_dir / hidden_cache.SHARD_ARRAY
        if (
            shard_dir.is_symlink()
            or not shard_dir.is_dir()
            or array_path.is_symlink()
            or not array_path.is_file()
        ):
            raise MangaFontV7Mass21R3Error(
                "master hidden-cache shard array is missing or linked"
            )
        stat = array_path.stat()
        shard_array_stats.append((stat.st_size, stat.st_mtime_ns))
        cursor = stop
    if cursor != row_count or any(value < 0 for value in shard_by_cache_index):
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache shard coverage has a gap"
        )
    train_ids_sha = v7.base.sha256_bytes(
        ("\n".join(row.sample_id for row in train_rows) + "\n").encode("utf-8")
    )
    binding = MasterTrainHiddenCacheBinding(
        root=root,
        build_contract_sha256=str(validation["build_contract_sha256"]),
        cache_identity_sha256=str(validation["cache_identity_sha256"]),
        manifest_sha256=str(validation["manifest_sha256"]),
        master_manifest_sha256=real.manifest_sha256,
        model_contract_sha256=model_sha,
        row_count=row_count,
        sample_index_sha256=str(validation["sample_index_sha256"]),
        sample_order_sha256=str(validation["sample_order_sha256"]),
        train_sample_ids_sha256=train_ids_sha,
        view_contract_sha256=view_sha,
    )
    return MasterTrainHiddenCacheReader(
        binding=binding,
        shards=shards,
        shard_by_cache_index=tuple(shard_by_cache_index),
        shard_array_stats=tuple(shard_array_stats),
        train_rows=tuple(train_rows),
    )


@contextmanager
def _activated_master_hidden_cache(
    reader: MasterTrainHiddenCacheReader | None,
) -> Any:
    global _ACTIVE_MASTER_HIDDEN_CACHE
    if _ACTIVE_MASTER_HIDDEN_CACHE is not None:
        raise MangaFontV7Mass21R3Error("master hidden-cache context is already active")
    _ACTIVE_MASTER_HIDDEN_CACHE = reader
    try:
        yield
    finally:
        _ACTIVE_MASTER_HIDDEN_CACHE = None


def _real_visual_features_record(args: argparse.Namespace) -> dict[str, Any]:
    if not _uses_master_hidden_cache(args):
        return {
            "kind": LIVE_REAL_VISUAL_MODE,
            "optimizer_feature_splits": ["train"],
            "test_feature_rows_read_by_optimizer": 0,
            "validation_feature_rows_read_by_optimizer": 0,
        }
    reader = _ACTIVE_MASTER_HIDDEN_CACHE
    if reader is None or reader.binding.root != args.master_hidden_cache_dir.expanduser().resolve():
        raise MangaFontV7Mass21R3Error(
            "master hidden-cache was requested but is not validated and active"
        )
    return reader.binding.record()


def _source_fingerprint(args: argparse.Namespace) -> dict[str, Any]:
    fingerprint = dict(_BASE_SOURCE_FINGERPRINT(args))
    fingerprint["master_real_visual_features"] = _real_visual_features_record(args)
    return fingerprint


def _source_provenance() -> dict[str, str]:
    return {
        "base_v7_source_code_sha256": v7.base.sha256_file(Path(v7.__file__).resolve()),
        "r2_source_code_sha256": v7.base.sha256_file(Path(r2.__file__).resolve()),
        "r3_source_code_sha256": v7.base.sha256_file(Path(__file__).resolve()),
    }


def _configuration(args: argparse.Namespace) -> dict[str, Any]:
    configuration = dict(_BASE_CONFIGURATION(args))
    configuration.update(
        {
            "distillation_temperature": args.distillation_temperature,
            "family_logit_gemma_weight": 0.0,
            "family_logit_genre_weight": 0.0,
            "family_logit_role_weight": 0.0,
            "frozen_prototype_weight": args.frozen_prototype_weight,
            "frozen_teacher_kl_weight": args.frozen_teacher_kl_weight,
            "frozen_teacher_mode": TEACHER_MODE,
            "prototype_distillation_mode": PROTOTYPE_MODE,
            "pseudo_confidence_mode": PSEUDO_MODE,
            "pseudo_residual_mix": args.pseudo_residual_mix,
            "real_visual_input": (
                CACHED_REAL_VISUAL_MODE
                if _uses_master_hidden_cache(args)
                else LIVE_REAL_VISUAL_MODE
            ),
            "source_schedule": SOURCE_SCHEDULE_MODE,
        }
    )
    return configuration


def _configuration_sha256(args: argparse.Namespace) -> str:
    return v7.base.sha256_bytes(
        v7.base.canonical_json(_configuration(args)).encode("utf-8")
    )


def _loss_weights(args: argparse.Namespace) -> StableLossWeights:
    return StableLossWeights(
        synthetic=args.synthetic_weight,
        full_human=args.full_human_weight,
        partial_human=args.partial_human_weight,
        real_consistency=args.real_consistency_weight,
        domain_moment=args.domain_moment_weight,
        pseudo=args.pseudo_weight,
        attention_diversity=args.attention_diversity_weight,
        teacher_kl=args.frozen_teacher_kl_weight,
        prototype=args.frozen_prototype_weight,
        distillation_temperature=args.distillation_temperature,
        pseudo_residual_mix=args.pseudo_residual_mix,
    )


def _validate_probability_rows(torch: Any, values: Any, *, location: str) -> None:
    if not bool(torch.isfinite(values).all()) or not bool(
        torch.allclose(
            values.float().sum(dim=-1),
            torch.ones(values.shape[0], device=values.device),
            atol=1e-5,
            rtol=0.0,
        )
    ):
        raise MangaFontV7Mass21R3Error(f"{location}: invalid probability rows")


def frozen_teacher_kl_loss(
    torch: Any,
    student_logits: Any,
    teacher_logits: Any,
    row_weights: Any,
    *,
    denominator: int,
    temperature: float,
) -> Any:
    """Work-balanced KL(teacher || student) with a fixed real-batch denominator."""

    if (
        student_logits.ndim != 2
        or student_logits.shape != teacher_logits.shape
        or student_logits.shape[1] != v7.mass21.ACTIVE_CANDIDATE_COUNT
        or row_weights.ndim != 1
        or row_weights.shape[0] != student_logits.shape[0]
        or denominator < student_logits.shape[0]
        or denominator < 1
        or not math.isfinite(temperature)
        or not 1.0 <= temperature <= 4.0
    ):
        raise MangaFontV7Mass21R3Error("frozen-teacher KL tensor contract drifted")
    weights = row_weights.float()
    if not bool(torch.isfinite(weights).all()) or bool(torch.any(weights < 0.0)):
        raise MangaFontV7Mass21R3Error("frozen-teacher KL weights are invalid")
    teacher_log = torch.log_softmax(teacher_logits.detach().float() / temperature, dim=-1)
    teacher_probability = teacher_log.exp()
    student_log = torch.log_softmax(student_logits.float() / temperature, dim=-1)
    per_row = (
        teacher_probability * (teacher_log - student_log)
    ).sum(dim=-1) * (temperature**2)
    return (per_row * weights).sum() / float(denominator)


def frozen_prototype_loss(
    torch: Any, student_prototypes: Any, teacher_prototypes: Any
) -> Any:
    expected = (
        v7.mass21.ACTIVE_CANDIDATE_COUNT,
        v7.QUERY_COUNT,
        v7.QUERY_DIM,
    )
    if tuple(student_prototypes.shape) != expected or tuple(teacher_prototypes.shape) != expected:
        raise MangaFontV7Mass21R3Error("frozen prototype tensor contract drifted")
    student = student_prototypes.float()
    teacher = teacher_prototypes.detach().float()
    if not bool(torch.isfinite(student).all()) or not bool(torch.isfinite(teacher).all()):
        raise MangaFontV7Mass21R3Error("frozen prototypes became nonfinite")
    # Each query prototype is unit-normalized.  Half squared L2 is therefore
    # the smooth nonnegative equivalent of one-minus-cosine.
    return 0.5 * ((student - teacher) ** 2).sum(dim=-1).mean()


def teacher_anchored_pseudo_residual_loss(
    torch: Any,
    student_logits: Any,
    teacher_logits: Any,
    pseudo_targets: Any,
    pseudo_work_confidence_weights: Any,
    work_weights: Any,
    *,
    denominator: int,
    temperature: float,
    residual_mix: float,
) -> tuple[Any, Any]:
    """Move only a confidence-sized fraction from teacher toward a pseudo target."""

    if (
        student_logits.ndim != 2
        or student_logits.shape != teacher_logits.shape
        or student_logits.shape != pseudo_targets.shape
        or student_logits.shape[1] != v7.mass21.ACTIVE_CANDIDATE_COUNT
        or pseudo_work_confidence_weights.shape != work_weights.shape
        or work_weights.ndim != 1
        or work_weights.shape[0] != student_logits.shape[0]
        or denominator < student_logits.shape[0]
        or denominator < 1
        or not math.isfinite(residual_mix)
        or not 0.0 <= residual_mix <= 0.5
    ):
        raise MangaFontV7Mass21R3Error("pseudo-residual tensor contract drifted")
    if student_logits.shape[0] == 0:
        zero = student_logits.sum() * 0.0
        return zero, zero
    pseudo = pseudo_targets.float()
    _validate_probability_rows(torch, pseudo, location="pseudo residual")
    work = work_weights.float()
    weighted_confidence = pseudo_work_confidence_weights.float()
    if (
        not bool(torch.isfinite(work).all())
        or not bool(torch.isfinite(weighted_confidence).all())
        or bool(torch.any(work <= 0.0))
        or bool(torch.any(weighted_confidence < 0.0))
    ):
        raise MangaFontV7Mass21R3Error("pseudo-residual weights are invalid")
    confidence = weighted_confidence / work
    if bool(torch.any(confidence > 1.0 + 1e-5)):
        raise MangaFontV7Mass21R3Error("pseudo confidence escaped [0,1]")
    alpha = (confidence.clamp(0.0, 1.0) * residual_mix).detach()
    teacher_log = torch.log_softmax(teacher_logits.detach().float() / temperature, dim=-1)
    teacher_probability = teacher_log.exp()
    target = teacher_probability + alpha[:, None] * (pseudo - teacher_probability)
    target = target.clamp_min(1e-8)
    target = target / target.sum(dim=-1, keepdim=True)
    student_log = torch.log_softmax(student_logits.float() / temperature, dim=-1)
    per_row = (target * (target.log() - student_log)).sum(dim=-1) * (temperature**2)
    loss = (per_row * work).sum() / float(denominator)
    return loss, alpha.mean()


class FrozenTeacherStudentProxy:
    """Delegate serialization to the student while keeping a private frozen teacher."""

    def __init__(self, torch: Any, student: Any, teacher: Any, prototypes: Any) -> None:
        self.torch = torch
        self.student = student
        self.teacher = teacher.eval().requires_grad_(False)
        self.teacher_prototypes = prototypes.detach().clone()

    def train(self, mode: bool = True) -> "FrozenTeacherStudentProxy":
        self.student.train(mode)
        self.teacher.eval()
        return self

    def eval(self) -> "FrozenTeacherStudentProxy":
        return self.train(False)

    def parameters(self, recurse: bool = True) -> Any:
        return self.student.parameters(recurse=recurse)

    def state_dict(self, *args: Any, **kwargs: Any) -> Mapping[str, Any]:
        return self.student.state_dict(*args, **kwargs)

    def load_state_dict(self, state: Mapping[str, Any], strict: bool = True) -> Any:
        return self.student.load_state_dict(state, strict=strict)

    def __call__(
        self,
        view_tokens: Any,
        reference_tokens: Any,
        reference_labels: Any,
        candidate_count: int,
    ) -> Mapping[str, Any]:
        student_result = dict(
            self.student(
                view_tokens, reference_tokens, reference_labels, candidate_count
            )
        )
        if candidate_count != v7.mass21.ACTIVE_CANDIDATE_COUNT:
            raise MangaFontV7Mass21R3Error("teacher proxy candidate count drifted")
        with self.torch.no_grad():
            batch, views, patches, hidden = view_tokens.shape
            encoded, _attention = self.teacher.encode(
                view_tokens.reshape(batch * views, patches, hidden)
            )
            view_embeddings = encoded.reshape(
                batch, views, v7.QUERY_COUNT, v7.QUERY_DIM
            )
            sample_embeddings = self.torch.nn.functional.normalize(
                view_embeddings.mean(dim=1), p=2, dim=-1
            )
            per_query = self.torch.einsum(
                "bqd,cqd->bcq", sample_embeddings, self.teacher_prototypes
            )
            query_weights = self.torch.softmax(
                self.teacher.query_weight_logits.float(), dim=0
            )
            scale = self.teacher.logit_scale.float().exp().clamp(max=100.0)
            teacher_scores = scale * self.torch.einsum(
                "bcq,q->bc", per_query, query_weights
            )
        student_result["frozen_teacher_candidate_scores"] = teacher_scores.detach()
        student_result["frozen_teacher_candidate_prototypes"] = (
            self.teacher_prototypes.detach()
        )
        return student_result


def _runtime(
    args: argparse.Namespace, inputs: v7.mass21.Mass21TrainingInputs
) -> dict[str, Any]:
    runtime = dict(_BASE_RUNTIME(args, inputs))
    torch = runtime["torch"]
    device = runtime["device"]
    student = runtime["model"]
    initial_state = {
        name: value.detach().float().cpu().clone()
        for name, value in student.state_dict().items()
    }
    teacher = v7.v6.build_font_query_head(
        torch, query_count=v7.QUERY_COUNT, query_dim=v7.QUERY_DIM
    )
    teacher.load_state_dict(initial_state, strict=True)
    teacher = teacher.eval().requires_grad_(False).to(device)
    with torch.no_grad():
        teacher_prototypes = teacher.candidate_prototypes(
            runtime["reference_tokens"],
            runtime["reference_labels"],
            v7.mass21.ACTIVE_CANDIDATE_COUNT,
        ).detach()
    if tuple(teacher_prototypes.shape) != (
        v7.mass21.ACTIVE_CANDIDATE_COUNT,
        v7.QUERY_COUNT,
        v7.QUERY_DIM,
    ) or not bool(torch.isfinite(teacher_prototypes).all()):
        raise MangaFontV7Mass21R3Error("frozen teacher prototypes are invalid")
    runtime["model"] = FrozenTeacherStudentProxy(
        torch, student, teacher, teacher_prototypes
    )
    return runtime


def _uniform_sparse_assignments(
    *, count: int, batch_size: int, steps: int, seed: int
) -> tuple[tuple[int, ...], ...]:
    if count < 1 or batch_size < 1 or steps < 1 or math.ceil(count / batch_size) > steps:
        raise MangaFontV7Mass21R3Error("sparse source schedule cannot cover inventory")
    order = list(range(count))
    random.Random(seed).shuffle(order)
    chunks = [tuple(order[start : start + batch_size]) for start in range(0, count, batch_size)]
    result: list[tuple[int, ...]] = [tuple() for _ in range(steps)]
    for index, chunk in enumerate(chunks):
        position = ((2 * index + 1) * steps) // (2 * len(chunks))
        if result[position]:
            raise MangaFontV7Mass21R3Error("sparse source schedule collided")
        result[position] = chunk
    flattened = [value for chunk in result for value in chunk]
    if len(flattened) != count or set(flattened) != set(range(count)):
        raise MangaFontV7Mass21R3Error("sparse source schedule lost rows")
    return tuple(result)


def _epoch_batches(
    args: argparse.Namespace,
    inputs: v7.mass21.Mass21TrainingInputs,
    epoch: int,
) -> tuple[v7.mass21.Mass21EpochBatch, ...]:
    real_count = len(inputs.real.entries)
    steps = math.ceil(real_count / args.real_batch_size)
    real_order = list(range(real_count))
    random.Random(args.seed + epoch - 1).shuffle(real_order)
    full = _uniform_sparse_assignments(
        count=v7.mass21.SUPERVISED_FULL21_ROWS,
        batch_size=args.full_human_batch_size,
        steps=steps,
        seed=args.seed + epoch * 11 + 1,
    )
    partial = _uniform_sparse_assignments(
        count=v7.mass21.SUPERVISED_PARTIAL15_ROWS,
        batch_size=args.partial_human_batch_size,
        steps=steps,
        seed=args.seed + epoch * 11 + 2,
    )
    synthetic = _uniform_sparse_assignments(
        count=v7.mass21.SYNTHETIC21_ROWS,
        batch_size=args.synthetic_batch_size,
        steps=steps,
        seed=args.seed + epoch * 11 + 3,
    )
    batches = tuple(
        v7.mass21.Mass21EpochBatch(
            real_indices=tuple(
                real_order[
                    step * args.real_batch_size : (step + 1) * args.real_batch_size
                ]
            ),
            full_human_indices=full[step],
            partial_human_indices=partial[step],
            synthetic_indices=synthetic[step],
        )
        for step in range(steps)
    )
    coverage = v7._coverage_record(batches)  # noqa: SLF001
    if (
        coverage["real_rows"] != real_count
        or coverage["real_unique"] != real_count
        or coverage["full_human_unique"] != v7.mass21.SUPERVISED_FULL21_ROWS
        or coverage["partial_human_unique"] != v7.mass21.SUPERVISED_PARTIAL15_ROWS
        or coverage["synthetic_unique"] != v7.mass21.SYNTHETIC21_ROWS
    ):
        raise MangaFontV7Mass21R3Error("stable epoch coverage drifted")
    return batches


def _stack_rows_or_empty(
    torch: Any,
    rows: Sequence[np.ndarray],
    *,
    columns: int,
    device: Any,
    dtype: Any,
) -> Any:
    if not rows:
        return torch.empty((0, columns), device=device, dtype=dtype)
    values = np.ascontiguousarray(np.stack(rows, axis=0))
    return torch.from_numpy(values).to(device=device, dtype=dtype, non_blocking=False)


def _open_training_batch(
    *,
    torch: Any,
    batch: v7.mass21.Mass21EpochBatch,
    inputs: v7.mass21.Mass21TrainingInputs,
    arrays: Mapping[str, np.ndarray],
    lookup: v7.HumanLookup,
    master_handle: BinaryIO,
    master_resolver: Any,
    human_resolver: Any,
    encoder: Any,
    processor: Any,
    device: Any,
) -> dict[str, Any]:
    """Open a batch whose auxiliary sources may be absent on most steps."""

    real_entries = [inputs.real.entries[index] for index in batch.real_indices]
    if not real_entries:
        raise MangaFontV7Mass21R3Error("stable batch has no real crops")
    cache_reader = _ACTIVE_MASTER_HIDDEN_CACHE
    real_groups: list[list[Any]] = []
    if cache_reader is None:
        for entry in real_entries:
            row = v7.mass21.read_real_train_row(
                inputs.real, entry, handle=master_handle
            )
            real_groups.append(v7.mass21.open_real_train_views(row, master_resolver))
        real_tokens = None
    else:
        real_tokens = torch.from_numpy(
            np.ascontiguousarray(cache_reader.read_real_entries(real_entries))
        ).to(device=device, dtype=torch.float16, non_blocking=False)

    full_sources = [
        v7.mass21.resolve_full_human_index(index)
        for index in batch.full_human_indices
    ]
    full_dynamic_examples: list[Any] = []
    full_dynamic_slot: dict[int, int] = {}
    for batch_index, source in enumerate(full_sources):
        if source.source == "upgraded_full21_pixels":
            full_dynamic_slot[batch_index] = len(full_dynamic_examples)
            full_dynamic_examples.append(
                inputs.human.upgraded_full_examples[source.source_index]
            )
        elif source.source != "cached_original_full21":
            raise MangaFontV7Mass21R3Error("unknown full-human batch source")
    partial_examples = [
        inputs.human.partial_examples[index] for index in batch.partial_human_indices
    ]
    human_groups = [
        v7.base._open_human_views(example, human_resolver)  # noqa: SLF001
        for example in (*full_dynamic_examples, *partial_examples)
    ]
    real_count = len(real_entries)
    if cache_reader is None:
        dynamic = v7._encode_image_groups(  # noqa: SLF001
            torch=torch,
            encoder=encoder,
            processor=processor,
            image_groups=(*real_groups, *human_groups),
            device=device,
        )
        real_tokens = dynamic[:real_count]
        full_dynamic_offset = real_count
        partial_offset = real_count + len(full_dynamic_examples)
    else:
        if human_groups:
            dynamic = v7._encode_image_groups(  # noqa: SLF001
                torch=torch,
                encoder=encoder,
                processor=processor,
                image_groups=human_groups,
                device=device,
            )
        else:
            dynamic = torch.empty(
                (
                    0,
                    len(v7.base.VIEW_NAMES),
                    v7.PATCH_COUNT,
                    v7.HIDDEN_SIZE,
                ),
                device=device,
                dtype=torch.float16,
            )
        full_dynamic_offset = 0
        partial_offset = len(full_dynamic_examples)
    if real_tokens is None:
        raise MangaFontV7Mass21R3Error("stable real patch tokens are missing")

    full_tokens: list[Any] = []
    full_targets: list[np.ndarray] = []
    full_masks: list[np.ndarray] = []
    for batch_index, source in enumerate(full_sources):
        if source.source == "cached_original_full21":
            full_tokens.append(
                torch.from_numpy(arrays["human_train_tokens"][source.source_index]).to(
                    device=device, dtype=torch.float16, non_blocking=False
                )
            )
            full_targets.append(arrays["human_train_targets"][source.source_index])
            full_masks.append(arrays["human_train_masks"][source.source_index])
        else:
            dynamic_index = full_dynamic_slot[batch_index]
            full_tokens.append(dynamic[full_dynamic_offset + dynamic_index])
            example = full_dynamic_examples[dynamic_index]
            addition_index = lookup.addition_index_by_id[example.sample_id]
            full_targets.append(inputs.human.addition_targets[addition_index])
            full_masks.append(inputs.human.addition_masks[addition_index])

    partial_targets: list[np.ndarray] = []
    partial_masks: list[np.ndarray] = []
    for example in partial_examples:
        addition_index = lookup.addition_index_by_id[example.sample_id]
        partial_targets.append(inputs.human.addition_targets[addition_index])
        partial_masks.append(inputs.human.addition_masks[addition_index])

    synthetic_index = np.asarray(batch.synthetic_indices, dtype=np.int64)
    synthetic_tokens = torch.from_numpy(
        np.ascontiguousarray(arrays["synthetic_tokens"][synthetic_index])
    ).to(device=device, dtype=torch.float16, non_blocking=False)
    synthetic_labels = torch.from_numpy(
        np.ascontiguousarray(arrays["synthetic_labels"][synthetic_index])
    ).to(device=device, dtype=torch.long, non_blocking=False)

    normalization = r2._normalization_for_inputs(inputs)  # noqa: SLF001
    real_weights = torch.tensor(
        [entry.work_weight * normalization.scale for entry in real_entries],
        device=device,
        dtype=torch.float32,
    )
    real_ids = [entry.sample_id for entry in real_entries]
    pseudo_positions: list[int] = []
    pseudo_targets: list[tuple[float, ...]] = []
    pseudo_weights: list[float] = []
    for position, (sample_id, entry) in enumerate(
        zip(real_ids, real_entries, strict=True)
    ):
        target = inputs.pseudo.targets.get(sample_id)
        if target is None:
            continue
        pseudo_positions.append(position)
        pseudo_targets.append(target.probabilities)
        pseudo_weights.append(
            target.weight * entry.work_weight * normalization.scale
        )

    token_parts: list[Any] = [real_tokens]
    if full_tokens:
        token_parts.append(torch.stack(full_tokens, dim=0))
    if partial_examples:
        token_parts.append(
            dynamic[partial_offset : partial_offset + len(partial_examples)]
        )
    if len(batch.synthetic_indices) > 0:
        token_parts.append(synthetic_tokens)
    tokens = torch.cat(tuple(token_parts), dim=0)
    return {
        "full_count": len(full_sources),
        "full_masks": _stack_rows_or_empty(
            torch,
            full_masks,
            columns=v7.mass21.ACTIVE_CANDIDATE_COUNT,
            device=device,
            dtype=torch.bool,
        ),
        "full_targets": _stack_rows_or_empty(
            torch,
            full_targets,
            columns=v7.mass21.ACTIVE_CANDIDATE_COUNT,
            device=device,
            dtype=torch.float32,
        ),
        "partial_count": len(partial_examples),
        "partial_masks": _stack_rows_or_empty(
            torch,
            partial_masks,
            columns=v7.mass21.ACTIVE_CANDIDATE_COUNT,
            device=device,
            dtype=torch.bool,
        ),
        "partial_targets": _stack_rows_or_empty(
            torch,
            partial_targets,
            columns=v7.mass21.ACTIVE_CANDIDATE_COUNT,
            device=device,
            dtype=torch.float32,
        ),
        "pseudo_positions": torch.tensor(
            pseudo_positions, device=device, dtype=torch.long
        ),
        "pseudo_targets": (
            torch.tensor(pseudo_targets, device=device, dtype=torch.float32)
            if pseudo_targets
            else None
        ),
        "pseudo_weights": (
            torch.tensor(pseudo_weights, device=device, dtype=torch.float32)
            if pseudo_weights
            else None
        ),
        "real_count": real_count,
        "real_loss_denominator": r2._nominal_real_batch_size(inputs),  # noqa: SLF001
        "real_weights": real_weights,
        "synthetic_count": len(batch.synthetic_indices),
        "synthetic_labels": synthetic_labels,
        "tokens": tokens,
    }


def _compute_losses(
    *,
    torch: Any,
    result: Mapping[str, Any],
    batch: Mapping[str, Any],
    weights: StableLossWeights,
) -> tuple[Any, dict[str, Any]]:
    real_count = int(batch["real_count"])
    full_count = int(batch["full_count"])
    partial_count = int(batch["partial_count"])
    synthetic_count = int(batch["synthetic_count"])
    denominator = int(batch["real_loss_denominator"])
    full_start = real_count
    partial_start = full_start + full_count
    synthetic_start = partial_start + partial_count
    logits = result["candidate_scores"]
    teacher_logits = result["frozen_teacher_candidate_scores"]
    views = result["view_embeddings"]
    expected_rows = real_count + full_count + partial_count + synthetic_count
    if (
        logits.shape != (expected_rows, v7.mass21.ACTIVE_CANDIDATE_COUNT)
        or teacher_logits.shape != logits.shape
    ):
        raise MangaFontV7Mass21R3Error("stable active21 score shape drifted")
    zero = logits.sum() * 0.0
    synthetic_loss = (
        torch.nn.functional.cross_entropy(
            logits[synthetic_start:], batch["synthetic_labels"]
        )
        if synthetic_count
        else zero
    )
    full_loss = (
        v7.mass21.masked_human_loss(
            torch,
            logits[full_start:partial_start],
            batch["full_targets"],
            batch["full_masks"],
        )
        if full_count
        else zero
    )
    partial_loss = (
        v7.mass21.masked_human_loss(
            torch,
            logits[partial_start:synthetic_start],
            batch["partial_targets"],
            batch["partial_masks"],
        )
        if partial_count
        else zero
    )
    real_consistency = r2._weighted_three_view_consistency_loss(  # noqa: SLF001
        torch,
        views[:real_count],
        batch["real_weights"],
        denominator=denominator,
    )
    domain = (
        v7.mass21.domain_moment_loss(
            torch,
            views[:real_count],
            views[synthetic_start:],
            real_weights=None,
        )
        if synthetic_count
        else zero
    )
    diversity = v7.v6.attention_diversity_loss(torch, result["attention"])
    teacher_kl = frozen_teacher_kl_loss(
        torch,
        logits[:real_count],
        teacher_logits[:real_count],
        batch["real_weights"],
        denominator=denominator,
        temperature=weights.distillation_temperature,
    )
    prototype = frozen_prototype_loss(
        torch,
        result["candidate_prototypes"],
        result["frozen_teacher_candidate_prototypes"],
    )
    if batch["pseudo_targets"] is None:
        pseudo = zero
        pseudo_alpha_mean = zero
        pseudo_rows = 0
    else:
        positions = batch["pseudo_positions"]
        pseudo, pseudo_alpha_mean = teacher_anchored_pseudo_residual_loss(
            torch,
            logits[:real_count].index_select(0, positions),
            teacher_logits[:real_count].index_select(0, positions),
            batch["pseudo_targets"],
            batch["pseudo_weights"],
            batch["real_weights"].index_select(0, positions),
            denominator=denominator,
            temperature=weights.distillation_temperature,
            residual_mix=weights.pseudo_residual_mix,
        )
        pseudo_rows = int(positions.shape[0])
    total = (
        weights.synthetic * synthetic_loss
        + weights.full_human * full_loss
        + weights.partial_human * partial_loss
        + weights.real_consistency * real_consistency
        + weights.domain_moment * domain
        + weights.pseudo * pseudo
        + weights.attention_diversity * diversity
        + weights.teacher_kl * teacher_kl
        + weights.prototype * prototype
    )
    return total, {
        "attention_diversity": diversity,
        "domain_moment": domain,
        "frozen_prototype": prototype,
        "frozen_teacher_kl": teacher_kl,
        "full_human": full_loss,
        "partial_human": partial_loss,
        "pseudo": pseudo,
        "pseudo_alpha_mean": pseudo_alpha_mean,
        "pseudo_rows": pseudo_rows,
        "real_consistency": real_consistency,
        "synthetic": synthetic_loss,
        "teacher_rows": real_count,
        "total": total,
    }


def _require_mass_inputs(inputs: v7.mass21.Mass21TrainingInputs) -> None:
    summary = inputs.summary
    if (
        len(inputs.projection.active_ids) != v7.mass21.ACTIVE_CANDIDATE_COUNT
        or v7.mass21.RETIRED_FONT_ID in inputs.projection.active_ids
        or len(inputs.real.entries) != v7.mass21.MASTER_TRAIN_ROWS
        or len(inputs.pseudo.targets) < MIN_PSEUDO_ROWS
        or int(summary.get("master_test_rows_json_deserialized", -1)) != 0
        or int(summary.get("master_val_rows_json_deserialized", -1)) != 0
    ):
        raise MangaFontV7Mass21R3Error("stable mass21 input boundary drifted")


def _source_exposure_plan(
    args: argparse.Namespace, inputs: v7.mass21.Mass21TrainingInputs
) -> dict[str, Any]:
    _require_mass_inputs(inputs)

    def once(count: int, batch_size: int) -> dict[str, Any]:
        return {
            "batch_size_cap": batch_size,
            "inventory_rows": count,
            "maximum_exposures_per_row": 1,
            "mean_exposures_per_row": 1.0,
            "minimum_exposures_per_row": 1,
            "schedule": SOURCE_SCHEDULE_MODE,
            "slots_per_epoch": count,
        }

    return {
        "epoch_steps": math.ceil(len(inputs.real.entries) / args.real_batch_size),
        "full_human": once(
            v7.mass21.SUPERVISED_FULL21_ROWS, args.full_human_batch_size
        ),
        "partial_human": once(
            v7.mass21.SUPERVISED_PARTIAL15_ROWS, args.partial_human_batch_size
        ),
        "real": once(len(inputs.real.entries), args.real_batch_size),
        "synthetic": once(v7.mass21.SYNTHETIC21_ROWS, args.synthetic_batch_size),
    }


def _weighting_manifest(
    inputs: v7.mass21.Mass21TrainingInputs,
) -> dict[str, Any]:
    _require_mass_inputs(inputs)
    return {
        "domain_moment": r2.DOMAIN_MOMENT_MODE,
        "frozen_prototypes": PROTOTYPE_MODE,
        "frozen_teacher": TEACHER_MODE,
        "pseudo_confidence": PSEUDO_MODE,
        "real_loss_denominator": r2.REAL_DENOMINATOR_MODE,
        "work": r2._normalization_for_inputs(inputs).as_manifest(),  # noqa: SLF001
    }


def _checkpoint_payload(
    *,
    baseline_val: Mapping[str, Any],
    weighting: Mapping[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    payload = dict(_BASE_CHECKPOINT_PAYLOAD(**kwargs))
    args = kwargs["args"]
    payload.update(
        {
            "baseline_val": copy.deepcopy(dict(baseline_val)),
            # r2's proven atomic resume reader checks this compatibility key.
            # Its value is the complete r3 provenance, not an r2-only seal.
            "r2_source_provenance": _source_provenance(),
            "stable_distillation": {
                "frozen_prototype_weight": args.frozen_prototype_weight,
                "frozen_teacher_kl_weight": args.frozen_teacher_kl_weight,
                "pseudo_residual_mix": args.pseudo_residual_mix,
                "temperature": args.distillation_temperature,
            },
            "weighting": copy.deepcopy(dict(weighting)),
        }
    )
    return payload


def _publish_output(
    *,
    args: argparse.Namespace,
    inputs: v7.mass21.Mass21TrainingInputs,
    runtime: Mapping[str, Any],
    candidate_ids: tuple[str, ...],
    history: Sequence[Mapping[str, Any]],
    best_metrics: Mapping[str, Any],
    best_predictions: Sequence[Mapping[str, Any]],
    best_state: Mapping[str, Any],
    best_prototypes: Any,
    best_epoch: int,
    baseline_val: Mapping[str, Any],
    run_state_dir: Path,
    source_fingerprint: Mapping[str, Any],
    timing_seconds: float,
    early_stopped: bool,
) -> Mapping[str, Any]:
    _require_mass_inputs(inputs)
    output = v7._safe_directory(args.output_dir, location="output directory")  # noqa: SLF001
    if output.exists():
        raise MangaFontV7Mass21R3Error("stable r3 output already exists")
    r2._validate_run_state(run_state_dir)  # noqa: SLF001
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        runtime["save_file"](
            dict(best_state),
            str(staging / v7.BEST_HEAD),
            metadata={
                "format": SCHEMA,
                "kind": "active21-frozen-siglip2-patch-query-head",
            },
        )
        prototype_array = np.ascontiguousarray(best_prototypes.numpy(), dtype="<f4")
        if prototype_array.shape != (
            v7.mass21.ACTIVE_CANDIDATE_COUNT,
            v7.QUERY_COUNT,
            v7.QUERY_DIM,
        ) or not np.isfinite(prototype_array).all():
            raise MangaFontV7Mass21R3Error("stable best prototypes are invalid")
        (staging / v7.PROTOTYPES).write_bytes(prototype_array.tobytes())
        with (staging / v7.PREDICTIONS).open("wb") as handle:
            for row in best_predictions:
                handle.write(v7.base.json_bytes(row))
        with (staging / v7.HISTORY).open("wb") as handle:
            for row in history:
                handle.write(v7.base.json_bytes(row))
        shutil.copy2(
            r2._latest_checkpoint_path(run_state_dir),  # noqa: SLF001
            staging / v7.LATEST_CHECKPOINT,
        )
        provenance = _source_provenance()
        manifest = v7.base.seal_record(
            {
                "architecture": {
                    "candidate_bias": False,
                    "candidate_scoring": "query-wise-cosine-to-reference-prototypes",
                    "encoder": v7.base.MODEL_ID,
                    "encoder_revision": v7.base.MODEL_REVISION,
                    "encoder_trainable_blocks": 0,
                    "input_representation": "three-view-last-hidden-state-patch-tokens",
                    "query_count": v7.QUERY_COUNT,
                    "query_dim": v7.QUERY_DIM,
                    "real_train_visual_input": _configuration(args)[
                        "real_visual_input"
                    ],
                    "warm_start": "v6-r3-all160-active21",
                },
                "baseline_val": copy.deepcopy(dict(baseline_val)),
                "best_epoch": best_epoch,
                "best_val": copy.deepcopy(dict(best_metrics)),
                "boundaries": {
                    **{
                        key: value
                        for key, value in inputs.summary.items()
                        if key.endswith("json_deserialized") or key.endswith("skipped")
                    },
                    "family_logit_gemma_contribution": 0.0,
                    "family_logit_genre_contribution": 0.0,
                    "family_logit_role_contribution": 0.0,
                    "gugi_candidate_count": candidate_ids.count(
                        v7.mass21.RETIRED_FONT_ID
                    ),
                    "human_test_labels_deserialized": 0,
                    "human_test_pixels_opened": 0,
                    "master_test_pixels_opened": 0,
                    "master_test_hidden_cache_rows_read_by_optimizer": 0,
                    "master_val_pixels_opened": 0,
                    "master_val_hidden_cache_rows_read_by_optimizer": 0,
                    "test_used_for_model_selection": False,
                    "val33_count": v7.VAL_ROWS,
                    "val33_used_for_early_stop": True,
                    "val33_used_for_model_selection": True,
                    "val_used_for_optimizer": False,
                },
                "candidate_ids": list(candidate_ids),
                "configuration": _configuration(args),
                "distillation": {
                    "all_real_rows_receive_teacher_kl": True,
                    "frozen_prototype_mode": PROTOTYPE_MODE,
                    "frozen_teacher_mode": TEACHER_MODE,
                    "pseudo_mode": PSEUDO_MODE,
                    "teacher_checkpoint_sha256": source_fingerprint[
                        "r3_checkpoint_sha256"
                    ],
                },
                "early_stopped": early_stopped,
                "files": {
                    name: v7._descriptor(staging / name)  # noqa: SLF001
                    for name in (
                        v7.BEST_HEAD,
                        v7.HISTORY,
                        v7.LATEST_CHECKPOINT,
                        v7.PREDICTIONS,
                        v7.PROTOTYPES,
                    )
                },
                "history_epochs": len(history),
                "quality_gate": v7.v6.research_gate(best_metrics),
                "real_visual_features": _real_visual_features_record(args),
                "record_type": "manga_font_student_v7_mass21_r3_teacher_stable_training_manifest",
                "schema_version": SCHEMA,
                "source_code_sha256": provenance["r3_source_code_sha256"],
                "source_fingerprint": copy.deepcopy(dict(source_fingerprint)),
                "source_provenance": provenance,
                "training_inventory": copy.deepcopy(dict(inputs.summary)),
                "training_source_exposure_per_epoch": _source_exposure_plan(
                    args, inputs
                ),
                "training_seconds": timing_seconds,
                "weighting": _weighting_manifest(inputs),
            }
        )
        (staging / v7.MANIFEST).write_bytes(
            v7.base.json_bytes(manifest, pretty=True)
        )
        marker = {
            "artifacts": {
                name: v7.base.sha256_file(staging / name)
                for name in OUTPUT_FILES - {MARKER}
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(v7.base.json_bytes(marker, pretty=True))
        validate_output(staging)
        os.replace(staging, output)
        published = True
        return validate_output(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


@contextmanager
def _patched_runtime(
    *, prebuilt_inputs: v7.mass21.Mass21TrainingInputs | None = None
) -> Any:
    v7_replacements = {
        "SCHEMA": SCHEMA,
        "OWNER": OWNER,
        "MARKER": MARKER,
        "OUTPUT_FILES": OUTPUT_FILES,
        "RUN_STATE_SCHEMA": RUN_STATE_SCHEMA,
        "RUN_STATE_MARKER": RUN_STATE_MARKER,
        "RUN_STATE_FILES": RUN_STATE_FILES,
        "_configuration": _configuration,
        "_configuration_sha256": _configuration_sha256,
        "_source_fingerprint": _source_fingerprint,
        "_runtime": _runtime,
        "_epoch_batches": _epoch_batches,
        "_open_training_batch": _open_training_batch,
        "_loss_weights": _loss_weights,
        "_compute_losses": _compute_losses,
        "_publish_output": _publish_output,
        "_write_run_checkpoint": r2._write_run_checkpoint,  # noqa: SLF001
        "_load_run_checkpoint": r2._load_run_checkpoint,  # noqa: SLF001
        "_validate_run_state": r2._validate_run_state,  # noqa: SLF001
    }
    if prebuilt_inputs is not None:
        if prebuilt_inputs.cached_arrays is None:
            raise MangaFontV7Mass21R3Error(
                "prebuilt training inputs are missing sealed cached arrays"
            )

        def use_prebuilt_inputs(
            _args: argparse.Namespace, *, load_cached_arrays: bool
        ) -> v7.mass21.Mass21TrainingInputs:
            if not load_cached_arrays:
                raise MangaFontV7Mass21R3Error(
                    "training attempted to downgrade prebuilt input loading"
                )
            return prebuilt_inputs

        v7_replacements["_build_inputs"] = use_prebuilt_inputs
    r2_replacements = {
        "SCHEMA": SCHEMA,
        "OWNER": OWNER,
        "MARKER": MARKER,
        "OUTPUT_FILES": OUTPUT_FILES,
        "RUN_STATE_SCHEMA": RUN_STATE_SCHEMA,
        "RUN_STATE_MARKER": RUN_STATE_MARKER,
        "RUN_STATE_FILES": RUN_STATE_FILES,
        "RUN_STATE_CHECKPOINT_A": RUN_STATE_CHECKPOINT_A,
        "RUN_STATE_CHECKPOINT_B": RUN_STATE_CHECKPOINT_B,
        "RUN_STATE_MARKER_A": RUN_STATE_MARKER_A,
        "RUN_STATE_MARKER_B": RUN_STATE_MARKER_B,
        "_configuration": _configuration,
        "_configuration_sha256": _configuration_sha256,
        "_open_training_batch": _open_training_batch,
        "_compute_losses": _compute_losses,
        "_weighting_manifest": _weighting_manifest,
        "_source_exposure_plan": _source_exposure_plan,
        "_source_provenance": _source_provenance,
        "_checkpoint_payload": _checkpoint_payload,
        "_publish_output": _publish_output,
    }
    previous_v7 = {name: getattr(v7, name) for name in v7_replacements}
    previous_r2 = {name: getattr(r2, name) for name in r2_replacements}
    try:
        for name, value in r2_replacements.items():
            setattr(r2, name, value)
        for name, value in v7_replacements.items():
            setattr(v7, name, value)
        yield
    finally:
        for name, value in previous_v7.items():
            setattr(v7, name, value)
        for name, value in previous_r2.items():
            setattr(r2, name, value)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    with _patched_runtime():
        original_file = v7.__file__
        try:
            v7.__file__ = __file__
            result = dict(_BASE_VALIDATE_OUTPUT(output_dir))
        finally:
            v7.__file__ = original_file
    root = output_dir.expanduser().resolve()
    manifest = v7.base.read_json(root / v7.MANIFEST, location="stable r3 manifest")
    configuration = v7._mapping(  # noqa: SLF001
        manifest.get("configuration"), "stable r3 configuration"
    )
    boundaries = v7._mapping(  # noqa: SLF001
        manifest.get("boundaries"), "stable r3 boundaries"
    )
    distillation = v7._mapping(  # noqa: SLF001
        manifest.get("distillation"), "stable r3 distillation"
    )
    inventory = v7._mapping(  # noqa: SLF001
        manifest.get("training_inventory"), "stable r3 inventory"
    )
    exposure = v7._mapping(  # noqa: SLF001
        manifest.get("training_source_exposure_per_epoch"), "stable r3 exposure"
    )
    visual = v7._mapping(  # noqa: SLF001
        manifest.get("real_visual_features"), "stable r3 real visual features"
    )
    source_fingerprint = v7._mapping(  # noqa: SLF001
        manifest.get("source_fingerprint"), "stable r3 source fingerprint"
    )
    baseline = v7._mapping(manifest.get("baseline_val"), "stable r3 baseline")  # noqa: SLF001
    best = v7._mapping(manifest.get("best_val"), "stable r3 best")  # noqa: SLF001
    visual_mode = configuration.get("real_visual_input")
    visual_common_invalid = (
        visual.get("kind") != visual_mode
        or visual.get("optimizer_feature_splits") != ["train"]
        or int(visual.get("test_feature_rows_read_by_optimizer", -1)) != 0
        or int(visual.get("validation_feature_rows_read_by_optimizer", -1)) != 0
        or source_fingerprint.get("master_real_visual_features") != dict(visual)
    )
    cached_visual_invalid = False
    if visual_mode == CACHED_REAL_VISUAL_MODE:
        cached_visual_invalid = (
            visual.get("cache_is_label_authority") is not False
            or visual.get("training_eligible_without_separate_labels") is not False
            or int(visual.get("row_count", -1)) != v7.mass21.MASTER_TOTAL_ROWS
            or int(visual.get("train_feature_rows_available", -1))
            != v7.mass21.MASTER_TRAIN_ROWS
            or visual.get("tensor_shape")
            != [
                v7.mass21.MASTER_TOTAL_ROWS,
                len(v7.base.VIEW_NAMES),
                v7.PATCH_COUNT,
                v7.HIDDEN_SIZE,
            ]
            or any(
                not isinstance(visual.get(name), str)
                or len(str(visual.get(name))) != 64
                for name in (
                    "build_contract_sha256",
                    "cache_identity_sha256",
                    "manifest_sha256",
                    "master_manifest_sha256",
                    "model_contract_sha256",
                    "sample_index_sha256",
                    "sample_order_sha256",
                    "train_sample_ids_sha256",
                    "view_contract_sha256",
                )
            )
        )
    elif visual_mode != LIVE_REAL_VISUAL_MODE:
        cached_visual_invalid = True
    if (
        manifest.get("source_code_sha256")
        != v7.base.sha256_file(Path(__file__).resolve())
        or visual_common_invalid
        or cached_visual_invalid
        or configuration.get("frozen_teacher_mode") != TEACHER_MODE
        or configuration.get("prototype_distillation_mode") != PROTOTYPE_MODE
        or configuration.get("pseudo_confidence_mode") != PSEUDO_MODE
        or configuration.get("source_schedule") != SOURCE_SCHEDULE_MODE
        or any(
            float(configuration.get(name, math.nan)) != 0.0
            for name in (
                "family_logit_gemma_weight",
                "family_logit_genre_weight",
                "family_logit_role_weight",
            )
        )
        or any(
            float(boundaries.get(name, math.nan)) != 0.0
            for name in (
                "family_logit_gemma_contribution",
                "family_logit_genre_contribution",
                "family_logit_role_contribution",
            )
        )
        or distillation.get("all_real_rows_receive_teacher_kl") is not True
        or int(inventory.get("master_train_rows", 0)) != v7.mass21.MASTER_TRAIN_ROWS
        or int(inventory.get("pseudo_rows", 0)) < MIN_PSEUDO_ROWS
        or any(
            int(v7._mapping(exposure.get(source), f"stable r3 {source}").get(  # noqa: SLF001
                "maximum_exposures_per_row", -1
            ))
            != 1
            for source in ("real", "full_human", "partial_human", "synthetic")
        )
        or (
            int(manifest.get("best_epoch", -1)) == 0 and dict(best) != dict(baseline)
        )
    ):
        raise MangaFontV7Mass21R3Error("stable output contract drifted")
    result["status"] = "validated_v7_mass21_r3_teacher_stable_output"
    result["teacher_mode"] = TEACHER_MODE
    return result


def _preflight_plan(
    args: argparse.Namespace, inputs: v7.mass21.Mass21TrainingInputs
) -> dict[str, Any]:
    _require_mass_inputs(inputs)
    exposure = _source_exposure_plan(args, inputs)
    return {
        **dict(inputs.summary),
        "boundaries": {
            "family_logit_gemma_contribution": 0.0,
            "family_logit_genre_contribution": 0.0,
            "family_logit_role_contribution": 0.0,
            "gugi_present_in_active_candidates": v7.mass21.RETIRED_FONT_ID
            in inputs.projection.active_ids,
            "master_test_rows_json_deserialized": 0,
            "master_test_pixels_opened": 0,
            "master_test_hidden_cache_rows_read_by_optimizer": 0,
            "master_val_rows_json_deserialized": 0,
            "master_val_pixels_opened": 0,
            "master_val_hidden_cache_rows_read_by_optimizer": 0,
            "test_used_for_model_selection": False,
            "val33_used_for_model_selection": True,
            "val_used_for_optimizer": False,
        },
        "configuration": _configuration(args),
        "epoch0": {
            "eligible_for_final_selection": True,
            "source": "v6-r3-all160-active21",
        },
        "mass_usage": {
            "pseudo_rows_are_weak_residual_only": len(inputs.pseudo.targets),
            "real_rows_receive_frozen_teacher_kl": len(inputs.real.entries),
            "real_rows_receive_three_view_consistency": len(inputs.real.entries),
        },
        "preflight_status": "ready_for_v7_mass21_r3_teacher_stable_training",
        "real_visual_features": _real_visual_features_record(args),
        "source_exposure_per_epoch": exposure,
        "source_fingerprint": _source_fingerprint(args),
        "source_provenance": _source_provenance(),
        "weighting": _weighting_manifest(inputs),
    }


def _validate_cli_configuration(args: argparse.Namespace) -> None:
    integer_values = (
        args.epochs,
        args.full_human_batch_size,
        args.partial_human_batch_size,
        args.patience,
        args.real_batch_size,
        args.synthetic_batch_size,
    )
    if any(value < 1 for value in integer_values) or args.epochs > 6:
        raise MangaFontV7Mass21R3Error("stable training counts are unsafe")
    if args.checkpoint_steps < 0:
        raise MangaFontV7Mass21R3Error("checkpoint steps must be nonnegative")
    finite_values = (
        args.gradient_clip,
        args.head_lr,
        args.weight_decay,
        args.synthetic_weight,
        args.full_human_weight,
        args.partial_human_weight,
        args.real_consistency_weight,
        args.domain_moment_weight,
        args.pseudo_weight,
        args.attention_diversity_weight,
        args.frozen_teacher_kl_weight,
        args.frozen_prototype_weight,
        args.distillation_temperature,
        args.pseudo_residual_mix,
    )
    if any(not math.isfinite(value) for value in finite_values):
        raise MangaFontV7Mass21R3Error("stable configuration became nonfinite")
    if (
        not 0.0 < args.head_lr <= 5e-6
        or not 0.0 <= args.weight_decay <= 1e-4
        or not 0.0 < args.gradient_clip <= 0.5
        or not 0.0 < args.synthetic_weight <= 0.15
        or not 0.0 < args.full_human_weight <= 0.25
        or not 0.0 < args.partial_human_weight <= 0.05
        or not 0.0 < args.real_consistency_weight <= 0.10
        or not 0.0 < args.domain_moment_weight <= 0.02
        or not 0.0 < args.pseudo_weight <= 0.50
        or not 0.0 < args.attention_diversity_weight <= 0.01
        or not 1.0 <= args.frozen_teacher_kl_weight <= 8.0
        or not 0.10 <= args.frozen_prototype_weight <= 2.0
        or not 1.0 <= args.distillation_temperature <= 4.0
        or not 0.0 < args.pseudo_residual_mix <= 0.5
    ):
        raise MangaFontV7Mass21R3Error("stable coefficient safety cap was crossed")


def _add_stable_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--master-hidden-cache-dir",
        type=Path,
        help=(
            "optional completed sealed (N,3,196,768) master-v3 SigLIP2 "
            "patch-token cache; only bound train rows are exposed to the optimizer"
        ),
    )
    parser.add_argument("--frozen-teacher-kl-weight", type=float, default=2.0)
    parser.add_argument("--frozen-prototype-weight", type=float, default=0.5)
    parser.add_argument("--distillation-temperature", type=float, default=2.0)
    parser.add_argument("--pseudo-residual-mix", type=float, default=0.25)
    parser.set_defaults(
        epochs=4,
        patience=4,
        head_lr=2e-6,
        weight_decay=1e-6,
        gradient_clip=0.25,
        synthetic_weight=0.05,
        full_human_weight=0.10,
        partial_human_weight=0.02,
        real_consistency_weight=0.02,
        domain_moment_weight=0.005,
        pseudo_weight=0.25,
        attention_diversity_weight=0.001,
        full_human_batch_size=1,
        partial_human_batch_size=1,
        synthetic_batch_size=1,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("preflight")
    v7._add_data_inputs(preflight)  # noqa: SLF001
    v7._add_training_configuration(preflight)  # noqa: SLF001
    _add_stable_arguments(preflight)

    dry_smoke = commands.add_parser("dry-smoke")
    v7._add_data_inputs(dry_smoke)  # noqa: SLF001
    v7._add_training_configuration(dry_smoke)  # noqa: SLF001
    _add_stable_arguments(dry_smoke)
    dry_smoke.set_defaults(
        real_batch_size=2,
        full_human_batch_size=1,
        partial_human_batch_size=1,
        synthetic_batch_size=1,
        resume=False,
    )
    dry_smoke.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    dry_smoke.add_argument("--smoke-steps", type=int, default=1)
    dry_smoke.add_argument(
        "--run-state-dir",
        type=Path,
        default=Path("artifacts/.v7-mass21-r3-teacher-stable-dry-state"),
    )
    dry_smoke.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/.v7-mass21-r3-teacher-stable-dry-output"),
    )

    train = commands.add_parser("train")
    v7._add_data_inputs(train)  # noqa: SLF001
    v7._add_training_configuration(train)  # noqa: SLF001
    _add_stable_arguments(train)
    train.add_argument("--device", choices=("cuda",), default="cuda")
    train.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-r3-teacher-stable-v1"),
    )
    train.add_argument("--run-state-dir", type=Path)
    train.add_argument("--resume", action="store_true")

    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            _validate_cli_configuration(args)
            inputs = v7._build_inputs(  # noqa: SLF001
                args, load_cached_arrays=args.command != "preflight"
            )
            cache_reader = _load_master_train_hidden_cache_reader(args, inputs.real)
            with _activated_master_hidden_cache(cache_reader):
                if args.command == "preflight":
                    result = _preflight_plan(args, inputs)
                else:
                    if args.command == "train" and args.run_state_dir is None:
                        args.run_state_dir = args.output_dir.with_name(
                            args.output_dir.name + ".run-state"
                        )
                    if args.command == "dry-smoke" and not 1 <= args.smoke_steps <= 4:
                        raise MangaFontV7Mass21R3Error("dry smoke steps must be 1..4")
                    with _patched_runtime(prebuilt_inputs=inputs):
                        if args.command == "train":
                            result = r2._train(args)  # noqa: SLF001
                        else:
                            result = r2._dry_smoke(  # noqa: SLF001
                                args, steps=args.smoke_steps
                            )
    except (
        MangaFontV7Mass21R3Error,
        r2.MangaFontV7Mass21R2Error,
        v7.MangaFontV7Mass21Error,
        v7.mass21.MangaFontMass21DataError,
        v7.catalog_assets.CatalogAssetError,
        hidden_cache.HiddenStateCacheError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-v7-mass21-r3 error: {error}") from error
    print(v7.base.canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
