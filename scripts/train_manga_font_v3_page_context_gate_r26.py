"""Screen a richer 13-work page-context font gate without running pages."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
    from scripts import train_manga_font_v3_page_context_gate_r25 as r25
except ImportError:  # pragma: no cover
    import train_manga_font_v3_candidate_tristate_r23_logo as r23
    import train_manga_font_v3_page_context_gate_r25 as r25


R25_SHA256 = "b5fca7867bbe2989399ee0df39dc72e8b36a65f6084ffa45b20dc1410ed6a36e"
R25_BYTES = 46_144
R25_ARTIFACT = Path("artifacts/manga-font-v3-page-context-gate-r25-seed20260820-v1")
R25_ARTIFACT_MANIFEST_SHA256 = (
    "01a82a86584f6fc033bae6a61d5ec538fb8894adc40080ea76b60ccd1cea492e"
)
STABLE_BODY_FONT_IDS = {
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "ridi-batang",
}


class R26TrainingError(ValueError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _assert_r25() -> Mapping[str, Any]:
    path = Path(r25.__file__).resolve()
    if path.stat().st_size != R25_BYTES or _sha256(path) != R25_SHA256:
        raise R26TrainingError("frozen R2.5 producer drifted")
    result = r25.validate_output(R25_ARTIFACT)
    if result["manifest_sha256"] != R25_ARTIFACT_MANIFEST_SHA256:
        raise R26TrainingError("frozen R2.5 artifact drifted")
    return result


def _extended_features(scores: np.ndarray) -> np.ndarray:
    base = r25._group_features(scores)
    probabilities = r25._softmax(scores)
    mean_scores = np.mean(scores, axis=0)
    score_scale = max(float(np.std(mean_scores)), 1e-6)
    normalized_mean_scores = (mean_scores - float(np.mean(mean_scores))) / score_scale
    mean_probabilities = np.mean(probabilities, axis=0)
    minimum_probabilities = np.min(probabilities, axis=0)
    top1 = np.argmax(probabilities, axis=1)
    winner = int(np.argmax(mean_scores))
    winner_one_hot = np.zeros(scores.shape[1], dtype=np.float64)
    winner_one_hot[winner] = 1.0
    top1_histogram = np.bincount(top1, minlength=scores.shape[1]).astype(np.float64)
    top1_histogram /= len(top1)
    return np.concatenate(
        (
            base,
            normalized_mean_scores,
            mean_probabilities,
            minimum_probabilities,
            winner_one_hot,
            top1_histogram,
        )
    )


def _action_target(record: Mapping[str, Any], alpha: float) -> bool:
    scores = np.asarray(record["scores"], dtype=np.float64)
    local = r25._row_outcomes(record["rows"], np.argmax(scores, axis=1))
    blended = r25._apply_gate(scores, True, alpha=alpha)
    selected = r25._row_outcomes(record["rows"], np.argmax(blended, axis=1))
    return bool(
        selected["safe"] >= local["safe"]
        and selected["preferred"] >= local["preferred"]
        and selected["unacceptable"] <= local["unacceptable"]
    )


def _records() -> tuple[Mapping[str, Any], ...]:
    import torch

    _assert_r25()
    prepared = r25._prepare("cpu")
    training = [
        {**record, "features_r26": _extended_features(record["scores"])}
        for record in prepared["oof_records"]
    ]
    state = r23._load_sidecar_state(torch, R25_ARTIFACT / r25.SIDECAR_FILE)
    model = r23.build_candidate_model(prepared["context"], torch.device("cpu"))
    r23._apply_sidecar_state(model, state)
    groups = r23._discriminative_groups(
        prepared["context"]["groups"]["development_eval"]
    )
    development = r25._attach_scores(
        torch,
        model=model,
        cache=prepared["cache"],
        groups=groups,
        rows=prepared["ledger"]["development_eval"],
    )
    combined = training + [
        {**record, "features_r26": _extended_features(record["scores"])}
        for record in development
    ]
    if len(combined) != 91 or len({record["work_id"] for record in combined}) != 13:
        raise R26TrainingError("R2.6 13-work group inventory drifted")
    return tuple(combined)


def _model(
    kind: str, depth: int, leaf: int, seed: int, *, estimators: int = 400
) -> Any:
    if kind == "rf":
        from sklearn.ensemble import RandomForestClassifier

        return RandomForestClassifier(
            n_estimators=estimators,
            max_depth=depth,
            min_samples_leaf=leaf,
            max_features="sqrt",
            class_weight="balanced",
            random_state=seed,
            n_jobs=-1,
        )
    if kind == "extra":
        from sklearn.ensemble import ExtraTreesClassifier

        return ExtraTreesClassifier(
            n_estimators=estimators,
            max_depth=depth,
            min_samples_leaf=leaf,
            max_features="sqrt",
            class_weight="balanced",
            random_state=seed,
            n_jobs=-1,
        )
    raise R26TrainingError("unknown model kind")


def _positive_probability(model: Any, features: np.ndarray) -> np.ndarray:
    classes = list(model.classes_)
    if True not in classes:
        return np.zeros(len(features), dtype=np.float64)
    return model.predict_proba(features)[:, classes.index(True)]


def _candidate_feature_matrix(scores: np.ndarray) -> np.ndarray:
    group = _extended_features(scores)
    probabilities = r25._softmax(scores)
    count, candidate_count = scores.shape
    order = np.argsort(-scores, axis=1, kind="stable")
    ranks = np.empty_like(order)
    ranks[np.arange(count)[:, None], order] = np.arange(candidate_count)[None, :]
    mean_scores = np.mean(scores, axis=0)
    scale = max(float(np.std(mean_scores)), 1e-6)
    rows = []
    for candidate in range(candidate_count):
        identity = np.zeros(candidate_count, dtype=np.float64)
        identity[candidate] = 1.0
        specific = np.asarray(
            [
                (mean_scores[candidate] - float(np.mean(mean_scores))) / scale,
                float(np.min(scores[:, candidate])),
                float(np.max(scores[:, candidate])),
                float(np.std(scores[:, candidate])),
                float(np.mean(probabilities[:, candidate])),
                float(np.min(probabilities[:, candidate])),
                float(np.max(probabilities[:, candidate])),
                float(np.mean(order[:, 0] == candidate)),
                float(np.mean(ranks[:, candidate] < 3)),
                float(np.mean(ranks[:, candidate]) / max(1, candidate_count - 1)),
                float(np.max(ranks[:, candidate]) / max(1, candidate_count - 1)),
            ],
            dtype=np.float64,
        )
        rows.append(np.concatenate((group, specific, identity)))
    return np.stack(rows)


def _candidate_training_rows(
    records: Sequence[Mapping[str, Any]], selected: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    features = []
    targets = []
    for record in np.asarray(records, dtype=object)[selected].tolist():
        candidate_features = _candidate_feature_matrix(record["scores"])
        reviewed = np.asarray(
            record["group"]["shared_reviewed_eligible_mask"], dtype=np.bool_
        )
        positive = np.asarray(record["group"]["common_positive_mask"], dtype=np.bool_)
        features.extend(candidate_features[reviewed])
        targets.extend(positive[reviewed].tolist())
    return np.asarray(features, dtype=np.float64), np.asarray(targets, dtype=np.bool_)


def _candidate_action(
    record: Mapping[str, Any],
    probabilities: np.ndarray,
    *,
    top_k: int,
    threshold: float,
) -> int | None:
    scores = np.asarray(record["scores"], dtype=np.float64)
    candidate_count = scores.shape[1]
    top = np.argsort(-scores, axis=1, kind="stable")[:, :top_k]
    eligible = np.ones(candidate_count, dtype=np.bool_)
    for row in top:
        mask = np.zeros(candidate_count, dtype=np.bool_)
        mask[row] = True
        eligible &= mask
    single_day_index = tuple(r23.r0.page_v3.EXPECTED_CANDIDATE_IDS).index("single-day")
    eligible[single_day_index] = False
    if not bool(np.any(eligible)):
        return None
    masked = np.where(eligible, probabilities, -np.inf)
    candidate = int(np.argmax(masked))
    if float(masked[candidate]) < threshold:
        return None
    return candidate


def _evaluate_candidate_actions(
    records: Sequence[Mapping[str, Any]], actions: Sequence[int | None]
) -> Mapping[str, Any]:
    by_work: dict[str, list[Mapping[str, float]]] = {}
    applied = 0
    known_common = 0
    for record, action in zip(records, actions, strict=True):
        scores = np.asarray(record["scores"], dtype=np.float64)
        local_top1 = np.argmax(scores, axis=1)
        selected_top1 = (
            local_top1
            if action is None
            else np.full(len(local_top1), int(action), dtype=np.int64)
        )
        local = r25._row_outcomes(record["rows"], local_top1)
        selected = r25._row_outcomes(record["rows"], selected_top1)
        common = np.asarray(record["group"]["common_positive_mask"], dtype=np.bool_)
        count = len(local_top1)
        values = {
            "preferred": (selected["preferred"] - local["preferred"]) / count,
            "safe": (selected["safe"] - local["safe"]) / count,
            "top1_all_agree": float(np.all(selected_top1 == selected_top1[0]))
            - float(np.all(local_top1 == local_top1[0])),
            "top1_in_common": float(np.all(common[selected_top1]))
            - float(np.all(common[local_top1])),
            "unacceptable": (selected["unacceptable"] - local["unacceptable"]) / count,
        }
        by_work.setdefault(str(record["work_id"]), []).append(values)
        applied += int(action is not None)
        known_common += int(action is not None and bool(common[int(action)]))
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
    return {
        "applied": applied,
        "known_common_actions": known_common,
        "per_work": per_work,
        "work_macro_delta": macro,
        "worst_safe_delta": min(value["safe"] for value in per_work.values()),
    }


def _screen_candidate_ranker(
    records: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    works = np.asarray([record["work_id"] for record in records]).astype(str)
    all_candidate_features = [
        _candidate_feature_matrix(record["scores"]) for record in records
    ]
    configs = [
        (kind, depth, leaf)
        for kind in ("extra", "rf")
        for depth in (3, 5, 7)
        for leaf in (1, 2, 3)
    ]
    rows = []
    for kind, depth, leaf in configs:
        probabilities = np.zeros((len(records), 21), dtype=np.float64)
        for heldout in sorted(set(works.tolist())):
            train = works != heldout
            test_positions = np.flatnonzero(~train)
            train_features, train_targets = _candidate_training_rows(records, train)
            model = _model(kind, depth, leaf, 23, estimators=200)
            model.fit(train_features, train_targets)
            for position in test_positions.tolist():
                probabilities[position] = _positive_probability(
                    model, all_candidate_features[position]
                )
        for top_k in (3, 5, 7):
            for threshold in (0.4, 0.5, 0.6, 0.7, 0.8):
                actions = [
                    _candidate_action(
                        record,
                        probabilities[index],
                        top_k=top_k,
                        threshold=threshold,
                    )
                    for index, record in enumerate(records)
                ]
                metrics = _evaluate_candidate_actions(records, actions)
                delta = metrics["work_macro_delta"]
                if (
                    delta["safe"] < -1e-12
                    or delta["preferred"] < -1e-12
                    or delta["unacceptable"] > 1e-12
                    or metrics["worst_safe_delta"] < -0.05 - 1e-12
                ):
                    continue
                rows.append(
                    {
                        "applied": metrics["applied"],
                        "common_actions": metrics["known_common_actions"],
                        "common_delta": delta["top1_in_common"],
                        "depth": depth,
                        "kind": kind,
                        "leaf": leaf,
                        "preferred_delta": delta["preferred"],
                        "safe_delta": delta["safe"],
                        "threshold": threshold,
                        "top1_agree_delta": delta["top1_all_agree"],
                        "top_k": top_k,
                        "worst_safe_delta": metrics["worst_safe_delta"],
                    }
                )
    rows.sort(
        key=lambda row: (
            min(row["top1_agree_delta"], row["common_delta"]),
            row["top1_agree_delta"] + row["common_delta"],
            row["preferred_delta"],
            row["safe_delta"],
        ),
        reverse=True,
    )
    return {
        "eligible_count": len(rows),
        "group_count": len(records),
        "status": "r26_candidate_ranker_screen",
        "top": rows[:40],
        "work_count": len(set(works.tolist())),
    }


def _screen_consensus_rules(
    records: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    prepared = []
    for record in records:
        scores = np.asarray(record["scores"], dtype=np.float64)
        probabilities = r25._softmax(scores)
        mean_scores = np.mean(scores, axis=0)
        winner = int(np.argmax(mean_scores))
        order = np.argsort(-scores, axis=1, kind="stable")
        mean_probability = np.mean(probabilities, axis=0)
        js = float(r25._group_features(scores)[12])
        prepared.append(
            {
                "js": js,
                "mean_winner_probability": float(mean_probability[winner]),
                "minimum_winner_probability": float(np.min(probabilities[:, winner])),
                "ranks": np.asarray(
                    [int(np.flatnonzero(row == winner)[0]) for row in order],
                    dtype=np.int64,
                ),
                "winner": winner,
            }
        )
    rows = []
    for top_k in (3, 4, 5, 7):
        for minimum_probability in (0.0, 0.01, 0.02, 0.03, 0.05):
            for mean_probability in (0.03, 0.05, 0.075, 0.1, 0.15):
                for maximum_js in (0.05, 0.1, 0.15, 0.2, 0.3, 0.5):
                    enabled = [
                        bool(
                            int(np.max(item["ranks"])) < top_k
                            and item["minimum_winner_probability"]
                            >= minimum_probability
                            and item["mean_winner_probability"] >= mean_probability
                            and item["js"] <= maximum_js
                        )
                        for item in prepared
                    ]
                    for alpha in (0.5, 0.65, 0.75, 1.0):
                        metrics = r25._evaluate_group_records(
                            records, enabled, alpha=alpha
                        )
                        delta = metrics["work_macro_delta"]
                        if (
                            delta["safe"] < -0.005 - 1e-12
                            or delta["preferred"] < -0.005 - 1e-12
                            or delta["unacceptable"] > 1e-12
                            or metrics["worst_work_safe_delta"] < -0.05 - 1e-12
                        ):
                            continue
                        rows.append(
                            {
                                "alpha": alpha,
                                "applied": metrics["applied_group_count"],
                                "common_delta": delta["top1_in_common"],
                                "max_js": maximum_js,
                                "mean_probability": mean_probability,
                                "min_probability": minimum_probability,
                                "preferred_delta": delta["preferred"],
                                "safe_delta": delta["safe"],
                                "top1_agree_delta": delta["top1_all_agree"],
                                "top_k": top_k,
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
    return {
        "eligible_count": len(rows),
        "group_count": len(records),
        "status": "r26_consensus_rule_screen",
        "top": rows[:40],
        "work_count": 13,
    }


def _screen_anchor_rules(
    records: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    candidates = []
    for record in records:
        scores = np.asarray(record["scores"], dtype=np.float64)
        probabilities = r25._softmax(scores)
        top1 = np.argmax(scores, axis=1)
        top1_probability = np.max(probabilities, axis=1)
        counts = np.bincount(top1, minlength=scores.shape[1])
        modal = int(np.argmax(counts))
        confident = int(top1[int(np.argmax(top1_probability))])
        mean_winner = int(np.argmax(np.mean(scores, axis=0)))
        candidate_ids = tuple(r23.r0.page_v3.EXPECTED_CANDIDATE_IDS)
        stable_indices = np.asarray(
            [
                index
                for index, candidate_id in enumerate(candidate_ids)
                if candidate_id in STABLE_BODY_FONT_IDS
            ],
            dtype=np.int64,
        )
        stable_mean = int(
            stable_indices[int(np.argmax(np.mean(scores, axis=0)[stable_indices]))]
        )
        candidates.append(
            {
                "confident": confident,
                "consensus": float(np.max(counts) / len(top1)),
                "mean": mean_winner,
                "modal": modal,
                "stable_mean": stable_mean,
                "probabilities": probabilities,
                "scores": scores,
            }
        )
    rows = []
    for strategy in ("modal", "confident", "mean", "stable_mean"):
        for top_k in (3, 4, 5, 7):
            for minimum_consensus in (0.0, 0.34, 0.5, 0.67):
                for minimum_anchor_probability in (0.0, 0.03, 0.05, 0.1, 0.15):
                    actions: list[int | None] = []
                    for item in candidates:
                        candidate = int(item[strategy])
                        order = np.argsort(-item["scores"], axis=1, kind="stable")
                        ranks = np.asarray(
                            [int(np.flatnonzero(row == candidate)[0]) for row in order]
                        )
                        minimum_probability = float(
                            np.min(item["probabilities"][:, candidate])
                        )
                        enabled = bool(
                            int(np.max(ranks)) < top_k
                            and item["consensus"] >= minimum_consensus
                            and minimum_probability >= minimum_anchor_probability
                            and candidate
                            != tuple(r23.r0.page_v3.EXPECTED_CANDIDATE_IDS).index(
                                "single-day"
                            )
                        )
                        actions.append(candidate if enabled else None)
                    metrics = _evaluate_candidate_actions(records, actions)
                    delta = metrics["work_macro_delta"]
                    if (
                        delta["safe"] < -0.005 - 1e-12
                        or delta["preferred"] < -0.005 - 1e-12
                        or delta["unacceptable"] > 1e-12
                        or metrics["worst_safe_delta"] < -0.05 - 1e-12
                    ):
                        continue
                    rows.append(
                        {
                            "applied": metrics["applied"],
                            "common_actions": metrics["known_common_actions"],
                            "common_delta": delta["top1_in_common"],
                            "minimum_anchor_probability": minimum_anchor_probability,
                            "minimum_consensus": minimum_consensus,
                            "preferred_delta": delta["preferred"],
                            "safe_delta": delta["safe"],
                            "strategy": strategy,
                            "top1_agree_delta": delta["top1_all_agree"],
                            "top_k": top_k,
                            "worst_safe_delta": metrics["worst_safe_delta"],
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
    return {
        "eligible_count": len(rows),
        "group_count": len(records),
        "status": "r26_anchor_rule_screen",
        "top": rows[:40],
        "work_count": 13,
    }


def _screen(records: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    features = np.stack([record["features_r26"] for record in records])
    works = np.asarray([record["work_id"] for record in records]).astype(str)
    rows = []
    for alpha in (0.5, 0.65, 0.75):
        targets = np.asarray(
            [_action_target(record, alpha) for record in records], dtype=np.bool_
        )
        for kind in ("rf", "extra"):
            for depth in (2, 3, 4):
                for leaf in (2, 3, 5):
                    probabilities = np.zeros(len(records), dtype=np.float64)
                    for heldout in sorted(set(works.tolist())):
                        train = works != heldout
                        test = ~train
                        model = _model(kind, depth, leaf, 19, estimators=160)
                        model.fit(features[train], targets[train])
                        probabilities[test] = _positive_probability(
                            model, features[test]
                        )
                    for threshold in (0.5, 0.55, 0.6, 0.65, 0.7):
                        enabled = probabilities >= threshold
                        metrics = r25._evaluate_group_records(
                            records, enabled.tolist(), alpha=alpha
                        )
                        delta = metrics["work_macro_delta"]
                        if (
                            delta["safe"] < -1e-12
                            or delta["preferred"] < -1e-12
                            or delta["unacceptable"] > 1e-12
                            or metrics["worst_work_safe_delta"] < -0.05 - 1e-12
                        ):
                            continue
                        rows.append(
                            {
                                "alpha": alpha,
                                "applied": metrics["applied_group_count"],
                                "common_delta": delta["top1_in_common"],
                                "depth": depth,
                                "kind": kind,
                                "leaf": leaf,
                                "positive_targets": int(np.sum(targets)),
                                "preferred_delta": delta["preferred"],
                                "safe_delta": delta["safe"],
                                "threshold": threshold,
                                "top1_agree_delta": delta["top1_all_agree"],
                                "worst_safe_delta": metrics["worst_work_safe_delta"],
                            }
                        )
    rows.sort(
        key=lambda row: (
            min(row["top1_agree_delta"], row["common_delta"]),
            row["top1_agree_delta"] + row["common_delta"],
            row["preferred_delta"],
            row["safe_delta"],
        ),
        reverse=True,
    )
    return {
        "eligible_count": len(rows),
        "feature_count": len(features[0]),
        "group_count": len(records),
        "status": "r26_13_work_screen",
        "top": rows[:40],
        "work_count": len(set(works.tolist())),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("screen", "screen-candidate", "screen-rule", "screen-anchor"),
    )
    args = parser.parse_args()
    if args.command == "screen":
        result = _screen(_records())
    elif args.command == "screen-candidate":
        result = _screen_candidate_ranker(_records())
    elif args.command == "screen-rule":
        result = _screen_consensus_rules(_records())
    elif args.command == "screen-anchor":
        result = _screen_anchor_rules(_records())
    else:  # pragma: no cover
        raise R26TrainingError("unsupported command")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
