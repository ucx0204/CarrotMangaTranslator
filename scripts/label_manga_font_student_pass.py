#!/usr/bin/env python3
"""Run resumable pass-2 pseudo-labeling with the trained MangaFont student.

The command verifies the complete owned student artifact before loading the
model, then binds every output shard to that artifact, the catalog registry,
the master manifest, and the ordered sample IDs.  Outputs are review evidence,
never gold labels: every row is ``pseudo_not_gold``, training-ineligible, and
not directly promotable (including rows from the frozen test split).

No human-label export is accepted by this program.  Test pixels may be opened
only to create review-queue evidence; human test labels are never an input.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import tempfile
from collections import Counter
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

try:
    import font_matching_catalog_assets as catalog_assets
    import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - repository-root import
    from scripts import font_matching_catalog_assets as catalog_assets  # type: ignore[no-redef]
    from scripts import train_manga_font_student_v1 as trainer  # type: ignore[no-redef]


SCHEMA_VERSION = "manga-font-student-pseudo-label-v1"
SHARD_SCHEMA_VERSION = "manga-font-student-pseudo-shard-v1"
REPORT_SCHEMA_VERSION = "manga-font-student-pseudo-report-v1"
OUTPUT_SCHEMA_VERSION = "manga-font-student-pseudo-output-v1"
OUTPUT_OWNER = "carrot-manga-translator/manga-font-student-pass2"
OUTPUT_MARKER = ".manga-font-student-pass2-owned.json"
PASS_NUMBER = 2
PSEUDO_AUTHORITY = "pseudo_not_gold"
VIEW_NAMES = tuple(trainer.VIEW_NAMES)
ROLE_VALUES = tuple(trainer.ROLE_VALUES)
STYLE_FIELDS = tuple(trainer.STYLE_FIELDS)
TREATMENT_VALUES = {
    field: tuple(values) for field, values in trainer.TREATMENT_VALUES.items()
}
VARIANT_ROLES = frozenset(
    {
        "whisper",
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
    }
)
VARIANT_CATEGORIES = frozenset(
    {"bubble_edge", "text_free", "ocr_hard", "page_sound", "ocr_anime_region"}
)
VALID_SPLITS = frozenset({"train", "val", "test"})
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SHARD_FILE_RE = re.compile(r"^pass2-[0-9]{5}\.(?:jsonl|json)$")


class StudentPassError(ValueError):
    """Raised when an inference input, artifact, or resumable shard is unsafe."""


def _owned_atomic_temporary(name: str) -> bool:
    """Recognize an orphan left only if a prior atomic write was interrupted."""

    return name.startswith(".") and name.endswith(".tmp")


@dataclass(frozen=True)
class MasterRow:
    row_index: int
    row_sha256: str
    sample_id: str
    split: str
    work_id: str
    work_title: str
    chapter_id: str
    chapter_title: str
    page_id: str
    page_name: str
    source_category: str
    source_kind: str
    resolver_sample: Mapping[str, Any]


@dataclass(frozen=True)
class StudentArtifacts:
    root: Path
    contract: Mapping[str, Any]
    candidate_ids: tuple[str, ...]
    prototype_bags: tuple[tuple[int, ...], ...]
    prototypes: np.ndarray
    checkpoint_state: Mapping[str, Any]
    bindings: Mapping[str, str]


@dataclass
class InferenceRuntime:
    torch: Any
    processor: Any
    student: Any
    prototypes: Any
    candidate_bags: tuple[Any, ...]
    candidate_ids: tuple[str, ...]
    device: str
    amp_dtype: Any | None


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise StudentPassError(f"cannot hash {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or SHA_RE.fullmatch(expected) is None:
        raise StudentPassError(f"{location}: invalid record seal")
    actual = sha256_bytes(
        canonical_json(
            {key: value for key, value in record.items() if key != "record_sha256"}
        ).encode("utf-8")
    )
    if actual != expected:
        raise StudentPassError(f"{location}: record seal mismatch")
    return actual


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise StudentPassError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise StudentPassError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise StudentPassError(f"{location}: expected non-empty text")
    return result


def _sha(value: Any, location: str) -> str:
    result = _text(value, location).lower()
    if SHA_RE.fullmatch(result) is None:
        raise StudentPassError(f"{location}: expected SHA-256")
    return result


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise StudentPassError(f"{location}: missing or linked file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise StudentPassError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def atomic_write(path: Path, payload: bytes) -> None:
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


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    atomic_write(
        path,
        (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        ),
    )


def _source_category(row: Mapping[str, Any]) -> str:
    metadata = row.get("metadata")
    if not isinstance(metadata, Mapping):
        return "ordinary"
    value = metadata.get("candidate_primary_category") or metadata.get(
        "candidate_category"
    )
    return str(value) if isinstance(value, str) and value.strip() else "ordinary"


def load_master_rows(path: Path, splits: frozenset[str]) -> tuple[list[MasterRow], str]:
    if path.is_symlink() or not path.is_file():
        raise StudentPassError("master manifest is missing or linked")
    manifest_sha256 = sha256_file(path)
    rows: list[MasterRow] = []
    seen: set[str] = set()
    source_row_index = -1
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            source_row_index += 1
            try:
                raw = _mapping(json.loads(line), f"master row {line_number}")
            except json.JSONDecodeError as error:
                raise StudentPassError(
                    f"master row {line_number}: invalid JSON"
                ) from error
            split = _text(raw.get("split"), f"master row {line_number}.split")
            if split not in VALID_SPLITS:
                raise StudentPassError(f"master row {line_number}: unsupported split")
            if split not in splits:
                continue
            sample_id = _text(raw.get("id"), f"master row {line_number}.id")
            if sample_id in seen:
                raise StudentPassError(f"duplicate master sample id: {sample_id}")
            seen.add(sample_id)
            work = _mapping(raw.get("work"), f"{sample_id}.work")
            chapter = _mapping(raw.get("chapter"), f"{sample_id}.chapter")
            page = _mapping(raw.get("page"), f"{sample_id}.page")
            views = _mapping(raw.get("views"), f"{sample_id}.views")
            if set(views) != set(VIEW_NAMES):
                raise StudentPassError(f"{sample_id}: view inventory drifted")
            provenance = raw.get("provenance")
            source_kind = (
                str(provenance.get("source_kind"))
                if isinstance(provenance, Mapping) and provenance.get("source_kind")
                else "unknown"
            )
            rows.append(
                MasterRow(
                    row_index=source_row_index,
                    row_sha256=sha256_bytes(canonical_json(raw).encode("utf-8")),
                    sample_id=sample_id,
                    split=split,
                    work_id=_text(work.get("id"), f"{sample_id}.work.id"),
                    work_title=_text(work.get("title"), f"{sample_id}.work.title"),
                    chapter_id=_text(chapter.get("id"), f"{sample_id}.chapter.id"),
                    chapter_title=_text(
                        chapter.get("title"), f"{sample_id}.chapter.title"
                    ),
                    page_id=_text(page.get("id"), f"{sample_id}.page.id"),
                    page_name=_text(page.get("name"), f"{sample_id}.page.name"),
                    source_category=_source_category(raw),
                    source_kind=source_kind,
                    resolver_sample={
                        "sample_id": sample_id,
                        "source": {"views": copy.deepcopy(dict(views))},
                    },
                )
            )
    if not rows:
        raise StudentPassError("no master rows selected")
    if sha256_file(path) != manifest_sha256:
        raise StudentPassError("master manifest changed while reading")
    return rows, manifest_sha256


def validate_checkpoint_inventory(
    state_contract: Sequence[Any], state: Mapping[str, Any]
) -> None:
    expected: dict[str, tuple[tuple[int, ...], str]] = {}
    ordered_names: list[str] = []
    for index, raw in enumerate(state_contract):
        row = _mapping(raw, f"state_contract[{index}]")
        if set(row) != {"dtype", "name", "shape"}:
            raise StudentPassError(f"state_contract[{index}]: schema drifted")
        name = _text(row.get("name"), f"state_contract[{index}].name")
        if name in expected:
            raise StudentPassError(f"duplicate checkpoint tensor: {name}")
        shape_raw = _list(row.get("shape"), f"state_contract[{index}].shape")
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in shape_raw
        ):
            raise StudentPassError(f"state_contract[{index}]: invalid shape")
        dtype = _text(row.get("dtype"), f"state_contract[{index}].dtype")
        expected[name] = (tuple(shape_raw), dtype)
        ordered_names.append(name)
    if ordered_names != sorted(ordered_names):
        raise StudentPassError(
            "checkpoint state contract is not deterministically sorted"
        )
    if set(state) != set(expected):
        raise StudentPassError(
            "checkpoint tensor inventory mismatch "
            f"missing={sorted(set(expected) - set(state))} "
            f"extra={sorted(set(state) - set(expected))}"
        )
    for name, value in state.items():
        shape = tuple(int(part) for part in value.shape)
        dtype = str(value.dtype).replace("torch.", "")
        if (shape, dtype) != expected[name]:
            raise StudentPassError(
                f"checkpoint tensor contract mismatch: {name} "
                f"actual={(shape, dtype)} expected={expected[name]}"
            )
        try:
            finite = bool(value.isfinite().all())
        except AttributeError:
            finite = bool(np.isfinite(np.asarray(value)).all())
        if not finite:
            raise StudentPassError(f"checkpoint tensor is non-finite: {name}")


def _load_safetensor_checkpoint(
    checkpoint_path: Path, checkpoint: Mapping[str, Any]
) -> Mapping[str, Any]:
    try:
        from safetensors import safe_open
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover - environment dependency
        raise StudentPassError(
            "safetensors is required for student inference"
        ) from error
    state = load_file(str(checkpoint_path), device="cpu")
    validate_checkpoint_inventory(
        _list(checkpoint.get("state_contract"), "checkpoint.state_contract"), state
    )
    with safe_open(str(checkpoint_path), framework="pt", device="cpu") as handle:
        metadata = handle.metadata() or {}
    expected_metadata = _mapping(checkpoint.get("metadata"), "checkpoint.metadata")
    required_metadata = {
        "base_model_id": trainer.MODEL_ID,
        "base_model_revision": trainer.MODEL_REVISION,
        "format": trainer.OUTPUT_SCHEMA,
        "kind": "trainable_delta_against_pinned_local_base",
    }
    if dict(expected_metadata) != required_metadata:
        raise StudentPassError("checkpoint semantic metadata drifted")
    if metadata != {key: str(value) for key, value in expected_metadata.items()}:
        raise StudentPassError("checkpoint safetensors metadata drifted")
    return state


def validate_student_artifacts(
    student_dir: Path, catalog_registry: Path
) -> StudentArtifacts:
    root = student_dir.expanduser().resolve()
    registry_path = catalog_registry.expanduser().resolve()
    try:
        validation = trainer.validate_output(root)
    except (trainer.MangaFontStudentError, OSError) as error:
        raise StudentPassError(
            f"student artifact validation failed: {error}"
        ) from error
    contract_path = root / trainer.CONTRACT_FILE
    checkpoint_path = root / trainer.CHECKPOINT_FILE
    prototype_path = root / trainer.PROTOTYPE_FILE
    contract = read_json(contract_path, location="student model contract")
    validate_record_seal(contract, location="student model contract")
    contract_sha = sha256_file(contract_path)
    if validation.get("model_contract_sha256") != contract_sha:
        raise StudentPassError("trainer validation returned another model contract")
    if contract.get("source_code_sha256") != sha256_file(
        Path(trainer.__file__).resolve()
    ):
        raise StudentPassError("student contract is bound to another trainer source")

    registry = read_json(registry_path, location="catalog registry")
    registry_record_sha = validate_record_seal(registry, location="catalog registry")
    registry_sha = sha256_file(registry_path)
    inputs = _mapping(contract.get("inputs"), "student contract.inputs")
    if (
        inputs.get("catalog_registry_sha256") != registry_sha
        or inputs.get("catalog_registry_record_sha256") != registry_record_sha
    ):
        raise StudentPassError("student artifact is bound to another catalog registry")

    architecture = _mapping(
        contract.get("architecture"), "student contract.architecture"
    )
    if (
        architecture.get("candidate_count") != trainer.CANDIDATE_COUNT
        or architecture.get("projection_dim") != trainer.PROJECTION_DIM
        or architecture.get("view_names") != list(VIEW_NAMES)
        or architecture.get("embedding_normalization") != "l2"
    ):
        raise StudentPassError("student architecture contract drifted")
    vocabulary = _mapping(contract.get("vocabulary"), "student contract.vocabulary")
    candidate_ids = tuple(
        _text(value, f"candidate_ids[{index}]")
        for index, value in enumerate(
            _list(vocabulary.get("candidate_ids"), "student candidate ids")
        )
    )
    if len(candidate_ids) != 22 or len(set(candidate_ids)) != 22:
        raise StudentPassError("student candidate vocabulary must be exact 22")
    if (
        vocabulary.get("roles") != list(ROLE_VALUES)
        or vocabulary.get("style_fields") != list(STYLE_FIELDS)
        or vocabulary.get("treatments")
        != {field: list(values) for field, values in TREATMENT_VALUES.items()}
    ):
        raise StudentPassError("student auxiliary vocabulary drifted")

    checkpoint = _mapping(contract.get("checkpoint"), "student contract.checkpoint")
    if (
        checkpoint.get("file") != trainer.CHECKPOINT_FILE
        or checkpoint.get("sha256") != sha256_file(checkpoint_path)
        or checkpoint.get("byte_size") != checkpoint_path.stat().st_size
        or checkpoint.get("kind") != "trainable_delta_against_pinned_local_base"
    ):
        raise StudentPassError("checkpoint descriptor drifted")
    state = _load_safetensor_checkpoint(checkpoint_path, checkpoint)

    prototype = _mapping(contract.get("prototype_bank"), "student prototype_bank")
    count = prototype.get("prototype_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 22:
        raise StudentPassError("prototype count is invalid")
    if (
        prototype.get("file") != trainer.PROTOTYPE_FILE
        or prototype.get("sha256") != sha256_file(prototype_path)
        or prototype.get("byte_size") != prototype_path.stat().st_size
        or prototype.get("feature_dim") != trainer.PROJECTION_DIM
        or prototype_path.stat().st_size != count * trainer.PROJECTION_DIM * 4
    ):
        raise StudentPassError("prototype descriptor drifted")
    prototypes = np.fromfile(prototype_path, dtype="<f4")
    prototypes = prototypes.reshape(count, trainer.PROJECTION_DIM)
    if not np.isfinite(prototypes).all():
        raise StudentPassError("prototype bank contains non-finite values")
    prototype_norms = np.linalg.norm(prototypes.astype(np.float64), axis=1)
    if not np.allclose(prototype_norms, 1.0, rtol=0.0, atol=2e-4):
        raise StudentPassError("prototype bank violates its l2-normalization contract")
    raw_bags = _list(prototype.get("candidate_bags"), "student prototype bags")
    if len(raw_bags) != len(candidate_ids):
        raise StudentPassError("prototype bag count does not match candidates")
    bags: list[tuple[int, ...]] = []
    next_start = 0
    for candidate_id, raw_bag in zip(
        candidate_ids,
        raw_bags,
        strict=True,
    ):
        bag = _mapping(raw_bag, f"prototype bag {candidate_id}")
        bag_count = bag.get("count")
        if (
            set(bag) != {"candidate_id", "count", "start"}
            or bag.get("candidate_id") != candidate_id
            or bag.get("start") != next_start
            or isinstance(bag_count, bool)
            or not isinstance(bag_count, int)
            or bag_count < 1
        ):
            raise StudentPassError(f"prototype bag drifted: {candidate_id}")
        bags.append(tuple(range(next_start, next_start + bag_count)))
        next_start += bag_count
    if len(bags) != 22 or next_start != count:
        raise StudentPassError("prototype bags do not cover the bank")

    return StudentArtifacts(
        root=root,
        contract=contract,
        candidate_ids=candidate_ids,
        prototype_bags=tuple(bags),
        prototypes=prototypes,
        checkpoint_state=state,
        bindings={
            "catalog_registry_record_sha256": registry_record_sha,
            "catalog_registry_sha256": registry_sha,
            "checkpoint_sha256": sha256_file(checkpoint_path),
            "model_contract_record_sha256": _sha(
                contract.get("record_sha256"), "model contract record seal"
            ),
            "model_contract_sha256": contract_sha,
            "prototype_features_sha256": sha256_file(prototype_path),
        },
    )


def build_inference_runtime(
    artifacts: StudentArtifacts, *, device: str, amp_dtype: str
) -> InferenceRuntime:
    try:
        import torch
        from transformers import AutoImageProcessor, SiglipVisionModel
    except (ImportError, OSError) as error:  # pragma: no cover - environment dependency
        raise StudentPassError(
            "torch and transformers are required for inference"
        ) from error
    actual_device = device
    if actual_device == "auto":
        actual_device = "cuda" if torch.cuda.is_available() else "cpu"
    if actual_device == "cuda" and not torch.cuda.is_available():
        raise StudentPassError("CUDA was requested but is unavailable")
    encoder = _mapping(artifacts.contract.get("encoder"), "student contract.encoder")
    processor = AutoImageProcessor.from_pretrained(
        encoder.get("model_id"),
        revision=encoder.get("revision"),
        use_fast=trainer.PROCESSOR_USE_FAST,
        local_files_only=True,
    )
    processor_hash = sha256_bytes(
        trainer.canonical_json(processor.to_dict()).encode("utf-8")
    )
    preprocessing = _mapping(
        artifacts.contract.get("preprocessing"), "student contract.preprocessing"
    )
    if processor_hash != preprocessing.get("processor_config_sha256"):
        raise StudentPassError("local image processor differs from training")
    vision_encoder = SiglipVisionModel.from_pretrained(
        encoder.get("model_id"),
        revision=encoder.get("revision"),
        local_files_only=True,
    )
    student, trainable_blocks = trainer.build_student_model(
        torch,
        vision_encoder=vision_encoder,
        candidate_count=len(artifacts.candidate_ids),
    )
    if list(trainable_blocks) != encoder.get("trainable_block_indices"):
        raise StudentPassError("local student trainable block layout drifted")
    trainable_names = {
        name
        for name, parameter in student.named_parameters()
        if parameter.requires_grad
    }
    if trainable_names != set(artifacts.checkpoint_state):
        raise StudentPassError("checkpoint is not the exact trainable student state")
    load_result = student.load_state_dict(artifacts.checkpoint_state, strict=False)
    if load_result.unexpected_keys:
        raise StudentPassError(
            f"unexpected checkpoint keys: {load_result.unexpected_keys}"
        )
    student.eval().to(actual_device)
    prototypes = torch.from_numpy(artifacts.prototypes.copy()).to(
        actual_device, dtype=torch.float32
    )
    candidate_bags = tuple(
        torch.tensor(values, dtype=torch.long, device=actual_device)
        for values in artifacts.prototype_bags
    )
    selected_amp: Any | None = None
    if actual_device == "cuda" and amp_dtype != "float32":
        if amp_dtype == "auto":
            selected_amp = (
                torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            )
        elif amp_dtype == "bfloat16":
            if not torch.cuda.is_bf16_supported():
                raise StudentPassError("CUDA bfloat16 was requested but is unavailable")
            selected_amp = torch.bfloat16
        elif amp_dtype == "float16":
            selected_amp = torch.float16
    if actual_device == "cuda":
        torch.backends.cudnn.benchmark = True
        torch.set_float32_matmul_precision("high")
    return InferenceRuntime(
        torch=torch,
        processor=processor,
        student=student,
        prototypes=prototypes,
        candidate_bags=candidate_bags,
        candidate_ids=artifacts.candidate_ids,
        device=actual_device,
        amp_dtype=selected_amp,
    )


def infer_batch(
    runtime: InferenceRuntime, images: Sequence[Any]
) -> dict[str, np.ndarray]:
    torch = runtime.torch
    if not images or len(images) % len(VIEW_NAMES) != 0:
        raise StudentPassError("inference image batch is not complete three-view data")
    processed = runtime.processor(
        images=list(images),
        return_tensors="pt",
        do_resize=False,
        do_convert_rgb=True,
    )
    pixels = processed["pixel_values"]
    if tuple(pixels.shape[-2:]) != (224, 224) or pixels.shape[0] != len(images):
        raise StudentPassError("student processor changed the 224x224 batch")
    pixels = pixels.to(runtime.device, non_blocking=runtime.device == "cuda")
    context = (
        torch.autocast(device_type="cuda", dtype=runtime.amp_dtype)
        if runtime.device == "cuda" and runtime.amp_dtype is not None
        else nullcontext()
    )
    runtime.student.eval()
    with torch.inference_mode(), context:
        embeddings, direct_logits = runtime.student(pixels)
        batch_size = len(images) // len(VIEW_NAMES)
        views = embeddings.reshape(batch_size, len(VIEW_NAMES), trainer.PROJECTION_DIM)
        direct_views = direct_logits.reshape(batch_size, len(VIEW_NAMES), -1)
        direct = direct_views.mean(dim=1)
        ranked = runtime.student.runtime_forward(
            views, runtime.prototypes, runtime.candidate_bags
        )
    result = {
        "candidate_scores": ranked["candidate_scores"],
        "direct_scores": direct,
        "direct_view_scores": direct_views,
        "none_logits": ranked["none_logits"],
        "role_logits": ranked["role_logits"],
        "style_logits": ranked["style_logits"],
        "view_gate_weights": ranked["view_gate_weights"],
    }
    for field in TREATMENT_VALUES:
        result[f"treatment_{field}_logits"] = ranked["treatment_logits"][field]
    numpy_result: dict[str, np.ndarray] = {}
    for key, value in result.items():
        converted = value.detach().float().cpu().numpy()
        if not np.isfinite(converted).all():
            raise StudentPassError(f"student produced non-finite {key}")
        numpy_result[key] = converted
    return numpy_result


def softmax(values: np.ndarray, *, temperature: float = 1.0) -> np.ndarray:
    if not math.isfinite(temperature) or temperature <= 0:
        raise StudentPassError("temperature must be positive and finite")
    scaled = np.asarray(values, dtype=np.float64) / temperature
    scaled -= np.max(scaled, axis=-1, keepdims=True)
    exponent = np.exp(scaled)
    return (exponent / np.sum(exponent, axis=-1, keepdims=True)).astype(np.float32)


def sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(np.asarray(values, dtype=np.float64), -40.0, 40.0)
    return (1.0 / (1.0 + np.exp(-clipped))).astype(np.float32)


def top_entries(
    candidate_ids: Sequence[str], probabilities: np.ndarray, scores: np.ndarray
) -> list[dict[str, Any]]:
    order = np.argsort(-probabilities, kind="stable")[:5]
    return [
        {
            "font_id": candidate_ids[int(index)],
            "probability": round(float(probabilities[index]), 8),
            "rank": rank,
            "score": round(float(scores[index]), 8),
        }
        for rank, index in enumerate(order, 1)
    ]


def review_priority(
    *,
    category: str,
    margin: float,
    selected_font_id: str,
    direct_font_id: str,
    variant_probability: float,
    split: str,
) -> tuple[int, list[str]]:
    reasons: list[str] = []
    variant = category in VARIANT_CATEGORIES or variant_probability >= 0.45
    if variant:
        reasons.append("variant_or_nonballoon_text")
    if margin < 0.08:
        reasons.append("small_top1_margin")
    if selected_font_id != direct_font_id:
        reasons.append("ranker_direct_head_disagreement")
    if split == "test":
        reasons.append("test_split_review_only")
    if variant and (margin < 0.08 or selected_font_id != direct_font_id):
        return 0, reasons
    if variant or margin < 0.15 or selected_font_id != direct_font_id:
        return 1, reasons
    return 2, reasons or ["ordinary_high_margin"]


def build_pseudo_row(
    row: MasterRow,
    outputs: Mapping[str, np.ndarray],
    offset: int,
    *,
    candidate_ids: Sequence[str],
    temperature: float,
    model_bindings: Mapping[str, str],
) -> dict[str, Any]:
    candidate_scores = outputs["candidate_scores"][offset]
    direct_scores = outputs["direct_scores"][offset]
    candidate_probabilities = softmax(candidate_scores, temperature=temperature)
    direct_probabilities = softmax(direct_scores, temperature=temperature)
    top5 = top_entries(candidate_ids, candidate_probabilities, candidate_scores)
    direct_top5 = top_entries(candidate_ids, direct_probabilities, direct_scores)
    selected = str(top5[0]["font_id"])
    direct_selected = str(direct_top5[0]["font_id"])
    margin = round(float(top5[0]["probability"]) - float(top5[1]["probability"]), 8)
    role_probabilities = softmax(outputs["role_logits"][offset])
    role_order = np.argsort(-role_probabilities, kind="stable")[:3]
    variant_probability = round(
        float(
            sum(
                role_probabilities[index]
                for index, role in enumerate(ROLE_VALUES)
                if role in VARIANT_ROLES
            )
        ),
        8,
    )
    priority, reasons = review_priority(
        category=row.source_category,
        margin=margin,
        selected_font_id=selected,
        direct_font_id=direct_selected,
        variant_probability=variant_probability,
        split=row.split,
    )
    treatment: dict[str, Any] = {}
    for field, values in TREATMENT_VALUES.items():
        probabilities = softmax(outputs[f"treatment_{field}_logits"][offset])
        index = int(np.argmax(probabilities))
        treatment[field] = {
            "confidence": round(float(probabilities[index]), 8),
            "value": values[index],
        }
    style_probabilities = sigmoid(outputs["style_logits"][offset])
    none_probability = float(sigmoid(outputs["none_logits"][offset]).item())
    core = {
        "candidate_count": len(candidate_ids),
        "chapter_id": row.chapter_id,
        "chapter_title": row.chapter_title,
        "direct_reference": {
            "selected_font_id": direct_selected,
            "source": "student_three_view_direct_classifier_mean",
            "top5": direct_top5,
        },
        "label_authority": PSEUDO_AUTHORITY,
        "label_status": "pseudo_student_pass_2",
        "model_bindings": dict(model_bindings),
        "none_probability": round(none_probability, 8),
        "page_id": row.page_id,
        "page_name": row.page_name,
        "pass_number": PASS_NUMBER,
        "promotion_allowed": False,
        "provenance": {
            "authority": PSEUDO_AUTHORITY,
            "human_gold_input_accepted": False,
            "human_test_labels_read": False,
            "master_row_sha256": row.row_sha256,
            "pixels_opened_for_review_evidence": True,
        },
        "ranker": {
            "selected_font_id": selected,
            "top1_margin": margin,
            "top5": top5,
        },
        "review": {
            "priority": priority,
            "reasons": reasons,
            "status": "pending",
        },
        "role": {
            "top3": [
                {
                    "confidence": round(float(role_probabilities[index]), 8),
                    "role": ROLE_VALUES[int(index)],
                }
                for index in role_order
            ],
            "variant_probability": variant_probability,
        },
        "sample_id": row.sample_id,
        "schema_version": SCHEMA_VERSION,
        "selected_font_id": selected,
        "selection_source": "manga_font_student_runtime_ranker_top1",
        "source_category": row.source_category,
        "source_kind": row.source_kind,
        "source_row_index": row.row_index,
        "split": row.split,
        "style": {
            field: round(float(style_probabilities[index]), 8)
            for index, field in enumerate(STYLE_FIELDS)
        },
        "training_eligible": False,
        "treatment": treatment,
        "view_gate_weights": {
            view_name: round(float(outputs["view_gate_weights"][offset, view_index]), 8)
            for view_index, view_name in enumerate(VIEW_NAMES)
        },
        "work_id": row.work_id,
        "work_title": row.work_title,
    }
    return seal_record(core)


def _shard_core(
    *,
    shard_index: int,
    rows: Sequence[MasterRow],
    master_manifest_sha256: str,
    bindings: Mapping[str, str],
    temperature: float,
) -> dict[str, Any]:
    return {
        "bindings": dict(bindings),
        "master_manifest_sha256": master_manifest_sha256,
        "pass_number": PASS_NUMBER,
        "row_count": len(rows),
        "sample_ids_sha256": sha256_bytes(
            ("\n".join(row.sample_id for row in rows) + "\n").encode("utf-8")
        ),
        "schema_version": SHARD_SCHEMA_VERSION,
        "shard_index": shard_index,
        "source_row_indices_sha256": sha256_bytes(
            ("\n".join(str(row.row_index) for row in rows) + "\n").encode("utf-8")
        ),
        "temperature": temperature,
    }


def _iter_jsonl(path: Path) -> Iterable[Mapping[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                yield _mapping(json.loads(line), f"{path.name}:{line_number}")
            except json.JSONDecodeError as error:
                raise StudentPassError(
                    f"{path.name}:{line_number}: invalid JSON"
                ) from error


def existing_shard_is_valid(
    *,
    data_path: Path,
    metadata_path: Path,
    expected_core: Mapping[str, Any],
    expected_rows: Sequence[MasterRow],
) -> bool:
    try:
        if any(
            path.is_symlink() or not path.is_file()
            for path in (data_path, metadata_path)
        ):
            return False
        metadata = read_json(metadata_path, location=f"shard {metadata_path.name}")
        validate_record_seal(metadata, location=f"shard {metadata_path.name}")
        for key, value in expected_core.items():
            if metadata.get(key) != value:
                return False
        if (
            metadata.get("data_file") != data_path.name
            or metadata.get("data_sha256") != sha256_file(data_path)
            or metadata.get("data_byte_size") != data_path.stat().st_size
        ):
            return False
        rows = list(_iter_jsonl(data_path))
        if len(rows) != len(expected_rows):
            return False
        for output, expected in zip(rows, expected_rows, strict=True):
            validate_record_seal(output, location=f"shard row {expected.sample_id}")
            if (
                output.get("sample_id") != expected.sample_id
                or output.get("source_row_index") != expected.row_index
                or output.get("pass_number") != PASS_NUMBER
                or output.get("label_authority") != PSEUDO_AUTHORITY
                or output.get("training_eligible") is not False
                or output.get("promotion_allowed") is not False
                or output.get("split") != expected.split
            ):
                return False
        return True
    except (OSError, UnicodeError, StudentPassError, TypeError, ValueError):
        return False


def ensure_owned_output(
    output_dir: Path,
    *,
    bindings: Mapping[str, str],
    master_manifest_sha256: str,
    splits: Sequence[str],
    shard_size: int,
    temperature: float,
) -> Path:
    root = output_dir.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(root.anchor)}
    if root in forbidden or len(root.parts) < 3 or len(root.name) < 3:
        raise StudentPassError(f"unsafe output directory: {root}")
    if root.exists() and (root.is_symlink() or not root.is_dir()):
        raise StudentPassError("output root is linked or not a directory")
    root.mkdir(parents=True, exist_ok=True)
    marker_path = root / OUTPUT_MARKER
    marker_core = {
        "bindings": dict(bindings),
        "master_manifest_sha256": master_manifest_sha256,
        "owner": OUTPUT_OWNER,
        "safe_replace": True,
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "shard_size": shard_size,
        "splits": list(splits),
        "temperature": temperature,
    }
    if marker_path.exists():
        marker = read_json(marker_path, location="pass-2 output marker")
        validate_record_seal(marker, location="pass-2 output marker")
        if marker != seal_record(marker_core):
            raise StudentPassError("output marker is bound to another run")
    else:
        if any(root.iterdir()):
            raise StudentPassError("non-empty output directory lacks ownership marker")
        atomic_json(marker_path, seal_record(marker_core))
    shards = root / "shards"
    if shards.exists() and (shards.is_symlink() or not shards.is_dir()):
        raise StudentPassError("output shard root is unsafe")
    shards.mkdir(exist_ok=True)
    unexpected_root = {
        path.name
        for path in root.iterdir()
        if path.name
        not in {
            OUTPUT_MARKER,
            "shards",
            "pseudo-labels-pass2.jsonl",
            "report-pass2.json",
        }
        and not _owned_atomic_temporary(path.name)
    }
    if unexpected_root:
        raise StudentPassError(f"unexpected output files: {sorted(unexpected_root)}")
    unexpected_shards = {
        path.name
        for path in shards.iterdir()
        if SHARD_FILE_RE.fullmatch(path.name) is None
        and not _owned_atomic_temporary(path.name)
    }
    if unexpected_shards:
        raise StudentPassError(f"unexpected shard files: {sorted(unexpected_shards)}")
    return root


def infer_shard(
    *,
    runtime: InferenceRuntime,
    resolver: Any,
    rows: Sequence[MasterRow],
    batch_size: int,
    temperature: float,
    model_bindings: Mapping[str, str],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        images: list[Any] = []
        try:
            for row in batch:
                for view_name in VIEW_NAMES:
                    with resolver.resolve_sample_view(
                        row.resolver_sample, view_name
                    ) as resolved:
                        if resolved.mode != "RGB" or resolved.size != (224, 224):
                            raise StudentPassError(
                                f"{row.sample_id}/{view_name}: invalid model pixels"
                            )
                        images.append(resolved.image.copy())
            outputs = infer_batch(runtime, images)
        finally:
            for image in images:
                image.close()
        for offset, row in enumerate(batch):
            records.append(
                build_pseudo_row(
                    row,
                    outputs,
                    offset,
                    candidate_ids=runtime.candidate_ids,
                    temperature=temperature,
                    model_bindings=model_bindings,
                )
            )
    return records


def write_shard(
    data_path: Path,
    metadata_path: Path,
    records: Sequence[Mapping[str, Any]],
    core: Mapping[str, Any],
) -> Mapping[str, Any]:
    payload = b"".join(
        (canonical_json(record) + "\n").encode("utf-8") for record in records
    )
    if not payload or len(records) != core.get("row_count"):
        raise StudentPassError("refusing to write an empty/incomplete shard")
    atomic_write(data_path, payload)
    metadata = seal_record(
        {
            **dict(core),
            "data_byte_size": len(payload),
            "data_file": data_path.name,
            "data_sha256": sha256_bytes(payload),
        }
    )
    atomic_json(metadata_path, metadata)
    return metadata


def merge_shards(
    *,
    root: Path,
    shard_paths: Sequence[Path],
    expected_rows: Sequence[MasterRow],
    bindings: Mapping[str, str],
    master_manifest_sha256: str,
    temperature: float,
) -> Mapping[str, Any]:
    output_path = root / "pseudo-labels-pass2.jsonl"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=root
    )
    temporary = Path(temporary_name)
    font_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    priority_counts: Counter[int] = Counter()
    split_counts: Counter[str] = Counter()
    margins: list[float] = []
    row_count = 0
    try:
        with os.fdopen(descriptor, "wb") as output:
            for shard_path in shard_paths:
                for record in _iter_jsonl(shard_path):
                    expected = expected_rows[row_count]
                    validate_record_seal(record, location=f"merged row {row_count}")
                    if (
                        record.get("sample_id") != expected.sample_id
                        or record.get("training_eligible") is not False
                        or record.get("promotion_allowed") is not False
                    ):
                        raise StudentPassError(
                            "shard order/authority drifted during merge"
                        )
                    payload = (canonical_json(record) + "\n").encode("utf-8")
                    output.write(payload)
                    font_counts[str(record["selected_font_id"])] += 1
                    role = _mapping(record.get("role"), "merged role")
                    role_top3 = _list(role.get("top3"), "merged role.top3")
                    role_counts[
                        str(_mapping(role_top3[0], "merged role top1")["role"])
                    ] += 1
                    review = _mapping(record.get("review"), "merged review")
                    priority_counts[int(review["priority"])] += 1
                    split_counts[str(record["split"])] += 1
                    ranker = _mapping(record.get("ranker"), "merged ranker")
                    margins.append(float(ranker["top1_margin"]))
                    row_count += 1
            output.flush()
            os.fsync(output.fileno())
        if row_count != len(expected_rows):
            raise StudentPassError("merged output row count drifted")
        os.replace(temporary, output_path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    margin_array = np.asarray(margins, dtype=np.float64)
    report = seal_record(
        {
            "bindings": dict(bindings),
            "candidate_count": 22,
            "coverage": 1.0,
            "font_usage": dict(sorted(font_counts.items())),
            "human_gold_inputs_read": 0,
            "human_test_labels_read": 0,
            "label_authority": PSEUDO_AUTHORITY,
            "margin": {
                "mean": float(np.mean(margin_array)),
                "median": float(np.median(margin_array)),
                "p10": float(np.quantile(margin_array, 0.10)),
                "p90": float(np.quantile(margin_array, 0.90)),
            },
            "master_manifest_sha256": master_manifest_sha256,
            "output_byte_size": output_path.stat().st_size,
            "output_file": output_path.name,
            "output_sha256": sha256_file(output_path),
            "pass_number": PASS_NUMBER,
            "priority_counts": {
                str(key): value for key, value in sorted(priority_counts.items())
            },
            "promotion_allowed_rows": 0,
            "record_type": "manga_font_student_pseudo_report",
            "role_top1_counts": dict(sorted(role_counts.items())),
            "row_count": row_count,
            "schema_version": REPORT_SCHEMA_VERSION,
            "split_counts": dict(sorted(split_counts.items())),
            "temperature": temperature,
            "training_eligible_rows": 0,
        }
    )
    atomic_json(root / "report-pass2.json", report)
    return report


def label_command(args: argparse.Namespace) -> Mapping[str, Any]:
    if args.shard_size < 1 or args.batch_size < 1:
        raise StudentPassError("shard size and batch size must be positive")
    if not math.isfinite(args.temperature) or args.temperature <= 0:
        raise StudentPassError("temperature must be positive and finite")
    splits = frozenset(part.strip() for part in args.splits.split(",") if part.strip())
    if not splits or not splits <= VALID_SPLITS:
        raise StudentPassError(
            "splits must be a comma-separated subset of train,val,test"
        )
    artifacts = validate_student_artifacts(args.student_dir, args.catalog_registry)
    rows, master_sha = load_master_rows(args.master_manifest.resolve(), splits)
    row_bindings = {
        **artifacts.bindings,
        "master_manifest_sha256": master_sha,
    }
    root = ensure_owned_output(
        args.output_dir,
        bindings=artifacts.bindings,
        master_manifest_sha256=master_sha,
        splits=sorted(splits),
        shard_size=args.shard_size,
        temperature=args.temperature,
    )
    shard_dir = root / "shards"
    shards: list[tuple[Path, Path, Mapping[str, Any], Sequence[MasterRow]]] = []
    for shard_index, start in enumerate(range(0, len(rows), args.shard_size)):
        shard_rows = rows[start : start + args.shard_size]
        stem = f"pass2-{shard_index:05d}"
        data_path = shard_dir / f"{stem}.jsonl"
        metadata_path = shard_dir / f"{stem}.json"
        core = _shard_core(
            shard_index=shard_index,
            rows=shard_rows,
            master_manifest_sha256=master_sha,
            bindings=artifacts.bindings,
            temperature=args.temperature,
        )
        shards.append((data_path, metadata_path, core, shard_rows))
    expected_names = {
        path.name
        for data, metadata, _core, _rows in shards
        for path in (data, metadata)
    }
    actual_names = {
        path.name
        for path in shard_dir.iterdir()
        if not _owned_atomic_temporary(path.name)
    }
    if actual_names - expected_names:
        raise StudentPassError(
            f"stale shard files require a new output directory: {sorted(actual_names - expected_names)}"
        )
    reuse = [
        existing_shard_is_valid(
            data_path=data,
            metadata_path=metadata,
            expected_core=core,
            expected_rows=shard_rows,
        )
        for data, metadata, core, shard_rows in shards
    ]
    runtime: InferenceRuntime | None = None
    resolver: Any | None = None
    if not all(reuse):
        runtime = build_inference_runtime(
            artifacts, device=args.device, amp_dtype=args.amp_dtype
        )
        resolver = catalog_assets.CatalogAssetResolver(args.catalog_registry)
        if resolver.registry_sha256 != artifacts.bindings["catalog_registry_sha256"]:
            raise StudentPassError("catalog registry changed before pixel resolution")
    for index, ((data_path, metadata_path, core, shard_rows), valid) in enumerate(
        zip(shards, reuse, strict=True), 1
    ):
        if valid:
            print(f"pass2 shard {index}/{len(shards)}: reuse", flush=True)
            continue
        assert runtime is not None and resolver is not None
        records = infer_shard(
            runtime=runtime,
            resolver=resolver,
            rows=shard_rows,
            batch_size=args.batch_size,
            temperature=args.temperature,
            model_bindings=row_bindings,
        )
        write_shard(data_path, metadata_path, records, core)
        print(
            f"pass2 shard {index}/{len(shards)}: inferred {len(shard_rows)}",
            flush=True,
        )
    report = merge_shards(
        root=root,
        shard_paths=[value[0] for value in shards],
        expected_rows=rows,
        bindings=artifacts.bindings,
        master_manifest_sha256=master_sha,
        temperature=args.temperature,
    )
    return {
        "coverage": report["coverage"],
        "output": str(root / "pseudo-labels-pass2.jsonl"),
        "report": str(root / "report-pass2.json"),
        "reused_shards": sum(reuse),
        "row_count": report["row_count"],
        "shard_count": len(shards),
        "status": "ready_for_multistage_review_queue",
    }


def validate_command(args: argparse.Namespace) -> Mapping[str, Any]:
    artifacts = validate_student_artifacts(args.student_dir, args.catalog_registry)
    return {
        "candidate_count": len(artifacts.candidate_ids),
        "checkpoint_sha256": artifacts.bindings["checkpoint_sha256"],
        "model_contract_sha256": artifacts.bindings["model_contract_sha256"],
        "prototype_count": int(artifacts.prototypes.shape[0]),
        "status": "ready",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    label = subparsers.add_parser("label", help="infer/resume pass-2 pseudo labels")
    label.add_argument("--student-dir", type=Path, required=True)
    label.add_argument("--master-manifest", type=Path, required=True)
    label.add_argument("--catalog-registry", type=Path, required=True)
    label.add_argument("--output-dir", type=Path, required=True)
    label.add_argument("--splits", default="train,val,test")
    label.add_argument("--shard-size", type=int, default=256)
    label.add_argument("--batch-size", type=int, default=64)
    label.add_argument("--temperature", type=float, default=1.0)
    label.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    label.add_argument(
        "--amp-dtype",
        choices=("auto", "bfloat16", "float16", "float32"),
        default="auto",
    )
    validate = subparsers.add_parser("validate", help="validate a student artifact")
    validate.add_argument("--student-dir", type=Path, required=True)
    validate.add_argument("--catalog-registry", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = (
            label_command(args) if args.command == "label" else validate_command(args)
        )
    except StudentPassError as error:
        raise SystemExit(str(error)) from error
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
