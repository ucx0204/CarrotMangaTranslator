"""Train the bounded R2.5 page-context font consistency gate.

This is an isolated, non-production experiment.  It reuses the frozen R2.3
weak-negative candidate-head LOGO outputs, learns whether a same-page dialogue
group can safely share evidence, then evaluates the frozen choice once on the
existing three development-only works.  It never reads or runs manga pages.
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
from collections import defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
except ImportError:  # pragma: no cover
    import train_manga_font_v3_candidate_tristate_r23_logo as r23


SCHEMA_VERSION = "manga-font-v3-page-context-gate-r25-v1"
OWNER = "carrot-manga-translator/manga-font-v3-page-context-gate-r25-v1"
RECORD_TYPE = "manga_font_v3_page_context_gate_r25_manifest"
MANIFEST_FILE = "manifest.json"
GATE_FILE = "page-context-gate.json"
SIDECAR_FILE = "candidate-final-r25.safetensors"
MARKER_FILE = ".manga-font-v3-page-context-gate-r25-v1-owned.json"
PRODUCER_FILE = "train_manga_font_v3_page_context_gate_r25.py"

R23_CONTROL_DIR = Path(
    "artifacts/manga-font-v3-candidate-tristate-r23-logo-"
    "marginal-weak-negative-0-25-seed20260820-v1"
)
R23_CONTROL_MANIFEST_SHA256 = (
    "9799da2eaedfbe9babf88f417714e212afeb34ee4dd190299273b895dc54e772"
)
R23_CONTROL_RECORD_SHA256 = (
    "47b0d9840ee34ed9e41c146987836f2435b339d7a89e9f58c220de68f064f6e6"
)
R23_ENGINE_SHA256 = "cdf41457975b93ac0ddb54d24b022b163a38ad3af4d07e5cf5e8806fcc713166"
R23_ENGINE_BYTES = 149_967

FULL_REFIT_EPOCHS = 4
GATE_ALPHA = 0.65
GATE_THRESHOLD = 0.6
RF_DEPTH = 2
RF_ESTIMATORS = 300
RF_MIN_LEAF = 2
RF_RANDOM_STATE = 19
SEED = 20_260_820

FEATURE_NAMES = (
    "group_size",
    "top1_consensus",
    "unique_top1_fraction",
    "mean_winner_probability",
    "minimum_winner_probability",
    "winner_top3_fraction",
    "mean_winner_rank_fraction",
    "mean_top1_probability",
    "minimum_top1_probability",
    "mean_top1_margin",
    "minimum_top1_margin",
    "mean_normalized_entropy",
    "mean_js_divergence",
    "mean_candidate_score_std",
)


class R25TrainingError(ValueError):
    pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _seal(value: Mapping[str, Any]) -> dict[str, Any]:
    core = dict(value)
    core["record_sha256"] = hashlib.sha256(_canonical(core).encode("utf-8")).hexdigest()
    return core


def _descriptor(path: Path) -> Mapping[str, Any]:
    resolved = path.expanduser().absolute().resolve()
    if not resolved.is_file() or path.is_symlink():
        raise R25TrainingError(f"required regular file is missing: {path}")
    return {
        "byte_size": int(resolved.stat().st_size),
        "file_name": resolved.name,
        "sha256": _sha256_file(resolved),
    }


def _producer() -> Mapping[str, Any]:
    current = _descriptor(Path(__file__))
    engine = _descriptor(Path(r23.__file__))
    if (
        engine["file_name"] != "train_manga_font_v3_candidate_tristate_r23_logo.py"
        or engine["byte_size"] != R23_ENGINE_BYTES
        or engine["sha256"] != R23_ENGINE_SHA256
    ):
        raise R25TrainingError("frozen R2.3 engine drifted")
    return {"r23_engine": engine, "r25_producer": current}


def _r23_args(*, device: str = "cpu") -> argparse.Namespace:
    parser = r23.build_parser()
    return parser.parse_args(
        [
            "preflight",
            "--marginal-mode",
            "marginal_weak_negative_0_25",
            "--device",
            device,
        ]
    )


def _load_control(torch: Any, root: Path) -> Mapping[str, Any]:
    resolved = root.expanduser().absolute().resolve()
    validation = r23.validate_output(resolved)
    manifest_path = resolved / r23.MANIFEST_FILE
    if _sha256_file(manifest_path) != R23_CONTROL_MANIFEST_SHA256:
        raise R25TrainingError("R2.3 weak control manifest drifted")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("record_sha256") != R23_CONTROL_RECORD_SHA256:
        raise R25TrainingError("R2.3 weak control record drifted")
    if validation.get("manifest_record_sha256") != R23_CONTROL_RECORD_SHA256:
        raise R25TrainingError("R2.3 weak control strict validation drifted")
    states = []
    folds = []
    for fold in manifest["folds"]:
        index = int(fold["partition"]["fold_index"])
        states.append(
            r23._load_sidecar_state(torch, resolved / r23._sidecar_name(index))
        )
        folds.append(fold)
    return {
        "directory": str(resolved),
        "manifest": manifest,
        "manifest_sha256": R23_CONTROL_MANIFEST_SHA256,
        "record_sha256": R23_CONTROL_RECORD_SHA256,
        "states": tuple(states),
        "folds": tuple(folds),
    }


def _softmax(scores: np.ndarray) -> np.ndarray:
    shifted = scores.astype(np.float64) - np.max(scores, axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=1, keepdims=True)


def _group_features(scores: np.ndarray) -> np.ndarray:
    if scores.ndim != 2 or scores.shape[0] < 2:
        raise R25TrainingError("page-context group score shape drifted")
    probabilities = _softmax(scores)
    count, candidate_count = probabilities.shape
    top_order = np.argsort(-probabilities, axis=1, kind="stable")
    top1 = top_order[:, 0]
    counts = np.bincount(top1, minlength=candidate_count)
    winner = int(np.argmax(np.mean(scores, axis=0)))
    ranks = np.empty_like(top_order)
    ranks[np.arange(count)[:, None], top_order] = np.arange(candidate_count)[None, :]
    top_values = np.take_along_axis(probabilities, top_order[:, :2], axis=1)
    entropy = -np.sum(
        probabilities * np.log(np.clip(probabilities, 1e-12, 1.0)), axis=1
    )
    entropy /= math.log(candidate_count)
    mean_probability = np.mean(probabilities, axis=0)
    js = np.mean(
        np.sum(
            probabilities
            * (
                np.log(np.clip(probabilities, 1e-12, 1.0))
                - np.log(np.clip(mean_probability[None, :], 1e-12, 1.0))
            ),
            axis=1,
        )
    )
    winner_probability = probabilities[:, winner]
    result = np.asarray(
        [
            float(count),
            float(np.max(counts) / count),
            float(np.count_nonzero(counts) / count),
            float(np.mean(winner_probability)),
            float(np.min(winner_probability)),
            float(np.mean(ranks[:, winner] < 3)),
            float(np.mean(ranks[:, winner]) / max(1, candidate_count - 1)),
            float(np.mean(top_values[:, 0])),
            float(np.min(top_values[:, 0])),
            float(np.mean(top_values[:, 0] - top_values[:, 1])),
            float(np.min(top_values[:, 0] - top_values[:, 1])),
            float(np.mean(entropy)),
            float(js),
            float(np.mean(np.std(scores.astype(np.float64), axis=0))),
        ],
        dtype=np.float64,
    )
    if len(result) != len(FEATURE_NAMES) or not np.isfinite(result).all():
        raise R25TrainingError("page-context feature vector drifted")
    return result


def _row_outcomes(
    rows: Sequence[Mapping[str, Any]], top1: np.ndarray
) -> Mapping[str, int]:
    safe = preferred = unacceptable = 0
    for row, candidate in zip(rows, top1.tolist(), strict=True):
        safe += int(bool(np.asarray(row["safe_mask"], dtype=np.bool_)[candidate]))
        preferred += int(
            bool(np.asarray(row["preferred_mask"], dtype=np.bool_)[candidate])
        )
        unacceptable += int(
            bool(np.asarray(row["unacceptable_mask"], dtype=np.bool_)[candidate])
        )
    return {"preferred": preferred, "safe": safe, "unacceptable": unacceptable}


def _group_record(
    scores: np.ndarray,
    group: Mapping[str, Any],
    row_by_index: Mapping[int, Mapping[str, Any]],
) -> Mapping[str, Any]:
    rows = tuple(row_by_index[int(index)] for index in group["row_indices"])
    local_top1 = np.argmax(scores, axis=1)
    shared_top1 = np.full(len(rows), int(np.argmax(np.mean(scores, axis=0))))
    local = _row_outcomes(rows, local_top1)
    shared = _row_outcomes(rows, shared_top1)
    target = (
        shared["safe"] >= local["safe"]
        and shared["preferred"] >= local["preferred"]
        and shared["unacceptable"] <= local["unacceptable"]
    )
    return {
        "features": _group_features(scores),
        "group": group,
        "local_outcomes": local,
        "row_indices": np.asarray(group["row_indices"], dtype=np.int64),
        "rows": rows,
        "shared_safe_target": bool(target),
        "shared_outcomes": shared,
        "work_id": str(group["work_id"]),
    }


def _scores_for_group(
    torch: Any,
    model: Any,
    cache: Mapping[str, Any],
    group: Mapping[str, Any],
    row_by_index: Mapping[int, Mapping[str, Any]],
) -> np.ndarray:
    indices = np.asarray(group["row_indices"], dtype=np.int64)
    outputs = r23.candidate_outputs_from_cache(torch, model, cache, indices)
    labels = torch.as_tensor(
        [row_by_index[int(index)]["family_label"] for index in indices],
        dtype=torch.long,
        device=cache["hidden"].device,
    )
    return r23._routed_scores(outputs, labels).detach().cpu().numpy().astype(np.float64)


def _build_oof_records(
    torch: Any,
    *,
    context: Mapping[str, Any],
    ledger: Mapping[str, Any],
    cache: Mapping[str, Any],
    folds: Sequence[Mapping[str, Any]],
    control: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...]:
    row_by_index = {int(row["row_index"]): row for row in ledger["train"]}
    records = []
    for fold, state in zip(folds, control["states"], strict=True):
        model = r23.build_candidate_model(context, cache["hidden"].device)
        r23._apply_sidecar_state(model, state)
        for group in fold["heldout_page_groups"]:
            scores = _scores_for_group(torch, model, cache, group, row_by_index)
            records.append(_group_record(scores, group, row_by_index))
    if len(records) != 68 or len({id(record["group"]) for record in records}) != 68:
        raise R25TrainingError("OOF page-context group inventory drifted")
    return tuple(records)


def _rf_model(*, max_depth: int = RF_DEPTH, min_samples_leaf: int = RF_MIN_LEAF) -> Any:
    from sklearn.ensemble import RandomForestClassifier

    return RandomForestClassifier(
        n_estimators=RF_ESTIMATORS,
        max_depth=max_depth,
        min_samples_leaf=min_samples_leaf,
        class_weight="balanced",
        random_state=RF_RANDOM_STATE,
        n_jobs=1,
    )


def _predict_positive(model: Any, features: np.ndarray) -> np.ndarray:
    classes = list(model.classes_)
    if True not in classes and 1 not in classes:
        return np.zeros(len(features), dtype=np.float64)
    positive_index = classes.index(True) if True in classes else classes.index(1)
    return model.predict_proba(features)[:, positive_index]


def _apply_gate(
    scores: np.ndarray, enabled: bool, *, alpha: float = GATE_ALPHA
) -> np.ndarray:
    if not enabled:
        return scores
    mean = np.mean(scores, axis=0, keepdims=True)
    return (1.0 - alpha) * scores + alpha * mean


def _evaluate_group_records(
    records: Sequence[Mapping[str, Any]],
    enabled: Sequence[bool],
    *,
    alpha: float = GATE_ALPHA,
) -> Mapping[str, Any]:
    if len(records) != len(enabled):
        raise R25TrainingError("gate evaluation length drifted")
    by_work: dict[str, list[Mapping[str, float]]] = defaultdict(list)
    group_deltas = []
    applied = 0
    for record, use_gate in zip(records, enabled, strict=True):
        scores = np.asarray(record["scores"], dtype=np.float64)
        rows = record["rows"]
        group = record["group"]
        local_top1 = np.argmax(scores, axis=1)
        blended = _apply_gate(scores, bool(use_gate), alpha=alpha)
        selected_top1 = np.argmax(blended, axis=1)
        local = _row_outcomes(rows, local_top1)
        selected = _row_outcomes(rows, selected_top1)
        common = np.asarray(group["common_positive_mask"], dtype=np.bool_)
        local_agree = float(np.all(local_top1 == local_top1[0]))
        selected_agree = float(np.all(selected_top1 == selected_top1[0]))
        local_common = float(np.all(common[local_top1]))
        selected_common = float(np.all(common[selected_top1]))
        count = len(rows)
        values = {
            "safe": (selected["safe"] - local["safe"]) / count,
            "preferred": (selected["preferred"] - local["preferred"]) / count,
            "unacceptable": (selected["unacceptable"] - local["unacceptable"]) / count,
            "top1_all_agree": selected_agree - local_agree,
            "top1_in_common": selected_common - local_common,
        }
        by_work[str(record["work_id"])].append(values)
        group_deltas.append(values)
        applied += int(bool(use_gate))
    work_values: dict[str, Mapping[str, float]] = {}
    for work_id, values in sorted(by_work.items()):
        work_values[work_id] = {
            key: float(np.mean([value[key] for value in values])) for key in values[0]
        }
    macro = {
        key: float(np.mean([value[key] for value in work_values.values()]))
        for key in next(iter(work_values.values()))
    }
    worst_safe = min(value["safe"] for value in work_values.values())
    return {
        "applied_group_count": applied,
        "group_count": len(records),
        "work_count": len(work_values),
        "work_macro_delta": macro,
        "worst_work_safe_delta": float(worst_safe),
        "per_work_delta": work_values,
    }


def _cross_validated_gate(
    records: Sequence[Mapping[str, Any]],
    *,
    max_depth: int = RF_DEPTH,
    min_samples_leaf: int = RF_MIN_LEAF,
    threshold: float = GATE_THRESHOLD,
    alpha: float = GATE_ALPHA,
) -> Mapping[str, Any]:
    features = np.stack([record["features"] for record in records])
    targets = np.asarray(
        [record["shared_safe_target"] for record in records], dtype=np.bool_
    )
    works = np.asarray([record["work_id"] for record in records]).astype(str)
    probabilities = np.zeros(len(records), dtype=np.float64)
    for heldout in sorted(set(works.tolist())):
        train = works != heldout
        test = ~train
        model = _rf_model(max_depth=max_depth, min_samples_leaf=min_samples_leaf).fit(
            features[train], targets[train]
        )
        probabilities[test] = _predict_positive(model, features[test])
    enabled = probabilities >= threshold
    prepared = tuple({**record, "scores": record["scores"]} for record in records)
    metrics = _evaluate_group_records(prepared, enabled.tolist(), alpha=alpha)
    return {
        "enabled": enabled,
        "metrics": metrics,
        "probabilities": probabilities,
        "targets": targets,
    }


def _serialize_rf(model: Any) -> Mapping[str, Any]:
    trees = []
    for estimator in model.estimators_:
        tree = estimator.tree_
        trees.append(
            {
                "children_left": tree.children_left.astype(int).tolist(),
                "children_right": tree.children_right.astype(int).tolist(),
                "feature": tree.feature.astype(int).tolist(),
                "threshold": tree.threshold.astype(float).tolist(),
                "value": tree.value[:, 0, :].astype(float).tolist(),
            }
        )
    return {
        "classes": [bool(value) for value in model.classes_.tolist()],
        "feature_names": list(FEATURE_NAMES),
        "forest": {
            "class_weight": "balanced",
            "max_depth": RF_DEPTH,
            "min_samples_leaf": RF_MIN_LEAF,
            "n_estimators": RF_ESTIMATORS,
            "random_state": RF_RANDOM_STATE,
            "trees": trees,
        },
        "gate_alpha": GATE_ALPHA,
        "gate_threshold": GATE_THRESHOLD,
        "schema_version": SCHEMA_VERSION,
    }


def _predict_serialized_rf(
    payload: Mapping[str, Any], features: np.ndarray
) -> np.ndarray:
    classes = list(payload["classes"])
    positive_index = classes.index(True)
    probabilities = np.zeros(len(features), dtype=np.float64)
    trees = payload["forest"]["trees"]
    for tree in trees:
        left = tree["children_left"]
        right = tree["children_right"]
        selected_feature = tree["feature"]
        thresholds = tree["threshold"]
        values = tree["value"]
        for row_index, row in enumerate(features):
            node = 0
            while int(left[node]) != int(right[node]):
                feature_index = int(selected_feature[node])
                node = (
                    int(left[node])
                    if float(row[feature_index]) <= float(thresholds[node])
                    else int(right[node])
                )
            counts = np.asarray(values[node], dtype=np.float64)
            probabilities[row_index] += float(
                counts[positive_index] / max(float(np.sum(counts)), 1e-12)
            )
    return probabilities / len(trees)


def _full_fold(
    context: Mapping[str, Any], ledger: Mapping[str, Any]
) -> Mapping[str, Any]:
    arrays = context["arrays"]
    development_works = tuple(
        str(value) for value in context["overlay_binding"]["development_eval_work_ids"]
    )
    all_base = r23.r0._base_train_indices(arrays, development_works)
    train_rows = tuple(ledger["train"])
    direct_indices = {int(row["row_index"]) for row in train_rows}
    base_indices = np.asarray(
        [index for index in all_base.tolist() if int(index) not in direct_indices],
        dtype=np.int64,
    )
    page_groups = r23._discriminative_groups(context["groups"]["train"])
    if (len(all_base), len(train_rows), len(base_indices), len(page_groups)) != (
        12_923,
        1_042,
        11_881,
        68,
    ):
        raise R25TrainingError("full-data refit partition drifted")
    return {
        "base_indices": base_indices,
        "heldout_work_id": "r25_full_10_work_refit",
        "train_page_groups": page_groups,
        "train_rows": train_rows,
    }


def _full_direct_step(
    torch: Any,
    model: Any,
    optimizer: Any,
    *,
    cache: Mapping[str, Any],
    fold: Mapping[str, Any],
    args: argparse.Namespace,
    epoch: int,
) -> Mapping[str, Any]:
    rows = tuple(fold["train_rows"])
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    works = np.asarray([row["work_id"] for row in rows]).astype(str)
    labels = np.asarray([row["family_label"] for row in rows], dtype=np.int64)
    weights = np.asarray([row["supervision_weight"] for row in rows], dtype=np.float32)
    seed = r23._schedule_seed(
        seed=int(args.seed),
        heldout_work_id=str(fold["heldout_work_id"]),
        epoch=int(epoch),
        phase="direct",
    )
    batches, normalized, source = r23.r1._direct_balanced_schedule(
        indices,
        works,
        labels,
        weights,
        balance_mode="work_family",
        batch_size=int(args.batch_size),
        seed=seed,
    )
    order = np.concatenate(batches).astype(np.int64, copy=False)
    strata = sorted(set(zip(works.tolist(), labels.tolist(), strict=True)))
    if len(strata) != 20 or sorted(order.tolist()) != list(range(len(rows))):
        raise R25TrainingError("full-data direct schedule drifted")
    ordered_rows = tuple(rows[int(position)] for position in order.tolist())
    ordered_indices = np.asarray(
        [row["row_index"] for row in ordered_rows], dtype=np.int64
    )
    outputs = r23.candidate_outputs_from_cache(torch, model, cache, ordered_indices)
    tensors = r23._tier_tensors(torch, ordered_rows, device=cache["hidden"].device)
    row_weights = torch.as_tensor(
        normalized[order], dtype=torch.float32, device=cache["hidden"].device
    )
    routed = r23._routed_scores(outputs, tensors["family_labels"])
    candidate_loss, parts = r23.weighted_candidate_set_loss(
        torch,
        routed,
        preferred_mask=tensors["preferred_mask"],
        safe_mask=tensors["safe_mask"],
        marginal_mask=tensors["marginal_mask"],
        unacceptable_mask=tensors["unacceptable_mask"],
        single_day_safety_negative=tensors["single_day_safety_negative"],
        marginal_weight=r23.MARGINAL_MODES[args.marginal_mode],
        row_weights=row_weights,
    )
    safety = r23._single_day_safety_losses(
        torch,
        outputs,
        safe_mask=tensors["safe_mask"],
        family_labels=tensors["family_labels"],
        safety_negative=tensors["single_day_safety_negative"],
        row_weights=row_weights,
        single_day_index=tuple(cache["candidate_ids"]).index("single-day"),
    )
    residual_l2 = outputs["sample_candidate_residual_delta"].float().square().mean()
    total = (
        float(args.direct_candidate_weight) * candidate_loss
        + r23.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT * safety["body_hard_negative"]
        + r23.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
        * safety["supervised_hard_negative"]
        + float(args.direct_residual_l2_weight) * residual_l2
    )
    if not bool(torch.isfinite(total)):
        raise R25TrainingError("full-data direct loss became non-finite")
    optimizer.zero_grad(set_to_none=True)
    total.backward()
    torch.nn.utils.clip_grad_norm_(
        tuple(value for value in model.parameters() if value.requires_grad),
        float(args.gradient_clip),
    )
    optimizer.step()
    return {
        "candidate_core": float(candidate_loss.detach().item()),
        "preferred_set_nll": float(parts["preferred_set_nll"].detach().item()),
        "safe_set_nll": float(parts["safe_set_nll"].detach().item()),
        "schedule_seed": int(seed),
        "strata": int(source["stratum_count"]),
        "total": float(total.detach().item()),
    }


def _train_full_candidate_head(
    torch: Any,
    *,
    prepared: Mapping[str, Any],
    device: Any,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    context = prepared["context"]
    args = prepared["args"]
    evaluation_cache = prepared["cache"]
    cache = r23.transfer_candidate_cache(torch, cache=evaluation_cache, device=device)
    fold = _full_fold(context, prepared["ledger"])
    model = r23.build_candidate_model(context, device)
    r23.assert_epoch0_exact(torch, model, cache)
    optimizer = torch.optim.AdamW(
        [value for value in model.parameters() if value.requires_grad],
        lr=float(args.learning_rate),
        weight_decay=float(args.weight_decay),
    )
    history = []
    for epoch in range(1, FULL_REFIT_EPOCHS + 1):
        direct = _full_direct_step(
            torch,
            model,
            optimizer,
            cache=cache,
            fold=fold,
            args=args,
            epoch=epoch,
        )
        base = r23._base_step(
            torch,
            model,
            optimizer,
            cache=cache,
            fold=fold,
            args=args,
            epoch=epoch,
        )
        history.append({"base": base["loss"], "direct": direct, "epoch": epoch})
    return r23._sidecar_state(model), {
        "epoch_policy": "fixed_median_of_precommitted_r23_logo_selected_epochs",
        "epochs": FULL_REFIT_EPOCHS,
        "history": history,
        "training_work_count": 10,
    }


def _absolute_group_metrics(
    records: Sequence[Mapping[str, Any]], enabled: Sequence[bool]
) -> Mapping[str, Any]:
    by_work: dict[str, list[Mapping[str, float]]] = defaultdict(list)
    for record, use_gate in zip(records, enabled, strict=True):
        scores = _apply_gate(
            np.asarray(record["scores"], dtype=np.float64), bool(use_gate)
        )
        top1 = np.argmax(scores, axis=1)
        outcomes = _row_outcomes(record["rows"], top1)
        common = np.asarray(record["group"]["common_positive_mask"], dtype=np.bool_)
        count = len(top1)
        by_work[str(record["work_id"])].append(
            {
                "preferred": outcomes["preferred"] / count,
                "safe": outcomes["safe"] / count,
                "top1_all_agree": float(np.all(top1 == top1[0])),
                "top1_in_common": float(np.all(common[top1])),
                "unacceptable": outcomes["unacceptable"] / count,
            }
        )
    per_work = {
        work_id: {
            key: float(np.mean([value[key] for value in values])) for key in values[0]
        }
        for work_id, values in sorted(by_work.items())
    }
    macro = {
        key: float(np.mean([value[key] for value in per_work.values()]))
        for key in next(iter(per_work.values()))
    }
    return {"per_work": per_work, "work_macro": macro}


def _metric_delta(
    candidate: Mapping[str, Any], anchor: Mapping[str, Any]
) -> Mapping[str, float]:
    return {
        key: float(candidate["work_macro"][key] - anchor["work_macro"][key])
        for key in anchor["work_macro"]
    }


def _attach_scores(
    torch: Any,
    *,
    model: Any,
    cache: Mapping[str, Any],
    groups: Sequence[Mapping[str, Any]],
    rows: Sequence[Mapping[str, Any]],
) -> tuple[Mapping[str, Any], ...]:
    row_by_index = {int(row["row_index"]): row for row in rows}
    result = []
    for group in groups:
        scores = _scores_for_group(torch, model, cache, group, row_by_index)
        result.append({**_group_record(scores, group, row_by_index), "scores": scores})
    return tuple(result)


def _prepare(device: str) -> Mapping[str, Any]:
    import torch

    args = _r23_args(device=device)
    context = r23._load_context(args, torch)
    ledger = r23.reconstruct_tier_ledger(
        args.source_label_dir, context, enforce_real=True
    )
    folds = r23.build_logo_folds(context, ledger, enforce_real=True)
    cache = r23.build_candidate_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(args.evaluation_batch_size),
    )
    control = _load_control(torch, R23_CONTROL_DIR)
    row_by_index = {int(row["row_index"]): row for row in ledger["train"]}
    oof = []
    for fold, state in zip(folds, control["states"], strict=True):
        model = r23.build_candidate_model(context, torch.device("cpu"))
        r23._apply_sidecar_state(model, state)
        for group in fold["heldout_page_groups"]:
            scores = _scores_for_group(torch, model, cache, group, row_by_index)
            oof.append({**_group_record(scores, group, row_by_index), "scores": scores})
    if len(oof) != 68:
        raise R25TrainingError("OOF group count drifted")
    return {
        "args": args,
        "cache": cache,
        "context": context,
        "control": control,
        "folds": folds,
        "ledger": ledger,
        "oof_records": tuple(oof),
    }


def preflight(args: argparse.Namespace) -> Mapping[str, Any]:
    prepared = _prepare(args.device)
    cv = _cross_validated_gate(prepared["oof_records"])
    return {
        "continuation_candidate": bool(
            cv["metrics"]["work_macro_delta"]["safe"] >= 0.0
            and cv["metrics"]["work_macro_delta"]["preferred"] >= 0.0
            and cv["metrics"]["work_macro_delta"]["top1_all_agree"] > 0.0
            and cv["metrics"]["worst_work_safe_delta"] >= -0.05
        ),
        "feature_count": len(FEATURE_NAMES),
        "oof_gate_metrics": cv["metrics"],
        "oof_group_count": len(prepared["oof_records"]),
        "positive_target_count": int(cv["targets"].sum()),
        "producer": _producer(),
        "status": "ready_for_r25_frozen_page_context_gate",
    }


def _validate_seal(value: Mapping[str, Any], name: str) -> None:
    if not isinstance(value.get("record_sha256"), str):
        raise R25TrainingError(f"{name} seal is missing")
    core = dict(value)
    actual = core.pop("record_sha256")
    expected = hashlib.sha256(_canonical(core).encode("utf-8")).hexdigest()
    if actual != expected:
        raise R25TrainingError(f"{name} seal drifted")


def _safe_output(path: Path) -> Path:
    absolute = path.expanduser().absolute()
    if path.is_symlink() or absolute.exists():
        raise R25TrainingError(f"output must not already exist: {path}")
    return absolute


def train(args: argparse.Namespace) -> Mapping[str, Any]:
    import torch
    from safetensors.torch import save_file

    if int(args.seed) != SEED:
        raise R25TrainingError("R2.5 permits only the frozen seed 20260820")
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise R25TrainingError("CUDA was requested but is unavailable")
    output = _safe_output(args.output_dir)
    producer = _producer()
    started = time.monotonic()
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(SEED)
    prepared = _prepare(args.device)
    oof_records = prepared["oof_records"]
    cv = _cross_validated_gate(oof_records)
    cv_delta = cv["metrics"]["work_macro_delta"]
    if not (
        cv_delta["safe"] >= 0.0
        and cv_delta["preferred"] >= 0.0
        and cv_delta["top1_all_agree"] >= 0.05
        and cv["metrics"]["worst_work_safe_delta"] >= -0.05
    ):
        raise R25TrainingError(
            "frozen R2.5 OOF gate no longer meets its safety contract"
        )
    features = np.stack([record["features"] for record in oof_records])
    targets = np.asarray(
        [record["shared_safe_target"] for record in oof_records], dtype=np.bool_
    )
    gate = _rf_model().fit(features, targets)
    gate_payload = _serialize_rf(gate)
    sklearn_probabilities = _predict_positive(gate, features)
    serialized_probabilities = _predict_serialized_rf(gate_payload, features)
    if not np.allclose(
        sklearn_probabilities,
        serialized_probabilities,
        rtol=0.0,
        atol=1e-12,
    ):
        raise R25TrainingError("serialized page gate prediction drifted")

    final_state, refit = _train_full_candidate_head(
        torch, prepared=prepared, device=device
    )
    context = prepared["context"]
    cache = prepared["cache"]
    candidate_ids = tuple(context["candidate_ids"])
    candidate_model = r23.build_candidate_model(context, torch.device("cpu"))
    r23._apply_sidecar_state(candidate_model, final_state)
    anchor_model = r23.build_candidate_model(context, torch.device("cpu"))
    development_rows = tuple(prepared["ledger"]["development_eval"])
    development_groups = r23._discriminative_groups(
        context["groups"]["development_eval"]
    )
    if len(development_rows) != 305 or len(development_groups) != 23:
        raise R25TrainingError("development inventory drifted")
    candidate_records = _attach_scores(
        torch,
        model=candidate_model,
        cache=cache,
        groups=development_groups,
        rows=development_rows,
    )
    anchor_records = _attach_scores(
        torch,
        model=anchor_model,
        cache=cache,
        groups=development_groups,
        rows=development_rows,
    )
    development_features = np.stack(
        [record["features"] for record in candidate_records]
    )
    development_probabilities = _predict_positive(gate, development_features)
    development_enabled = development_probabilities >= GATE_THRESHOLD
    candidate_local = _absolute_group_metrics(
        candidate_records, np.zeros(len(candidate_records), dtype=np.bool_)
    )
    candidate_gated = _absolute_group_metrics(
        candidate_records, development_enabled.tolist()
    )
    anchor_local = _absolute_group_metrics(
        anchor_records, np.zeros(len(anchor_records), dtype=np.bool_)
    )
    anchor_probabilities = _predict_positive(
        gate, np.stack([record["features"] for record in anchor_records])
    )
    anchor_enabled = anchor_probabilities >= GATE_THRESHOLD
    anchor_gated = _absolute_group_metrics(anchor_records, anchor_enabled.tolist())
    gate_delta = _metric_delta(candidate_gated, candidate_local)
    combined_delta = _metric_delta(candidate_gated, anchor_local)
    anchor_gate_delta = _metric_delta(anchor_gated, anchor_local)
    gate_work_delta = _evaluate_group_records(
        candidate_records, development_enabled.tolist()
    )
    development_target = np.asarray(
        [record["shared_safe_target"] for record in candidate_records], dtype=np.bool_
    )
    predicted = development_enabled.astype(np.bool_)
    true_positive = int(np.sum(predicted & development_target))
    false_positive = int(np.sum(predicted & ~development_target))
    false_negative = int(np.sum(~predicted & development_target))
    candidate_whole = r23.candidate_metrics(
        torch,
        candidate_model,
        cache=cache,
        rows=development_rows,
        candidate_ids=candidate_ids,
    )
    anchor_whole = r23.candidate_metrics(
        torch,
        anchor_model,
        cache=cache,
        rows=development_rows,
        candidate_ids=candidate_ids,
    )
    development_passed = bool(
        gate_delta["safe"] >= 0.0
        and gate_delta["preferred"] >= 0.0
        and gate_delta["top1_all_agree"] >= 0.05
        and gate_delta["top1_in_common"] >= 0.0
        and gate_work_delta["worst_work_safe_delta"] >= -0.05
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        sidecar_path = staging / SIDECAR_FILE
        save_file(
            {
                name: value.detach().cpu().contiguous()
                for name, value in final_state.items()
            },
            str(sidecar_path),
        )
        gate_path = staging / GATE_FILE
        gate_path.write_text(
            json.dumps(gate_payload, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
        assets = {
            GATE_FILE: _descriptor(gate_path),
            SIDECAR_FILE: {
                **_descriptor(sidecar_path),
                "tensor_inventory": r23._tensor_inventory(final_state),
            },
        }
        manifest = _seal(
            {
                "assets": assets,
                "authority": {
                    "development_evaluation_authority": False,
                    "human_gold": False,
                    "nonpromotable": True,
                    "production_integration_authorized": False,
                    "training_only_ai_review_labels": True,
                },
                "candidate_head_refit": refit,
                "configuration": {
                    "alpha": GATE_ALPHA,
                    "candidate_refit_epochs": FULL_REFIT_EPOCHS,
                    "device": str(device),
                    "feature_names": list(FEATURE_NAMES),
                    "rf_depth": RF_DEPTH,
                    "rf_estimators": RF_ESTIMATORS,
                    "rf_min_samples_leaf": RF_MIN_LEAF,
                    "rf_random_state": RF_RANDOM_STATE,
                    "seed": SEED,
                    "threshold": GATE_THRESHOLD,
                },
                "development_once_only": {
                    "anchor_gate_delta": anchor_gate_delta,
                    "candidate_gate_delta": gate_delta,
                    "candidate_gate_vs_anchor_delta": combined_delta,
                    "candidate_local": candidate_local,
                    "candidate_whole_metrics": candidate_whole,
                    "false_negative_groups": false_negative,
                    "false_positive_groups": false_positive,
                    "gate_metrics": gate_work_delta,
                    "gate_positive_groups": int(np.sum(development_enabled)),
                    "group_count": len(candidate_records),
                    "passed_precommitted_page_gate": development_passed,
                    "target_positive_groups": int(np.sum(development_target)),
                    "true_positive_groups": true_positive,
                    "work_count": 3,
                    "anchor_whole_metrics": anchor_whole,
                },
                "oof_training_evidence": {
                    "gate_metrics": cv["metrics"],
                    "group_count": len(oof_records),
                    "safe_share_target_positive_count": int(np.sum(targets)),
                    "work_count": 10,
                },
                "producer": producer,
                "record_type": RECORD_TYPE,
                "runtime_boundary": {
                    "application_integration": False,
                    "candidate_projection_added_parameters": 0,
                    "cpu_benchmark_completed": False,
                    "estimated_tree_comparisons_upper_bound": (
                        RF_ESTIMATORS * RF_DEPTH
                    ),
                    "existing_candidate_projection_replaced_in_place": True,
                    "maximum_allowed_full_runtime_ratio": 1.5,
                    "page_gate_requires_existing_group_summary": True,
                },
                "schema_version": SCHEMA_VERSION,
                "source_control": {
                    "directory": prepared["control"]["directory"],
                    "manifest_record_sha256": R23_CONTROL_RECORD_SHA256,
                    "manifest_sha256": R23_CONTROL_MANIFEST_SHA256,
                },
                "status": (
                    "development_page_gate_passed"
                    if development_passed
                    else "development_page_gate_did_not_pass"
                ),
                "training_seconds": max(time.monotonic() - started, 1e-9),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        marker = _seal(
            {
                "artifacts": {
                    GATE_FILE: _sha256_file(gate_path),
                    MANIFEST_FILE: _sha256_file(manifest_path),
                    SIDECAR_FILE: _sha256_file(sidecar_path),
                },
                "owner": OWNER,
                "producer": producer,
                "safe_replace": False,
                "schema_version": SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_text(
            json.dumps(marker, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        validate_output(staging)
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(output)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    import torch

    root = output_dir.expanduser().absolute().resolve()
    if output_dir.is_symlink() or not root.is_dir():
        raise R25TrainingError("R2.5 output directory is missing or linked")
    expected = {GATE_FILE, MANIFEST_FILE, MARKER_FILE, SIDECAR_FILE}
    actual = {path.name for path in root.iterdir()}
    if actual != expected or any(path.is_symlink() for path in root.iterdir()):
        raise R25TrainingError("R2.5 output inventory drifted")
    manifest = json.loads((root / MANIFEST_FILE).read_text(encoding="utf-8"))
    marker = json.loads((root / MARKER_FILE).read_text(encoding="utf-8"))
    _validate_seal(manifest, "manifest")
    _validate_seal(marker, "marker")
    producer = _producer()
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type") != RECORD_TYPE
        or manifest.get("producer") != producer
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("producer") != producer
    ):
        raise R25TrainingError("R2.5 authority or producer drifted")
    expected_hashes = {
        GATE_FILE: _sha256_file(root / GATE_FILE),
        MANIFEST_FILE: _sha256_file(root / MANIFEST_FILE),
        SIDECAR_FILE: _sha256_file(root / SIDECAR_FILE),
    }
    if marker.get("artifacts") != expected_hashes:
        raise R25TrainingError("R2.5 marker artifact binding drifted")
    for name in (GATE_FILE, SIDECAR_FILE):
        descriptor = manifest["assets"][name]
        if descriptor["sha256"] != expected_hashes[name] or descriptor[
            "byte_size"
        ] != int((root / name).stat().st_size):
            raise R25TrainingError(f"R2.5 asset descriptor drifted: {name}")
    gate = json.loads((root / GATE_FILE).read_text(encoding="utf-8"))
    if (
        gate.get("schema_version") != SCHEMA_VERSION
        or gate.get("feature_names") != list(FEATURE_NAMES)
        or len(gate.get("forest", {}).get("trees", ())) != RF_ESTIMATORS
    ):
        raise R25TrainingError("R2.5 gate contract drifted")
    sidecar = r23._load_sidecar_state(torch, root / SIDECAR_FILE)
    if manifest["assets"][SIDECAR_FILE]["tensor_inventory"] != r23._tensor_inventory(
        sidecar
    ):
        raise R25TrainingError("R2.5 candidate sidecar inventory drifted")
    source = manifest.get("source_control", {})
    if (
        source.get("manifest_sha256") != R23_CONTROL_MANIFEST_SHA256
        or source.get("manifest_record_sha256") != R23_CONTROL_RECORD_SHA256
    ):
        raise R25TrainingError("R2.5 source control binding drifted")
    return {
        "development_page_gate_passed": bool(
            manifest["development_once_only"]["passed_precommitted_page_gate"]
        ),
        "development_results": manifest["development_once_only"],
        "manifest_record_sha256": manifest["record_sha256"],
        "manifest_sha256": expected_hashes[MANIFEST_FILE],
        "nonpromotable": True,
        "operation": "validate",
        "output_dir": str(root),
        "schema_version": SCHEMA_VERSION,
        "status": manifest["status"],
    }


def screen(args: argparse.Namespace) -> Mapping[str, Any]:
    prepared = _prepare("cpu")
    records = prepared["oof_records"]
    features = np.stack([record["features"] for record in records])
    targets = np.asarray(
        [record["shared_safe_target"] for record in records], dtype=np.bool_
    )
    works = np.asarray([record["work_id"] for record in records]).astype(str)
    rows = []
    for depth in (2, 3, 4, 5):
        for leaf in (2, 3, 4, 5, 6):
            probabilities = np.zeros(len(records), dtype=np.float64)
            for heldout in sorted(set(works.tolist())):
                train = works != heldout
                test = ~train
                model = _rf_model(max_depth=depth, min_samples_leaf=leaf).fit(
                    features[train], targets[train]
                )
                probabilities[test] = _predict_positive(model, features[test])
            for threshold in (0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8):
                for alpha in (0.25, 0.35, 0.5, 0.65, 0.75):
                    metrics = _evaluate_group_records(
                        records,
                        (probabilities >= threshold).tolist(),
                        alpha=alpha,
                    )
                    delta = metrics["work_macro_delta"]
                    if metrics["worst_work_safe_delta"] < -0.05 - 1e-12:
                        continue
                    if delta["safe"] < -1e-12 or delta["preferred"] < -1e-12:
                        continue
                    rows.append(
                        {
                            "alpha": alpha,
                            "applied": metrics["applied_group_count"],
                            "common_delta": delta["top1_in_common"],
                            "depth": depth,
                            "leaf": leaf,
                            "preferred_delta": delta["preferred"],
                            "safe_delta": delta["safe"],
                            "threshold": threshold,
                            "top1_agree_delta": delta["top1_all_agree"],
                            "worst_safe_delta": metrics["worst_work_safe_delta"],
                        }
                    )
    rows.sort(
        key=lambda row: (
            row["top1_agree_delta"],
            row["common_delta"],
            row["preferred_delta"],
            row["safe_delta"],
        ),
        reverse=True,
    )
    return {"eligible_count": len(rows), "status": "r25_screen", "top": rows[:30]}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight_parser = commands.add_parser("preflight")
    preflight_parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    commands.add_parser("screen")
    train_parser = commands.add_parser("train")
    train_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    train_parser.add_argument("--seed", type=int, default=SEED)
    train_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "preflight":
            result = preflight(args)
        elif args.command == "screen":
            result = screen(args)
        elif args.command == "train":
            result = train(args)
        elif args.command == "validate":
            result = validate_output(args.output_dir)
        else:  # pragma: no cover
            raise R25TrainingError("unsupported command")
    except (R25TrainingError, r23.R23TrainingError) as error:
        raise SystemExit(str(error)) from error
    print(_canonical(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
