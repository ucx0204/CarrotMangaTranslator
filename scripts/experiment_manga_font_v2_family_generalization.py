#!/usr/bin/env python3
"""Audit and train pixel-only body/variant heads without touching val33.

This is an experimental, fail-closed companion to the v8 adapter trainer.  It
exists because the role-family labels in the large pseudo pool are strongly
work- and source-category-dependent.  Four small heads are compared while:

* balancing every optimizer work x family cell;
* reserving a deterministic train-only calibration fold;
* prioritising actual human role labels over source-category pseudo labels;
* excluding the repeated human val33 identities from every selection metric;
* keeping the r3h body/variant font score branches frozen; and
* reporting the downstream Single Day eligibility effect.

The output is diagnostic and never promotes a runtime automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import train_manga_font_student_v8_role_family_adapter as v8
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v8_role_family_adapter as v8  # type: ignore[no-redef]


SCHEMA_VERSION = "manga-font-v2-family-generalization-experiment-v1"
REPORT_FILE = "report.json"
CHECKPOINT_FILE = "family-head-candidates.safetensors"
MARKER_FILE = ".manga-font-v2-family-generalization-owned.json"
OWNER = "carrot-manga-translator/manga-font-v2-family-generalization-experiment-v1"
BODY = 0
VARIANT = 1


class FamilyGeneralizationError(ValueError):
    """Raised when an experimental boundary or tensor contract drifts."""


@dataclass(frozen=True)
class CandidateSpec:
    name: str
    feature_kind: str
    authority_scope: tuple[str, ...]
    authority_multipliers: Mapping[str, float]
    hidden_dim: int


CANDIDATE_SPECS = (
    CandidateSpec(
        name="query_linear_all_balanced",
        feature_kind="query_mean",
        authority_scope=("none", "visual", "human"),
        authority_multipliers={"none": 0.25, "visual": 2.0, "human": 16.0},
        hidden_dim=0,
    ),
    CandidateSpec(
        name="query_linear_human_visual",
        feature_kind="query_mean",
        authority_scope=("visual", "human"),
        authority_multipliers={"visual": 1.0, "human": 6.0},
        hidden_dim=0,
    ),
    CandidateSpec(
        name="query_stats_human_only",
        feature_kind="query_stats",
        authority_scope=("human",),
        authority_multipliers={"human": 1.0},
        hidden_dim=0,
    ),
    CandidateSpec(
        name="patch_stats_human_only",
        feature_kind="patch_stats",
        authority_scope=("human",),
        authority_multipliers={"human": 1.0},
        hidden_dim=0,
    ),
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise FamilyGeneralizationError(f"{path}: expected a JSON object")
    return value


def load_val33_identities(path: Path) -> tuple[str, ...]:
    """Read identities only, so final labels cannot enter model selection."""

    identities: list[str] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            value = json.loads(line)
            sample_id = value.get("sample_id")
            if not isinstance(sample_id, str) or not sample_id:
                raise FamilyGeneralizationError("val33 row lacks sample_id")
            identities.append(sample_id)
    if len(identities) != 33 or len(set(identities)) != 33:
        raise FamilyGeneralizationError("val33 identity count drifted")
    return tuple(identities)


def load_val33_roles(path: Path) -> Mapping[str, str]:
    """Load diagnostic roles only after all candidate selection has finished."""

    result: dict[str, str] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            value = json.loads(line)
            role = value.get("role")
            if not isinstance(role, dict) or not isinstance(role.get("primary"), str):
                raise FamilyGeneralizationError("val33 diagnostic role is absent")
            result[str(value["sample_id"])] = str(role["primary"])
    if len(result) != 33:
        raise FamilyGeneralizationError("val33 diagnostic role count drifted")
    return result


def deterministic_calibration_mask(
    sample_ids: np.ndarray,
    train_mask: np.ndarray,
    *,
    modulus: int = 5,
) -> np.ndarray:
    """Reserve a stable 1/modulus train-only calibration fold."""

    if modulus < 3:
        raise FamilyGeneralizationError("calibration modulus must be at least 3")
    result = np.zeros(len(sample_ids), dtype=np.bool_)
    for index in np.flatnonzero(train_mask):
        digest = hashlib.sha256(str(sample_ids[index]).encode("utf-8")).digest()
        result[index] = int.from_bytes(digest[:4], "big") % modulus == 0
    return result


def work_class_weights(
    *,
    mask: np.ndarray,
    labels: np.ndarray,
    work_ids: np.ndarray,
    authorities: np.ndarray,
    confidence: np.ndarray,
    authority_multipliers: Mapping[str, float],
) -> np.ndarray:
    """Give every present work x family cell equal total optimizer mass."""

    arrays = (labels, work_ids, authorities, confidence)
    if any(len(value) != len(mask) for value in arrays):
        raise FamilyGeneralizationError("weight input lengths drifted")
    if not mask.any():
        raise FamilyGeneralizationError("weight mask is empty")
    base = confidence.astype(np.float64, copy=True)
    for authority in np.unique(authorities[mask]).tolist():
        multiplier = authority_multipliers.get(str(authority))
        if multiplier is None or not math.isfinite(multiplier) or multiplier <= 0:
            raise FamilyGeneralizationError(
                f"missing positive multiplier for authority {authority}"
            )
        base[authorities == authority] *= float(multiplier)
    result = np.zeros(len(mask), dtype=np.float64)
    cell_count = 0
    for work_id in sorted(set(str(value) for value in work_ids[mask])):
        for family in (BODY, VARIANT):
            cell = mask & (work_ids.astype(str) == work_id) & (labels == family)
            if not cell.any():
                continue
            total = float(base[cell].sum())
            if not math.isfinite(total) or total <= 0:
                raise FamilyGeneralizationError("work/family cell has invalid mass")
            result[cell] = base[cell] / total
            cell_count += 1
    if cell_count < 2 or not np.isfinite(result).all():
        raise FamilyGeneralizationError("work/family balancing failed")
    result *= float(mask.sum()) / float(result[mask].sum())
    return result.astype(np.float32)


def query_features(arrays: Mapping[str, np.ndarray], kind: str) -> np.ndarray:
    views = arrays["query_views"].astype(np.float32, copy=False)
    if views.ndim != 4 or tuple(views.shape[1:]) != (3, 4, 256):
        raise FamilyGeneralizationError("query_views shape drifted")
    normalized = views / np.clip(
        np.linalg.norm(views, axis=-1, keepdims=True), 1e-6, None
    )
    mean = normalized.mean(axis=1)
    if kind == "query_mean":
        return np.ascontiguousarray(mean.reshape(len(mean), -1), dtype=np.float32)
    if kind == "query_stats":
        std = normalized.std(axis=1)
        return np.ascontiguousarray(
            np.concatenate((mean.reshape(len(mean), -1), std.reshape(len(std), -1)), axis=1),
            dtype=np.float32,
        )
    raise FamilyGeneralizationError(f"unknown query feature kind: {kind}")


def _hidden_cache_indices(cache_root: Path, sample_ids: Sequence[str]) -> np.ndarray:
    wanted = set(str(value) for value in sample_ids)
    found: dict[str, int] = {}
    with (cache_root / "sample-index.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            value = json.loads(line)
            sample_id = value.get("sample_id")
            if sample_id in wanted:
                found[str(sample_id)] = int(value["cache_index"])
    missing = wanted - found.keys()
    if missing:
        raise FamilyGeneralizationError(
            f"hidden cache lacks {len(missing)} dataset identities"
        )
    return np.asarray([found[str(value)] for value in sample_ids], dtype=np.int64)


def extract_patch_stats(
    *,
    cache_root: Path,
    sample_ids: Sequence[str],
    device_name: str,
    batch_size: int,
) -> np.ndarray:
    """Pool raw SigLIP2 patch tokens into per-view mean and std features."""

    import torch

    if batch_size < 1 or batch_size > 64:
        raise FamilyGeneralizationError("patch batch size must be 1..64")
    manifest = _json(cache_root / "manifest.json")
    descriptors = manifest.get("shards")
    if not isinstance(descriptors, list) or not descriptors:
        raise FamilyGeneralizationError("hidden-cache shard inventory is absent")
    indices = _hidden_cache_indices(cache_root, sample_ids)
    ordered = sorted((int(value), offset) for offset, value in enumerate(indices))
    output = np.empty((len(indices), 3 * 2 * 768), dtype=np.float16)
    pointer = 0
    device = torch.device(device_name)
    with torch.inference_mode():
        for descriptor in descriptors:
            if not isinstance(descriptor, dict):
                raise FamilyGeneralizationError("hidden-cache descriptor drifted")
            start = int(descriptor["start_cache_index"])
            stop = int(descriptor["end_cache_index_exclusive"])
            selected: list[tuple[int, int]] = []
            while pointer < len(ordered) and ordered[pointer][0] < stop:
                cache_index, output_index = ordered[pointer]
                if cache_index < start:
                    raise FamilyGeneralizationError("cache indices are not covered")
                selected.append((cache_index - start, output_index))
                pointer += 1
            if not selected:
                continue
            path = (
                cache_root
                / "shards"
                / str(descriptor["directory"])
                / "hidden-states.f16.npy"
            )
            values = np.load(path, mmap_mode="r", allow_pickle=False)
            try:
                local = [value[0] for value in selected]
                targets = [value[1] for value in selected]
                for offset in range(0, len(local), batch_size):
                    local_batch = local[offset : offset + batch_size]
                    target_batch = targets[offset : offset + batch_size]
                    tokens = torch.from_numpy(
                        np.array(values[local_batch], dtype=np.float16, copy=True)
                    ).to(device=device)
                    normalized = torch.nn.functional.layer_norm(
                        tokens.float(), (tokens.shape[-1],)
                    )
                    pooled = torch.cat(
                        (
                            normalized.mean(dim=2),
                            normalized.std(dim=2, unbiased=False),
                        ),
                        dim=-1,
                    ).reshape(len(local_batch), -1)
                    output[target_batch] = pooled.cpu().numpy().astype(np.float16)
            finally:
                mapped = getattr(values, "_mmap", None)
                if mapped is not None:
                    mapped.close()
    if pointer != len(ordered) or not np.isfinite(output).all():
        raise FamilyGeneralizationError("patch feature extraction was incomplete")
    return output.astype(np.float32)


def build_head(torch: Any, *, input_dim: int, hidden_dim: int) -> Any:
    if input_dim < 2 or hidden_dim < 0:
        raise FamilyGeneralizationError("invalid family-head dimensions")
    if hidden_dim == 0:
        return torch.nn.Sequential(
            torch.nn.LayerNorm(input_dim),
            torch.nn.Linear(input_dim, 2),
        )
    return torch.nn.Sequential(
        torch.nn.LayerNorm(input_dim),
        torch.nn.Linear(input_dim, hidden_dim),
        torch.nn.GELU(),
        torch.nn.Dropout(0.1),
        torch.nn.Linear(hidden_dim, 2),
    )


def apply_logit_calibration(logits: np.ndarray, temperature: float, bias: float) -> np.ndarray:
    if logits.ndim != 2 or logits.shape[1] != 2:
        raise FamilyGeneralizationError("calibration logits must have shape [N,2]")
    if not math.isfinite(temperature) or temperature <= 0 or not math.isfinite(bias):
        raise FamilyGeneralizationError("invalid calibration parameters")
    difference = (logits[:, VARIANT] - logits[:, BODY]) / float(temperature) + float(bias)
    return np.stack((-0.5 * difference, 0.5 * difference), axis=1).astype(np.float32)


def fit_logit_calibration(
    logits: np.ndarray,
    labels: np.ndarray,
    weights: np.ndarray,
) -> tuple[float, float, float]:
    """Fit temperature and intercept on a train-only held-out fold."""

    import torch

    if len(logits) < 8 or set(labels.tolist()) != {BODY, VARIANT}:
        raise FamilyGeneralizationError("calibration fold needs both families")
    difference = torch.from_numpy(
        (logits[:, VARIANT] - logits[:, BODY]).astype(np.float64)
    )
    targets = torch.from_numpy(labels.astype(np.float64))
    row_weights = torch.from_numpy(weights.astype(np.float64))
    row_weights = row_weights / row_weights.sum()
    log_temperature = torch.zeros((), dtype=torch.float64, requires_grad=True)
    bias = torch.zeros((), dtype=torch.float64, requires_grad=True)
    optimizer = torch.optim.LBFGS(
        (log_temperature, bias), lr=0.5, max_iter=80, line_search_fn="strong_wolfe"
    )

    def closure() -> Any:
        optimizer.zero_grad(set_to_none=True)
        temperature = log_temperature.exp().clamp(0.05, 20.0)
        calibrated = difference / temperature + bias
        losses = torch.nn.functional.binary_cross_entropy_with_logits(
            calibrated, targets, reduction="none"
        )
        loss = (losses * row_weights).sum()
        loss.backward()
        return loss

    final_loss = float(optimizer.step(closure).detach())
    temperature = float(log_temperature.exp().clamp(0.05, 20.0).detach())
    return temperature, float(bias.detach()), final_loss


def expected_calibration_error(logits: np.ndarray, labels: np.ndarray) -> float:
    shifted = logits - logits.max(axis=1, keepdims=True)
    probabilities = np.exp(shifted)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    predictions = probabilities.argmax(axis=1)
    confidence = probabilities.max(axis=1)
    correct = predictions == labels
    result = 0.0
    for lower in np.linspace(0.0, 0.9, 10):
        selected = (confidence >= lower) & (confidence < lower + 0.1)
        if selected.any():
            result += float(selected.mean()) * abs(
                float(correct[selected].mean()) - float(confidence[selected].mean())
            )
    return result


def family_metrics(
    logits: np.ndarray,
    labels: np.ndarray,
    mask: np.ndarray,
    *,
    work_ids: np.ndarray | None = None,
) -> Mapping[str, Any]:
    if not mask.any():
        raise FamilyGeneralizationError("family metric mask is empty")
    predictions = logits.argmax(axis=1)[mask]
    truth = labels[mask]
    recalls: list[float] = []
    confusion = np.zeros((2, 2), dtype=np.int64)
    for actual in (BODY, VARIANT):
        actual_mask = truth == actual
        if actual_mask.any():
            recalls.append(float((predictions[actual_mask] == actual).mean()))
        for predicted in (BODY, VARIANT):
            confusion[actual, predicted] = int(
                (actual_mask & (predictions == predicted)).sum()
            )
    result: dict[str, Any] = {
        "accuracy": float((predictions == truth).mean()),
        "balanced_accuracy": float(np.mean(recalls)),
        "body_recall": float((predictions[truth == BODY] == BODY).mean())
        if (truth == BODY).any()
        else None,
        "confusion_actual_by_predicted": confusion.tolist(),
        "ece_10bin": expected_calibration_error(logits[mask], truth),
        "predicted_body_rate": float((predictions == BODY).mean()),
        "rows": int(mask.sum()),
        "variant_recall": float((predictions[truth == VARIANT] == VARIANT).mean())
        if (truth == VARIANT).any()
        else None,
    }
    if work_ids is not None:
        work_scores: list[float] = []
        per_work: dict[str, Any] = {}
        for work_id in sorted(set(str(value) for value in work_ids[mask])):
            work_mask = mask & (work_ids.astype(str) == work_id)
            sub = family_metrics(logits, labels, work_mask)
            per_work[work_id] = sub
            work_scores.append(float(sub["balanced_accuracy"]))
        result["macro_work_balanced_accuracy"] = float(np.mean(work_scores))
        result["per_work"] = per_work
    return result


def selection_score(slices: Mapping[str, Mapping[str, Any]]) -> float:
    """Score only non-val33 r3 authority slices."""

    return (
        0.40 * float(slices["human"]["balanced_accuracy"])
        + 0.25 * float(slices["visual"]["balanced_accuracy"])
        + 0.20 * float(slices["all"]["balanced_accuracy"])
        + 0.15 * float(slices["all"]["macro_work_balanced_accuracy"])
    )


def dataset_imbalance_audit(arrays: Mapping[str, np.ndarray]) -> Mapping[str, Any]:
    labels = arrays["family_labels"].astype(np.int64)
    split = arrays["split"].astype(np.int64)
    authorities = arrays["font_authority"].astype(str)
    works = arrays["work_ids"].astype(str)
    result: dict[str, Any] = {}
    for split_value, split_name in ((0, "train"), (1, "val")):
        split_mask = split == split_value
        by_work: dict[str, Any] = {}
        for work_id in sorted(set(works[split_mask])):
            work_mask = split_mask & (works == work_id)
            by_work[work_id] = {
                "body": int((work_mask & (labels == BODY)).sum()),
                "rows": int(work_mask.sum()),
                "variant": int((work_mask & (labels == VARIANT)).sum()),
            }
        by_authority = {
            authority: {
                "body": int(
                    (split_mask & (authorities == authority) & (labels == BODY)).sum()
                ),
                "rows": int((split_mask & (authorities == authority)).sum()),
                "variant": int(
                    (
                        split_mask
                        & (authorities == authority)
                        & (labels == VARIANT)
                    ).sum()
                ),
            }
            for authority in ("none", "visual", "human")
        }
        result[split_name] = {
            "by_authority": by_authority,
            "by_work": by_work,
            "body": int((split_mask & (labels == BODY)).sum()),
            "rows": int(split_mask.sum()),
            "variant": int((split_mask & (labels == VARIANT)).sum()),
            "work_count": len(by_work),
        }
    result["label_provenance_warning"] = {
        "human": "completed human role label",
        "none": "R5 source-category representative; not human role authority",
        "visual": (
            "visual authority applies to the font judgment; its family remains "
            "the R5 source-category representative unless a human role overrides it"
        ),
    }
    return result


def _candidate_selection_slices(
    logits: np.ndarray,
    arrays: Mapping[str, np.ndarray],
    selection_mask: np.ndarray,
) -> Mapping[str, Mapping[str, Any]]:
    labels = arrays["family_labels"].astype(np.int64, copy=False)
    authorities = arrays["font_authority"].astype(str)
    works = arrays["work_ids"].astype(str)
    return {
        "all": family_metrics(
            logits, labels, selection_mask, work_ids=works
        ),
        "human": family_metrics(
            logits, labels, selection_mask & (authorities == "human")
        ),
        "visual": family_metrics(
            logits, labels, selection_mask & (authorities == "visual")
        ),
    }


def _load_r3h_outputs(
    *,
    arrays: Mapping[str, np.ndarray],
    adapter_dir: Path,
    device_name: str,
    batch_size: int,
) -> tuple[Mapping[str, np.ndarray], Mapping[str, Any]]:
    import torch
    from safetensors.torch import load_file

    manifest = _json(adapter_dir / v8.MANIFEST_FILE)
    architecture = manifest.get("architecture")
    if not isinstance(architecture, dict):
        raise FamilyGeneralizationError("r3h architecture is absent")
    model = v8.build_role_family_adapter(
        torch,
        candidate_count=len(arrays["candidate_ids"]),
        maximum_family_bias=float(architecture["maximum_family_bias"]),
        candidate_residual_hidden_dim=int(architecture["candidate_residual_hidden_dim"]),
        maximum_sample_residual=float(architecture["maximum_sample_residual"]),
    )
    model.load_state_dict(
        load_file(str(adapter_dir / v8.CHECKPOINT_FILE), device="cpu"), strict=True
    )
    device = torch.device(device_name)
    model.requires_grad_(False).eval().to(device)
    prototypes = torch.from_numpy(
        arrays["prototype_queries"].astype(np.float32)
    ).to(device)
    names = ("body_candidate_scores", "variant_candidate_scores", "family_logits")
    collected: dict[str, list[np.ndarray]] = {name: [] for name in names}
    with torch.inference_mode():
        for start in range(0, len(arrays["query_views"]), batch_size):
            queries = torch.from_numpy(
                arrays["query_views"][start : start + batch_size].astype(np.float32)
            ).to(device)
            outputs = model(queries, prototypes)
            for name in names:
                collected[name].append(outputs[name].float().cpu().numpy())
    return (
        {name: np.concatenate(values) for name, values in collected.items()},
        manifest,
    )


def _route_metrics(
    *,
    arrays: Mapping[str, np.ndarray],
    frozen_outputs: Mapping[str, np.ndarray],
    family_logits: np.ndarray,
    mask: np.ndarray,
    device_name: str,
) -> Mapping[str, Any]:
    import torch

    positions = np.flatnonzero(mask)
    device = torch.device(device_name)
    candidate_ids = arrays["candidate_ids"].astype(str).tolist()
    single_day_index = candidate_ids.index("single-day")
    indices = torch.from_numpy(positions.astype(np.int64)).to(device)
    with torch.inference_mode():
        return v8.compute_metrics(
            torch,
            {
                "body_candidate_scores": torch.from_numpy(
                    frozen_outputs["body_candidate_scores"]
                ).to(device)[indices],
                "variant_candidate_scores": torch.from_numpy(
                    frozen_outputs["variant_candidate_scores"]
                ).to(device)[indices],
                "family_logits": torch.from_numpy(family_logits).to(device)[indices],
            },
            family_labels=torch.from_numpy(
                arrays["family_labels"][positions].astype(np.int64)
            ).to(device),
            positive_mask=torch.from_numpy(arrays["positive_mask"][positions]).to(device),
            preferred_mask=torch.from_numpy(arrays["preferred_mask"][positions]).to(device),
            font_supervision_weights=torch.from_numpy(
                arrays["font_supervision_weights"][positions].astype(np.float32)
            ).to(device),
            single_day_body_negative=torch.from_numpy(
                arrays["single_day_body_negative"][positions]
            ).to(device),
            single_day_index=single_day_index,
            candidate_ids=candidate_ids,
        )


def _probabilities(logits: np.ndarray) -> np.ndarray:
    shifted = logits.astype(np.float64) - logits.max(axis=1, keepdims=True)
    result = np.exp(shifted)
    result /= result.sum(axis=1, keepdims=True)
    return result.astype(np.float32)


def _search_safe_probability_hybrid(
    *,
    arrays: Mapping[str, np.ndarray],
    frozen_outputs: Mapping[str, np.ndarray],
    baseline_logits: np.ndarray,
    candidate_logits: np.ndarray,
    selection_mask: np.ndarray,
    baseline_route: Mapping[str, Any],
    device_name: str,
) -> tuple[np.ndarray, Mapping[str, Any]]:
    """Blend on non-val33 authority only, under font-route safety floors."""

    baseline_probabilities = _probabilities(baseline_logits)
    candidate_probabilities = _probabilities(candidate_logits)
    best: tuple[tuple[Any, ...], np.ndarray, Mapping[str, Any]] | None = None
    for alpha in np.linspace(0.0, 1.0, 21):
        probabilities = (
            (1.0 - float(alpha)) * baseline_probabilities
            + float(alpha) * candidate_probabilities
        )
        logits = np.log(np.clip(probabilities, 1e-8, None)).astype(np.float32)
        slices = _candidate_selection_slices(logits, arrays, selection_mask)
        route = _route_metrics(
            arrays=arrays,
            frozen_outputs=frozen_outputs,
            family_logits=logits,
            mask=selection_mask,
            device_name=device_name,
        )
        checks = {
            "acceptable_drop_at_most_0_02": float(route["acceptable_at1"])
            >= float(baseline_route["acceptable_at1"]) - 0.02,
            "all_family_balanced_accuracy_at_least_0_90": float(
                slices["all"]["balanced_accuracy"]
            )
            >= 0.90,
            "preferred_drop_at_most_0_02": float(route["preferred_at1"])
            >= float(baseline_route["preferred_at1"]) - 0.02,
            "single_day_all_rows_rate_at_most_0_01": float(
                route["single_day_eligibility"]["eligible_top1_all_rows_rate"]
            )
            <= 0.01,
            "single_day_body_false_rate_at_most_0_0025": float(
                route["single_day_body_false_top1_rate"]
            )
            <= 0.0025,
            "visual_family_balanced_accuracy_at_least_0_90": float(
                slices["visual"]["balanced_accuracy"]
            )
            >= 0.90,
        }
        hybrid_score = (
            0.45 * float(slices["human"]["balanced_accuracy"])
            + 0.20 * float(slices["visual"]["balanced_accuracy"])
            + 0.10 * float(slices["all"]["balanced_accuracy"])
            + 0.15 * float(route["acceptable_at1"])
            + 0.10 * float(route["preferred_at1"])
        )
        safe = all(checks.values())
        key = (
            safe,
            hybrid_score,
            float(slices["human"]["balanced_accuracy"]),
            selection_score(slices),
            -float(alpha),
        )
        report = {
            "alpha_candidate_probability": float(alpha),
            "alpha_r3h_probability": 1.0 - float(alpha),
            "checks": checks,
            "hybrid_score": hybrid_score,
            "passed": safe,
            "route": route,
            "selection_score": selection_score(slices),
            "selection_slices": slices,
        }
        if best is None or key > best[0]:
            best = (key, logits, report)
    if best is None:  # pragma: no cover - alpha=0 is always evaluated
        raise FamilyGeneralizationError("hybrid search produced no result")
    return best[1], best[2]


def _train_candidate(
    *,
    spec: CandidateSpec,
    features: np.ndarray,
    arrays: Mapping[str, np.ndarray],
    val33_ids: frozenset[str],
    device_name: str,
    epochs: int,
    epoch_samples: int,
    seeds: Sequence[int],
    batch_size: int,
) -> tuple[Mapping[str, Any], Mapping[str, Any], np.ndarray]:
    import torch

    labels = arrays["family_labels"].astype(np.int64)
    split = arrays["split"].astype(np.int64)
    authorities = arrays["font_authority"].astype(str)
    works = arrays["work_ids"].astype(str)
    sample_ids = arrays["sample_ids"].astype(str)
    train_scope = (split == 0) & np.isin(authorities, spec.authority_scope)
    calibration = deterministic_calibration_mask(sample_ids, train_scope)
    optimizer_mask = train_scope & ~calibration
    selection_mask = (split == 1) & ~np.isin(sample_ids, tuple(val33_ids))
    optimizer_weights = work_class_weights(
        mask=optimizer_mask,
        labels=labels,
        work_ids=works,
        authorities=authorities,
        confidence=arrays["family_label_weights"],
        authority_multipliers=spec.authority_multipliers,
    )
    calibration_weights = work_class_weights(
        mask=calibration,
        labels=labels,
        work_ids=works,
        authorities=authorities,
        confidence=arrays["family_label_weights"],
        authority_multipliers=spec.authority_multipliers,
    )
    device = torch.device(device_name)
    feature_tensor = torch.from_numpy(features.astype(np.float32)).to(device)
    label_tensor = torch.from_numpy(labels).to(device)
    probabilities = torch.from_numpy(optimizer_weights).to(device)
    probabilities /= probabilities.sum()
    best: tuple[float, int, Mapping[str, Any], float, float, np.ndarray, Mapping[str, Any]] | None = None
    seed_reports: list[Mapping[str, Any]] = []
    for seed in seeds:
        torch.manual_seed(int(seed))
        np.random.seed(int(seed))
        model = build_head(
            torch, input_dim=features.shape[1], hidden_dim=spec.hidden_dim
        ).to(device)
        optimizer = torch.optim.AdamW(
            model.parameters(), lr=5e-4, weight_decay=1e-3
        )
        generator = torch.Generator(device=device)
        generator.manual_seed(int(seed) ^ 0x51A7)
        losses: list[float] = []
        model.train()
        for _epoch in range(epochs):
            sampled = torch.multinomial(
                probabilities,
                num_samples=max(epoch_samples, int(optimizer_mask.sum())),
                replacement=True,
                generator=generator,
            )
            for start in range(0, len(sampled), batch_size):
                positions = sampled[start : start + batch_size]
                optimizer.zero_grad(set_to_none=True)
                logits = model(feature_tensor[positions])
                loss = torch.nn.functional.cross_entropy(
                    logits, label_tensor[positions], label_smoothing=0.05
                )
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                optimizer.step()
                losses.append(float(loss.detach().cpu()))
        model.eval()
        with torch.inference_mode():
            raw_logits = model(feature_tensor).float().cpu().numpy()
        temperature, bias, calibration_loss = fit_logit_calibration(
            raw_logits[calibration],
            labels[calibration],
            calibration_weights[calibration],
        )
        logits = apply_logit_calibration(raw_logits, temperature, bias)
        slices = _candidate_selection_slices(logits, arrays, selection_mask)
        score = selection_score(slices)
        seed_report = {
            "calibration": {
                "bias": bias,
                "loss": calibration_loss,
                "temperature": temperature,
            },
            "mean_optimizer_loss": float(np.mean(losses)),
            "seed": int(seed),
            "selection_score": score,
            "selection_slices": slices,
        }
        seed_reports.append(seed_report)
        state = {
            name: value.detach().cpu().clone()
            for name, value in model.state_dict().items()
        }
        key = (score, int(seed), state, temperature, bias, logits, seed_report)
        if best is None or key[:2] > best[:2]:
            best = key
    if best is None:
        raise FamilyGeneralizationError("candidate training produced no result")
    _score, _seed, state, temperature, bias, logits, selected_report = best
    report = {
        "architecture": {
            "feature_kind": spec.feature_kind,
            "hidden_dim": spec.hidden_dim,
            "input_dim": int(features.shape[1]),
            "pixel_only": True,
            "text_font_name_gemma_input": False,
        },
        "authority_multipliers": dict(spec.authority_multipliers),
        "authority_scope": list(spec.authority_scope),
        "boundaries": {
            "calibration_source": "deterministic_train_only_heldout_fold",
            "optimizer_uses_val33": False,
            "selection_uses_val33": False,
            "val33_diagnostic_loaded_after_selection": True,
            "work_class_balanced_sampling": True,
        },
        "counts": {
            "calibration_rows": int(calibration.sum()),
            "optimizer_rows": int(optimizer_mask.sum()),
            "selection_rows_excluding_val33": int(selection_mask.sum()),
        },
        "name": spec.name,
        "seed_trials": seed_reports,
        "selected": selected_report,
        "selected_calibration": {"temperature": temperature, "bias": bias},
    }
    return state, report, logits


def _prefix_state(name: str, state: Mapping[str, Any]) -> Mapping[str, Any]:
    return {f"{name}.{key}": value for key, value in state.items()}


def run(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    dataset_path = args.dataset_npz.expanduser().resolve()
    with np.load(dataset_path, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    v8.validate_training_arrays(arrays, candidate_count=len(arrays["candidate_ids"]))
    if len(arrays["split"]) != 23882 or int((arrays["split"] == 1).sum()) != 9033:
        raise FamilyGeneralizationError("expected sealed r3 body-holdout dataset")
    val33_path = args.val33_finals.expanduser().resolve()
    val33_ids = frozenset(load_val33_identities(val33_path))
    sample_ids = arrays["sample_ids"].astype(str)
    if int(np.isin(sample_ids, tuple(val33_ids)).sum()) != 33:
        raise FamilyGeneralizationError("val33 identities are not all in r3")
    split = arrays["split"].astype(np.int64)
    val33_mask = np.isin(sample_ids, tuple(val33_ids))
    if np.any(split[val33_mask] != 1):
        raise FamilyGeneralizationError("val33 escaped validation split")
    selection_mask = (split == 1) & ~val33_mask

    frozen_outputs, r3h_manifest = _load_r3h_outputs(
        arrays=arrays,
        adapter_dir=args.r3h_adapter.expanduser().resolve(),
        device_name=args.device,
        batch_size=args.batch_size,
    )
    query_mean = query_features(arrays, "query_mean")
    query_stats = query_features(arrays, "query_stats")
    patch_stats: np.ndarray | None = None
    checkpoints: dict[str, Any] = {}
    candidate_reports: dict[str, Any] = {}
    candidate_logits: dict[str, np.ndarray] = {}
    for spec in CANDIDATE_SPECS:
        if spec.feature_kind == "query_mean":
            features = query_mean
        elif spec.feature_kind == "query_stats":
            features = query_stats
        elif spec.feature_kind == "patch_stats":
            if args.skip_patch:
                continue
            if patch_stats is None:
                patch_stats = extract_patch_stats(
                    cache_root=args.hidden_cache.expanduser().resolve(),
                    sample_ids=sample_ids.tolist(),
                    device_name=args.device,
                    batch_size=args.patch_batch_size,
                )
            features = patch_stats
        else:  # pragma: no cover - sealed static specs
            raise FamilyGeneralizationError("candidate feature kind drifted")
        state, report, logits = _train_candidate(
            spec=spec,
            features=features,
            arrays=arrays,
            val33_ids=val33_ids,
            device_name=args.device,
            epochs=args.epochs,
            epoch_samples=args.epoch_samples,
            seeds=args.seed,
            batch_size=args.batch_size,
        )
        checkpoints.update(_prefix_state(spec.name, state))
        candidate_reports[spec.name] = report
        candidate_logits[spec.name] = logits

    labels = arrays["family_labels"].astype(np.int64)
    authorities = arrays["font_authority"].astype(str)
    works = arrays["work_ids"].astype(str)
    baseline_logits = frozen_outputs["family_logits"]
    baseline_slices = _candidate_selection_slices(
        baseline_logits, arrays, selection_mask
    )
    baseline_report = {
        "selection_score": selection_score(baseline_slices),
        "selection_slices": baseline_slices,
        "route": _route_metrics(
            arrays=arrays,
            frozen_outputs=frozen_outputs,
            family_logits=baseline_logits,
            mask=selection_mask,
            device_name=args.device,
        ),
        "val33_repeated_diagnostic_only": family_metrics(
            baseline_logits, labels, val33_mask
        ),
    }
    hybrid_reports: dict[str, Any] = {}
    hybrid_logits: dict[str, np.ndarray] = {}
    for name, logits in candidate_logits.items():
        blended, hybrid = _search_safe_probability_hybrid(
            arrays=arrays,
            frozen_outputs=frozen_outputs,
            baseline_logits=baseline_logits,
            candidate_logits=logits,
            selection_mask=selection_mask,
            baseline_route=baseline_report["route"],
            device_name=args.device,
        )
        hybrid_reports[name] = dict(hybrid)
        hybrid_logits[name] = blended

    # Candidate, seed, blend, and checkpoint selection is complete above.  Only
    # now may repeated val33 roles be deserialised for diagnostic reporting.
    val33_roles = load_val33_roles(val33_path)
    for name, logits in candidate_logits.items():
        report = candidate_reports[name]
        report["route"] = {
            "r3_selection_9000": _route_metrics(
                arrays=arrays,
                frozen_outputs=frozen_outputs,
                family_logits=logits,
                mask=selection_mask,
                device_name=args.device,
            ),
            "r3_selection_human_46": _route_metrics(
                arrays=arrays,
                frozen_outputs=frozen_outputs,
                family_logits=logits,
                mask=selection_mask & (authorities == "human"),
                device_name=args.device,
            ),
            "r3_selection_visual_1047": _route_metrics(
                arrays=arrays,
                frozen_outputs=frozen_outputs,
                family_logits=logits,
                mask=selection_mask & (authorities == "visual"),
                device_name=args.device,
            ),
            "val33_repeated_diagnostic_only": _route_metrics(
                arrays=arrays,
                frozen_outputs=frozen_outputs,
                family_logits=logits,
                mask=val33_mask,
                device_name=args.device,
            ),
        }
        gold_metrics = dict(family_metrics(logits, labels, val33_mask))
        gold_predictions = logits.argmax(axis=1)
        dialogue_ids = tuple(
            sample_id
            for sample_id, role in val33_roles.items()
            if role == "dialogue"
        )
        dialogue_mask = np.isin(sample_ids, dialogue_ids)
        gold_metrics["dialogue_body_correct"] = int(
            (gold_predictions[dialogue_mask] == BODY).sum()
        )
        gold_metrics["dialogue_rows"] = int(dialogue_mask.sum())
        gold_metrics["status"] = "repeated_diagnostic_only_never_selection"
        report["val33_repeated_diagnostic_only"] = gold_metrics

    for name, logits in hybrid_logits.items():
        gold_metrics = dict(family_metrics(logits, labels, val33_mask))
        gold_predictions = logits.argmax(axis=1)
        dialogue_ids = tuple(
            sample_id
            for sample_id, role in val33_roles.items()
            if role == "dialogue"
        )
        dialogue_mask = np.isin(sample_ids, dialogue_ids)
        gold_metrics["dialogue_body_correct"] = int(
            (gold_predictions[dialogue_mask] == BODY).sum()
        )
        gold_metrics["dialogue_rows"] = int(dialogue_mask.sum())
        gold_metrics["status"] = "repeated_diagnostic_only_never_selection"
        hybrid_reports[name]["val33_repeated_diagnostic_only"] = gold_metrics
        hybrid_reports[name]["val33_route_repeated_diagnostic_only"] = _route_metrics(
            arrays=arrays,
            frozen_outputs=frozen_outputs,
            family_logits=logits,
            mask=val33_mask,
            device_name=args.device,
        )

    # Choose the QA candidate on non-val33 scores only, then apply a strict
    # no-regression gate to prevent an attractive human slice hiding a route
    # quality collapse.
    ordered = sorted(
        candidate_reports,
        key=lambda name: float(candidate_reports[name]["selected"]["selection_score"]),
        reverse=True,
    )
    hybrid_order = sorted(
        hybrid_reports,
        key=lambda name: (
            bool(hybrid_reports[name]["passed"]),
            float(hybrid_reports[name]["hybrid_score"]),
        ),
        reverse=True,
    )
    qa_candidate = hybrid_order[0]
    qa_route = hybrid_reports[qa_candidate]["route"]
    baseline_route = baseline_report["route"]
    route_safety_checks = {
        "acceptable_drop_at_most_0_02": float(qa_route["acceptable_at1"])
        >= float(baseline_route["acceptable_at1"]) - 0.02,
        "preferred_drop_at_most_0_02": float(qa_route["preferred_at1"])
        >= float(baseline_route["preferred_at1"]) - 0.02,
        "single_day_all_rows_rate_at_most_0_01": float(
            qa_route["single_day_eligibility"]["eligible_top1_all_rows_rate"]
        )
        <= 0.01,
        "single_day_body_false_rate_at_most_0_0025": float(
            qa_route["single_day_body_false_top1_rate"]
        )
        <= 0.0025,
    }
    output = args.output_dir.expanduser().resolve()
    if output.exists():
        raise FamilyGeneralizationError("refusing to replace existing output")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        from safetensors.torch import save_file

        checkpoint_path = staging / CHECKPOINT_FILE
        save_file(checkpoints, str(checkpoint_path))
        report = {
            "baseline_r3h": baseline_report,
            "boundaries": {
                "automatic_runtime_promotion": False,
                "candidate_checkpoint_or_gradient_uses_val33": False,
                "candidate_selection_uses_val33": False,
                "diagnostic_val33_rows": 33,
                "font_score_branches": "frozen_r3h",
                "gemma_text_font_name_input": False,
                "independent_release_authority": False,
                "r3_validation_status": "adapter_model_selection_only",
            },
            "candidate_order_by_non_val33_selection": ordered,
            "candidates": candidate_reports,
            "checkpoint": {
                "file": CHECKPOINT_FILE,
                "sha256": _sha256(checkpoint_path),
            },
            "dataset": {
                "file": str(dataset_path),
                "sha256": _sha256(dataset_path),
                "train_rows": int((split == 0).sum()),
                "selection_rows_excluding_val33": int(selection_mask.sum()),
                "work_overlap": len(set(works[split == 0]) & set(works[split == 1])),
            },
            "elapsed_seconds": time.perf_counter() - started,
            "hybrid_order_by_non_val33_selection": hybrid_order,
            "hybrids": hybrid_reports,
            "data_imbalance_audit": dataset_imbalance_audit(arrays),
            "findings": {
                "qa_hybrid_acceptable_delta_from_r3h": float(
                    qa_route["acceptable_at1"]
                )
                - float(baseline_route["acceptable_at1"]),
                "qa_hybrid_human_balanced_accuracy_delta_from_r3h": float(
                    hybrid_reports[qa_candidate]["selection_slices"]["human"][
                        "balanced_accuracy"
                    ]
                )
                - float(
                    baseline_report["selection_slices"]["human"][
                        "balanced_accuracy"
                    ]
                ),
                "qa_hybrid_val33_dialogue_body_correct": int(
                    hybrid_reports[qa_candidate][
                        "val33_repeated_diagnostic_only"
                    ]["dialogue_body_correct"]
                ),
                "qa_hybrid_val33_dialogue_rows": int(
                    hybrid_reports[qa_candidate][
                        "val33_repeated_diagnostic_only"
                    ]["dialogue_rows"]
                ),
            },
            "promotion_decision": {
                "automatic_runtime_promotion": False,
                "blocked_by": [
                    "r3 validation is adapter-selection authority, not independent release authority",
                    "repeated val33 remains diagnostic-only and cannot rescue candidate selection",
                    "the selected safe hybrid still misses all five val33 dialogue rows",
                    "40-page full-pipeline QA is still required",
                ],
                "passed": False,
            },
            "route_safety_gate": {
                "checks": route_safety_checks,
                "passed": all(route_safety_checks.values()),
                "policy": "diagnostic_only_even_when_passed_requires_40_page_QA",
            },
            "qa_candidate_selected_without_val33": {
                "candidate": qa_candidate,
                "candidate_probability": hybrid_reports[qa_candidate][
                    "alpha_candidate_probability"
                ],
                "r3h_probability": hybrid_reports[qa_candidate][
                    "alpha_r3h_probability"
                ],
                "strategy": "probability_blend",
            },
            "record_type": "manga_font_v2_family_generalization_experiment_report",
            "schema_version": SCHEMA_VERSION,
            "sources": {
                "hidden_cache_manifest_sha256": _sha256(
                    args.hidden_cache.expanduser().resolve() / "manifest.json"
                )
                if not args.skip_patch
                else None,
                "r3h_checkpoint_sha256": _sha256(
                    args.r3h_adapter.expanduser().resolve() / v8.CHECKPOINT_FILE
                ),
                "r3h_manifest_record_sha256": r3h_manifest.get("record_sha256"),
                "val33_finals_sha256": _sha256(val33_path),
            },
        }
        canonical = json.dumps(
            report, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        report["record_sha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        (staging / REPORT_FILE).write_text(
            json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        (staging / MARKER_FILE).write_text(
            json.dumps(
                {"owner": OWNER, "safe_replace": False, "schema_version": SCHEMA_VERSION},
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        staging.replace(output)
        return report
    except BaseException:
        import shutil

        shutil.rmtree(staging, ignore_errors=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset-npz",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout/role-family-dataset.npz"
        ),
    )
    parser.add_argument(
        "--r3h-adapter",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v81-role-family-adapter-production-r3h"
        ),
    )
    parser.add_argument(
        "--hidden-cache",
        type=Path,
        default=Path("artifacts/manga-font-master-v3-siglip2-hidden-cache-v1"),
    )
    parser.add_argument(
        "--val33-finals",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-calibration-gold-val33-v1/finals-calibration-val.jsonl"
        ),
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=18)
    parser.add_argument("--epoch-samples", type=int, default=8192)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--patch-batch-size", type=int, default=24)
    parser.add_argument("--seed", type=int, action="append", default=None)
    parser.add_argument("--skip-patch", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.seed is None:
        args.seed = [27181, 27182, 27183]
    if args.epochs < 1 or args.epochs > 100:
        parser.error("--epochs must be 1..100")
    if args.epoch_samples < 256 or args.epoch_samples > 100000:
        parser.error("--epoch-samples must be 256..100000")
    if args.batch_size < 16 or args.batch_size > 4096:
        parser.error("--batch-size must be 16..4096")
    try:
        report = run(args)
    except (FamilyGeneralizationError, OSError, RuntimeError, ValueError) as error:
        parser.error(str(error))
    print(
        json.dumps(
            {
                "elapsed_seconds": report["elapsed_seconds"],
                "output_dir": str(args.output_dir.expanduser().resolve()),
                "promotion_decision": report["promotion_decision"],
                "qa_candidate_selected_without_val33": report[
                    "qa_candidate_selected_without_val33"
                ],
                "record_sha256": report["record_sha256"],
                "route_safety_gate": report["route_safety_gate"],
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
