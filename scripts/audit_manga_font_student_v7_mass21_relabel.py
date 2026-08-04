#!/usr/bin/env python3
"""Audit and stage iterative active21 relabel passes without running inference.

This is the CPU-only bridge between a sealed v7 mass-label pass and the next
review/training iteration.  It deliberately does not import or invoke a visual
encoder.  Existing active21 human supervision is evaluation-only, while every
remaining train pseudo row (including low-confidence rows) is preserved as a
dense soft teacher target.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts import label_manga_font_student_v7_mass21_pass as labeler
    from scripts import train_manga_font_student_v1 as base
    from scripts import train_manga_font_student_v6_mass21_data as mass21
except ImportError:  # pragma: no cover - direct execution from scripts/
    import label_manga_font_student_v7_mass21_pass as labeler
    import train_manga_font_student_v1 as base
    import train_manga_font_student_v6_mass21_data as mass21


SCHEMA = "manga-font-student-v7-mass21-relabel-audit-v1"
REPORT_SCHEMA = "manga-font-student-v7-mass21-relabel-audit-report-v1"
PRIORITY_SCHEMA = "manga-font-student-v7-mass21-review-priority-v1"
GOLD_EVAL_SCHEMA = "manga-font-student-v7-mass21-gold-evaluation-v1"
OWNER = "carrot-manga-translator/manga-font-v7-mass21-relabel-audit-v1"
MARKER = ".manga-font-v7-mass21-relabel-audit-v1-owned.json"
REPORT_FILE = "report.json"
PRIORITY_FILE = "review-priority.jsonl"
NEXT_PSEUDO_FILE = "next-pseudo-targets.jsonl"
GOLD_EVAL_FILE = "human-gold-evaluation.jsonl"
RETIRED_FONT_ID = "gugi"
INFLUENCE_FIELDS = frozenset({"gemma", "role", "genre", "chapter", "family_prior"})


class RelabelAuditError(ValueError):
    """Raised when relabel evidence crosses an authority or leakage boundary."""


@dataclass(frozen=True)
class GoldLabel:
    sample_id: str
    preferred_ids: frozenset[str]
    acceptable_ids: frozenset[str]
    role: str
    source: str


@dataclass(frozen=True)
class GoldBundle:
    labels: Mapping[str, GoldLabel]
    reviewed_ids: frozenset[str]
    retired_only_ids: frozenset[str]
    bindings: Mapping[str, Any]


@dataclass(frozen=True)
class AuditResult:
    report: Mapping[str, Any]
    priority_rows: tuple[Mapping[str, Any], ...]
    next_pseudo_rows: tuple[Mapping[str, Any], ...]
    gold_evaluation_rows: tuple[Mapping[str, Any], ...]


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


def ordered_ids_sha256(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(sorted(set(values))) + "\n").encode("utf-8"))


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> None:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise RelabelAuditError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise RelabelAuditError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RelabelAuditError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise RelabelAuditError(f"{location}: expected array")
    return value


def active_candidate_ids() -> tuple[str, ...]:
    values = mass21.candidate_projection(mass21.legacy15.FULL22_CANDIDATE_IDS).active_ids
    if len(values) != 21 or RETIRED_FONT_ID in values:
        raise RelabelAuditError("active21 vocabulary retained the retired font")
    return values


def audit_role(source_category: str) -> str:
    """Return a review-only bucket; this value never enters family logits."""

    if source_category == "ordinary":
        return "plain_dialogue"
    if source_category == "bubble_edge":
        return "aside_balloon_edge"
    if source_category == "page_sound":
        return "sfx"
    if source_category in {"text_free", "free_near_bubble"}:
        return "emphasis_free_text"
    return "variant_other"


def _quantile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return round(float(ordered[lower]), 8)
    weight = position - lower
    return round(float(ordered[lower] * (1.0 - weight) + ordered[upper] * weight), 8)


def _metric_summary(values: Sequence[float]) -> Mapping[str, Any]:
    if not values:
        return {"max": None, "mean": None, "min": None, "p50": None, "p90": None}
    return {
        "max": round(max(values), 8),
        "mean": round(sum(values) / len(values), 8),
        "min": round(min(values), 8),
        "p50": _quantile(values, 0.50),
        "p90": _quantile(values, 0.90),
    }


def _group_summary(
    rows: Sequence[Mapping[str, Any]], candidate_ids: tuple[str, ...]
) -> Mapping[str, Any]:
    counts = Counter(str(row["selected_font_id"]) for row in rows)
    total = len(rows)
    return {
        "entropy": _metric_summary([float(row["entropy"]) for row in rows]),
        "row_count": total,
        "top1_distribution": {
            candidate_id: {
                "count": counts[candidate_id],
                "share": round(counts[candidate_id] / total, 8) if total else 0.0,
            }
            for candidate_id in candidate_ids
        },
        "top1_margin": _metric_summary(
            [float(_mapping(row["ranker"], "ranker")["top1_margin"]) for row in rows]
        ),
        "view_disagreement": _metric_summary(
            [
                float(
                    _mapping(row["view_disagreement"], "view_disagreement")[
                        "top1_disagreement"
                    ]
                )
                for row in rows
            ]
        ),
    }


def _summaries_by(
    rows: Sequence[Mapping[str, Any]],
    candidate_ids: tuple[str, ...],
    key,
    metadata,
) -> Mapping[str, Any]:
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(key(row))].append(row)
    return {
        group: {**metadata(values), **_group_summary(values, candidate_ids)}
        for group, values in sorted(grouped.items())
    }


def _probability_top1(row: Mapping[str, Any], candidate_ids: tuple[str, ...]) -> str:
    declared = tuple(str(value) for value in row.get("candidate_ids", ()))
    values = tuple(float(value) for value in row.get("probabilities", ()))
    if (
        declared != candidate_ids
        or len(values) != len(candidate_ids)
        or any(not math.isfinite(value) or value < 0.0 for value in values)
        or not math.isclose(sum(values), 1.0, rel_tol=0.0, abs_tol=1e-5)
    ):
        raise RelabelAuditError("pseudo probability contract drifted")
    return candidate_ids[max(range(len(values)), key=lambda index: values[index])]


def _validate_review_row(
    row: Mapping[str, Any], *, candidate_ids: tuple[str, ...], location: str
) -> None:
    labeler.validate_record_seal(row, location=location)
    if (
        row.get("schema_version") != labeler.SCHEMA
        or row.get("label_authority") != "pseudo_not_gold"
        or row.get("training_eligible") is not False
        or row.get("promotion_allowed") is not False
        or row.get("split") not in labeler.VALID_SPLITS
        or tuple(str(value) for value in row.get("candidate_ids", ())) != candidate_ids
        or row.get("selected_font_id") not in candidate_ids
        or float(row.get("gugi_probability", -1.0)) != 0.0
    ):
        raise RelabelAuditError(f"{location}: review authority drifted")
    probability_top1 = _probability_top1(row, candidate_ids)
    ranker = _mapping(row.get("ranker"), f"{location}.ranker")
    top5 = _sequence(ranker.get("top5"), f"{location}.ranker.top5")
    if (
        ranker.get("selected_font_id") != row.get("selected_font_id")
        or probability_top1 != row.get("selected_font_id")
        or len(top5) != 5
        or top5[0].get("font_id") != row.get("selected_font_id")
        or not 0.0 <= float(ranker.get("top1_margin", -1.0)) <= 1.0
        or not 0.0 <= float(row.get("entropy", -1.0)) <= 1.0
    ):
        raise RelabelAuditError(f"{location}: ranking evidence drifted")
    influence = _mapping(
        row.get("family_logit_influence"), f"{location}.family_logit_influence"
    )
    if set(influence) != INFLUENCE_FIELDS or any(
        float(influence[name]) != 0.0 for name in INFLUENCE_FIELDS
    ):
        raise RelabelAuditError(f"{location}: nonvisual family logit influence")
    disagreement = _mapping(
        row.get("view_disagreement"), f"{location}.view_disagreement"
    )
    if not 0.0 <= float(disagreement.get("top1_disagreement", -1.0)) <= 1.0:
        raise RelabelAuditError(f"{location}: view disagreement drifted")


def _validate_pseudo_row(
    row: Mapping[str, Any], *, candidate_ids: tuple[str, ...], location: str
) -> None:
    labeler.validate_record_seal(row, location=location)
    if (
        row.get("schema_version") != mass21.PSEUDO_SCHEMA
        or row.get("split") != "train"
        or row.get("label_authority") != "pseudo_soft_not_gold"
        or row.get("training_eligible") is not False
        or not 0.0 <= float(row.get("weight", -1.0)) <= 1.0
    ):
        raise RelabelAuditError(f"{location}: pseudo authority drifted")
    _probability_top1(row, candidate_ids)
    teacher = _mapping(row.get("teacher_bindings"), f"{location}.teacher_bindings")
    if not teacher or mass21._contains_gemma_binding(teacher):  # noqa: SLF001
        raise RelabelAuditError(f"{location}: invalid or Gemma-bound teacher")


def _iter_jsonl(path: Path, location: str) -> Iterable[Mapping[str, Any]]:
    if path.is_symlink() or not path.is_file():
        raise RelabelAuditError(f"{location}: missing or linked file")
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise RelabelAuditError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield _mapping(row, f"{location}:{line_number}")


def load_sealed_pass(
    pass_dir: Path,
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]], Mapping[str, Any]]:
    root = pass_dir.expanduser().resolve()
    validation = labeler.validate_output(root)
    candidate_ids = active_candidate_ids()
    reviews: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(_iter_jsonl(root / labeler.REVIEW_OUTPUT, "review"), 1):
        _validate_review_row(row, candidate_ids=candidate_ids, location=f"review:{index}")
        sample_id = str(row.get("sample_id", ""))
        if not sample_id or sample_id in seen:
            raise RelabelAuditError("review identities are empty or duplicated")
        seen.add(sample_id)
        reviews.append(row)
    pseudos: list[Mapping[str, Any]] = []
    pseudo_ids: set[str] = set()
    for index, row in enumerate(_iter_jsonl(root / labeler.PSEUDO_OUTPUT, "pseudo"), 1):
        _validate_pseudo_row(row, candidate_ids=candidate_ids, location=f"pseudo:{index}")
        sample_id = str(row.get("sample_id", ""))
        if not sample_id or sample_id in pseudo_ids:
            raise RelabelAuditError("pseudo identities are empty or duplicated")
        pseudo_ids.add(sample_id)
        pseudos.append(row)
    expected_train = {str(row["sample_id"]) for row in reviews if row["split"] == "train"}
    if pseudo_ids != expected_train:
        raise RelabelAuditError("review/pseudo train identity binding drifted")
    return reviews, pseudos, validation


def load_previous_pseudo(
    path: Path | None, *, candidate_ids: tuple[str, ...]
) -> tuple[Mapping[str, str], Mapping[str, Any]]:
    if path is None:
        return {}, {"path": None, "row_count": 0, "sha256": None}
    source = path.expanduser().resolve()
    top1: dict[str, str] = {}
    for index, row in enumerate(_iter_jsonl(source, "previous pseudo"), 1):
        if (
            row.get("schema_version") != mass21.PSEUDO_SCHEMA
            or row.get("split") != "train"
            or row.get("label_authority") != "pseudo_soft_not_gold"
            or row.get("training_eligible") is not False
        ):
            raise RelabelAuditError(f"previous pseudo:{index}: authority drifted")
        teacher = _mapping(row.get("teacher_bindings"), "previous teacher bindings")
        if not teacher or mass21._contains_gemma_binding(teacher):  # noqa: SLF001
            raise RelabelAuditError("previous pseudo retained a Gemma teacher binding")
        sample_id = str(row.get("sample_id", ""))
        if not sample_id or sample_id in top1:
            raise RelabelAuditError("previous pseudo identities are empty or duplicated")
        top1[sample_id] = _probability_top1(row, candidate_ids)
    return top1, {
        "path": str(source),
        "row_count": len(top1),
        "sha256": sha256_file(source),
    }


def load_repository_gold(
    *,
    cache_dir: Path,
    authority_dir: Path,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    human_catalog_registry: Path,
) -> GoldBundle:
    """Load labels only; the 1.18 GiB token cache is never opened."""

    cache_root = cache_dir.expanduser().resolve()
    contract_path = cache_root / mass21.v6.CACHE_CONTRACT
    contract = base.read_json(contract_path, location="mass21 cache contract")
    base.validate_record_seal(contract, location="mass21 cache contract")
    projection = mass21.candidate_projection(contract.get("candidate_ids", ()))
    human = mass21.load_human_supervision(
        cache_contract=contract,
        authority_dir=authority_dir,
        review_dir=review_dir,
        draft_dir=draft_dir,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=human_catalog_registry,
        projection=projection,
    )
    candidate_ids = projection.active_ids
    candidate_set = frozenset(candidate_ids)
    labels: dict[str, GoldLabel] = {}
    original = _sequence(contract.get("human_train"), "cache human_train")
    for index, raw in enumerate(original):
        row = _mapping(raw, f"cache human_train[{index}]")
        sample_id = str(row.get("sample_id", ""))
        preferred = frozenset(str(value) for value in row.get("preferred_candidate_ids", ()))
        acceptable = frozenset(str(value) for value in row.get("acceptable_candidate_ids", ()))
        preferred &= candidate_set
        acceptable &= candidate_set
        preferred = preferred or acceptable
        acceptable = (acceptable | preferred) & candidate_set
        if not sample_id or not preferred or sample_id in labels:
            raise RelabelAuditError("cached original active21 human gold drifted")
        labels[sample_id] = GoldLabel(
            sample_id,
            preferred,
            acceptable,
            str(row.get("role", "other")),
            "cached_original_full21",
        )
    for example in human.addition_examples:
        judgment = _mapping(example.row.get("font_judgment"), "human font judgment")
        preferred = frozenset(str(value) for value in judgment.get("preferred", ()))
        acceptable = frozenset(str(value) for value in judgment.get("acceptable", ()))
        preferred &= candidate_set
        acceptable &= candidate_set
        # The deployed tier-code contract promotes an acceptable-only positive
        # set to the primary set instead of silently dropping that human row.
        preferred = preferred or acceptable
        acceptable = (acceptable | preferred) & candidate_set
        if not preferred or example.sample_id in labels:
            raise RelabelAuditError("reviewed active21 human gold drifted")
        labels[example.sample_id] = GoldLabel(
            example.sample_id,
            preferred,
            acceptable,
            base.ROLE_VALUES[example.role_index],
            "reviewed_full_or_partial_active21",
        )
    retired_ids = frozenset(example.sample_id for example in human.retired_only_examples)
    if (
        len(labels) != mass21.SUPERVISED_HUMAN_ROWS
        or len(human.all_sample_ids) != mass21.HUMAN_TRAIN_ROWS
        or set(labels) & retired_ids
        or set(labels) | set(retired_ids) != set(human.all_sample_ids)
    ):
        raise RelabelAuditError("675 gold / 52 retired-only authority boundary drifted")
    return GoldBundle(
        labels=labels,
        reviewed_ids=human.all_sample_ids,
        retired_only_ids=retired_ids,
        bindings={
            "active21_gold_rows": len(labels),
            "active21_gold_sample_ids_sha256": ordered_ids_sha256(labels),
            "cache_contract_sha256": sha256_file(contract_path),
            "human_reviewed_rows": len(human.all_sample_ids),
            "human_reviewed_sample_ids_sha256": ordered_ids_sha256(
                human.all_sample_ids
            ),
            "retired_only_rows": len(retired_ids),
            "retired_only_sample_ids_sha256": ordered_ids_sha256(retired_ids),
        },
    )


def _chapter_plain_majorities(
    rows: Sequence[Mapping[str, Any]],
) -> Mapping[tuple[str, str], Mapping[str, Any]]:
    grouped: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    for row in rows:
        if audit_role(str(row.get("source_category", "ordinary"))) != "plain_dialogue":
            continue
        key = (str(row.get("work_id")), str(row.get("chapter_id")))
        grouped[key][str(row.get("selected_font_id"))] += 1
    result: dict[tuple[str, str], Mapping[str, Any]] = {}
    for key, counts in grouped.items():
        ordered = sorted(counts.items(), key=lambda value: (-value[1], value[0]))
        total = sum(counts.values())
        unique = len(ordered) == 1 or ordered[0][1] > ordered[1][1]
        majority = ordered[0][0] if total >= 3 and ordered[0][1] >= 2 and unique else None
        majority_count = ordered[0][1] if majority is not None else 0
        result[key] = {
            "majority_count": majority_count,
            "majority_font_id": majority,
            "majority_share": round(majority_count / total, 8) if total else 0.0,
            "plain_dialogue_rows": total,
            "unique_majority": majority is not None,
        }
    return result


def _transition_audit(
    rows: Sequence[Mapping[str, Any]],
    previous_top1: Mapping[str, str],
    candidate_ids: tuple[str, ...],
) -> Mapping[str, Any]:
    current = {str(row["sample_id"]): str(row["selected_font_id"]) for row in rows}
    shared = sorted(set(current) & set(previous_top1))
    matrix = {old: {new: 0 for new in candidate_ids} for old in candidate_ids}
    previous_counts: Counter[str] = Counter()
    current_counts: Counter[str] = Counter()
    changed_destinations: Counter[str] = Counter()
    changed = 0
    for sample_id in shared:
        old = previous_top1[sample_id]
        new = current[sample_id]
        if old not in matrix or new not in matrix[old]:
            raise RelabelAuditError("transition vocabulary escaped active21")
        matrix[old][new] += 1
        previous_counts[old] += 1
        current_counts[new] += 1
        if old != new:
            changed += 1
            changed_destinations[new] += 1
    warnings: list[Mapping[str, Any]] = []
    total = len(shared)
    minimum_mass = max(10, int(math.ceil(total * 0.01))) if total else 10
    for candidate_id in candidate_ids:
        current_share = current_counts[candidate_id] / total if total else 0.0
        previous_share = previous_counts[candidate_id] / total if total else 0.0
        if current_counts[candidate_id] >= minimum_mass and current_share >= 0.35:
            warnings.append(
                {
                    "font_id": candidate_id,
                    "new_share": round(current_share, 8),
                    "row_count": current_counts[candidate_id],
                    "type": "global_top1_skew",
                }
            )
        if (
            current_counts[candidate_id] >= minimum_mass
            and current_share - previous_share >= 0.08
            and current_share >= max(0.10, previous_share * 2.0)
        ):
            warnings.append(
                {
                    "font_id": candidate_id,
                    "new_share": round(current_share, 8),
                    "previous_share": round(previous_share, 8),
                    "type": "top1_share_jump",
                }
            )
        if previous_counts[candidate_id] >= minimum_mass and current_counts[candidate_id] == 0:
            warnings.append(
                {
                    "font_id": candidate_id,
                    "previous_rows": previous_counts[candidate_id],
                    "type": "candidate_disappearance",
                }
            )
        destination_share = changed_destinations[candidate_id] / changed if changed else 0.0
        if changed_destinations[candidate_id] >= minimum_mass and destination_share >= 0.45:
            warnings.append(
                {
                    "changed_destination_share": round(destination_share, 8),
                    "font_id": candidate_id,
                    "row_count": changed_destinations[candidate_id],
                    "type": "changed_rows_destination_collapse",
                }
            )
    for old in candidate_ids:
        moved = sum(matrix[old][new] for new in candidate_ids if new != old)
        if moved < minimum_mass:
            continue
        destination, captured = max(
            ((new, matrix[old][new]) for new in candidate_ids if new != old),
            key=lambda value: (value[1], value[0]),
        )
        if captured / moved >= 0.75:
            warnings.append(
                {
                    "captured_rows": captured,
                    "from_font_id": old,
                    "moved_rows": moved,
                    "share": round(captured / moved, 8),
                    "to_font_id": destination,
                    "type": "source_font_mass_transition",
                }
            )
    return {
        "changed_rows": changed,
        "changed_share": round(changed / total, 8) if total else None,
        "current_only_rows": len(set(current) - set(previous_top1)),
        "matrix": matrix,
        "previous_only_rows": len(set(previous_top1) - set(current)),
        "shared_rows": total,
        "warnings": warnings,
    }


def _gold_metrics(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    count = len(rows)
    counters = Counter()
    for row in rows:
        for name in (
            "preferred_at1",
            "acceptable_at1",
            "preferred_hit_at3",
            "acceptable_hit_at3",
        ):
            counters[name] += int(bool(row[name]))
    return {
        "acceptable_at1": round(counters["acceptable_at1"] / count, 8) if count else None,
        "acceptable_hit_at3": (
            round(counters["acceptable_hit_at3"] / count, 8) if count else None
        ),
        "preferred_at1": round(counters["preferred_at1"] / count, 8) if count else None,
        "preferred_hit_at3": (
            round(counters["preferred_hit_at3"] / count, 8) if count else None
        ),
        "row_count": count,
    }


def _evaluate_gold(
    rows: Sequence[Mapping[str, Any]], gold: GoldBundle
) -> tuple[list[Mapping[str, Any]], Mapping[str, Any]]:
    by_id = {str(row["sample_id"]): row for row in rows}
    evaluated: list[Mapping[str, Any]] = []
    for sample_id, label in sorted(gold.labels.items()):
        prediction = by_id.get(sample_id)
        if prediction is None:
            continue
        top5 = _sequence(_mapping(prediction["ranker"], "ranker")["top5"], "top5")
        ranked = tuple(str(value["font_id"]) for value in top5)
        top1 = ranked[0]
        top3 = frozenset(ranked[:3])
        evaluated.append(
            seal_record(
                {
                    "acceptable_at1": top1 in label.acceptable_ids,
                    "acceptable_candidate_ids": sorted(label.acceptable_ids),
                    "acceptable_hit_at3": bool(top3 & label.acceptable_ids),
                    "evaluation_only": True,
                    "label_authority": "human_gold_existing_read_only",
                    "predicted_font_id": top1,
                    "prediction_record_sha256": prediction["record_sha256"],
                    "preferred_at1": top1 in label.preferred_ids,
                    "preferred_candidate_ids": sorted(label.preferred_ids),
                    "preferred_hit_at3": bool(top3 & label.preferred_ids),
                    "promotion_allowed": False,
                    "role": label.role,
                    "sample_id": sample_id,
                    "schema_version": GOLD_EVAL_SCHEMA,
                    "source": label.source,
                    "split": prediction["split"],
                    "top3_font_ids": list(ranked[:3]),
                    "training_eligible": False,
                }
            )
        )
    by_role: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in evaluated:
        by_role[str(row["role"])].append(row)
    return evaluated, {
        "active21_gold_rows": len(gold.labels),
        "matched_prediction_rows": len(evaluated),
        "metrics": _gold_metrics(evaluated),
        "metrics_by_role": {
            role: _gold_metrics(values) for role, values in sorted(by_role.items())
        },
        "missing_prediction_rows": len(gold.labels) - len(evaluated),
        "read_only": True,
    }


def _priority_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    gold: GoldBundle,
    previous_top1: Mapping[str, str],
    collapse_fonts: frozenset[str],
) -> list[Mapping[str, Any]]:
    majorities = _chapter_plain_majorities(rows)
    output: list[dict[str, Any]] = []
    for row in rows:
        sample_id = str(row["sample_id"])
        if sample_id in gold.reviewed_ids:
            continue
        category = str(row.get("source_category", "ordinary"))
        role = audit_role(category)
        selected = str(row["selected_font_id"])
        entropy = float(row["entropy"])
        margin = float(_mapping(row["ranker"], "ranker")["top1_margin"])
        view = float(
            _mapping(row["view_disagreement"], "view disagreement")[
                "top1_disagreement"
            ]
        )
        old = previous_top1.get(sample_id)
        changed = old is not None and old != selected
        key = (str(row.get("work_id")), str(row.get("chapter_id")))
        consistency = majorities.get(
            key,
            {
                "majority_count": 0,
                "majority_font_id": None,
                "majority_share": 0.0,
                "plain_dialogue_rows": 0,
                "unique_majority": False,
            },
        )
        plain_outlier = (
            role == "plain_dialogue"
            and consistency["majority_font_id"] is not None
            and selected != consistency["majority_font_id"]
        )
        margin_uncertainty = 1.0 - min(max(margin / 0.25, 0.0), 1.0)
        variant = role != "plain_dialogue"
        score = min(
            1.0,
            0.28 * entropy
            + 0.24 * margin_uncertainty
            + 0.20 * view
            + 0.16 * float(changed)
            + 0.22 * float(plain_outlier)
            + 0.10 * float(variant),
        )
        reasons: list[str] = []
        if plain_outlier:
            reasons.append("plain_dialogue_same_chapter_majority_outlier")
        if changed:
            reasons.append("previous_to_current_top1_changed")
        if selected in collapse_fonts and changed:
            reasons.append("transition_collapse_destination")
        if entropy >= 0.65:
            reasons.append("high_entropy")
        if margin <= 0.08:
            reasons.append("small_top1_margin")
        if view > 0.0:
            reasons.append("view_top1_disagreement")
        if variant:
            reasons.append(f"variant_bucket:{role}")
        if not reasons:
            reasons.append("stable_plain_dialogue_control")
        if plain_outlier or (changed and selected in collapse_fonts):
            tier = 0
        elif view >= 1.0 / 3.0 - 1e-6 or (variant and entropy >= 0.65):
            tier = 1
        elif variant or changed or margin <= 0.08:
            tier = 2
        else:
            tier = 3
        output.append(
            {
                "core": {
                    "audit_role": role,
                    "chapter_id": row.get("chapter_id"),
                    "chapter_plain_consistency": copy.deepcopy(dict(consistency)),
                    "entropy": round(entropy, 8),
                    "label_authority": "pseudo_not_gold",
                    "page_id": row.get("page_id"),
                    "page_name": row.get("page_name"),
                    "previous_font_id": old,
                    "priority": {
                        "reasons": reasons,
                        "score": round(score, 8),
                        "tier": tier,
                    },
                    "promotion_allowed": False,
                    "ranker_top5": copy.deepcopy(list(row["ranker"]["top5"])),
                    "review_bucket": role,
                    "sample_id": sample_id,
                    "schema_version": PRIORITY_SCHEMA,
                    "selected_font_id": selected,
                    "source_category": category,
                    "source_row_index": row.get("source_row_index"),
                    "split": row.get("split"),
                    "top1_changed": changed,
                    "top1_margin": round(margin, 8),
                    "training_eligible": False,
                    "view_disagreement": copy.deepcopy(dict(row["view_disagreement"])),
                    "work_id": row.get("work_id"),
                },
                "sort": (tier, -score, int(row.get("source_row_index", 0)), sample_id),
            }
        )
    output.sort(key=lambda value: value["sort"])
    sealed: list[Mapping[str, Any]] = []
    for rank, value in enumerate(output, 1):
        core = value["core"]
        core["review_rank"] = rank
        sealed.append(seal_record(core))
    return sealed


def audit_records(
    reviews: Sequence[Mapping[str, Any]],
    pseudos: Sequence[Mapping[str, Any]],
    *,
    gold: GoldBundle,
    previous_top1: Mapping[str, str] | None = None,
) -> AuditResult:
    candidate_ids = active_candidate_ids()
    if not reviews:
        raise RelabelAuditError("review input is empty")
    review_ids: set[str] = set()
    for index, row in enumerate(reviews, 1):
        _validate_review_row(row, candidate_ids=candidate_ids, location=f"review:{index}")
        sample_id = str(row.get("sample_id", ""))
        if not sample_id or sample_id in review_ids:
            raise RelabelAuditError("review identities are empty or duplicated")
        review_ids.add(sample_id)
    pseudo_ids: set[str] = set()
    for index, row in enumerate(pseudos, 1):
        _validate_pseudo_row(row, candidate_ids=candidate_ids, location=f"pseudo:{index}")
        sample_id = str(row.get("sample_id", ""))
        if not sample_id or sample_id in pseudo_ids or sample_id not in review_ids:
            raise RelabelAuditError("pseudo identity binding drifted")
        pseudo_ids.add(sample_id)
    expected_train = {str(row["sample_id"]) for row in reviews if row["split"] == "train"}
    if pseudo_ids != expected_train:
        raise RelabelAuditError("every and only train review must retain a pseudo row")
    previous = previous_top1 or {}
    transition = _transition_audit(reviews, previous, candidate_ids)
    collapse_fonts = frozenset(
        str(warning["font_id"])
        for warning in transition["warnings"]
        if warning["type"] == "changed_rows_destination_collapse"
    )
    gold_rows, gold_report = _evaluate_gold(reviews, gold)
    priority = _priority_rows(
        reviews,
        gold=gold,
        previous_top1=previous,
        collapse_fonts=collapse_fonts,
    )
    next_pseudo = tuple(
        row for row in pseudos if str(row["sample_id"]) not in gold.reviewed_ids
    )
    next_ids = {str(row["sample_id"]) for row in next_pseudo}
    if (
        len(next_ids) != len(next_pseudo)
        or next_ids & set(gold.reviewed_ids)
        or any(row.get("split") != "train" for row in next_pseudo)
    ):
        raise RelabelAuditError("next pseudo leakage boundary drifted")
    low_confidence_before = sum(
        float(row.get("weight", 0.0)) <= 0.05
        for row in pseudos
        if str(row["sample_id"]) not in gold.reviewed_ids
    )
    low_confidence_after = sum(float(row.get("weight", 0.0)) <= 0.05 for row in next_pseudo)
    if low_confidence_after != low_confidence_before:
        raise RelabelAuditError("low-confidence pseudo rows were discarded")
    by_split = Counter(str(row["split"]) for row in reviews)
    groups = {
        "overall": _group_summary(reviews, candidate_ids),
        "by_work": _summaries_by(
            reviews,
            candidate_ids,
            lambda row: row["work_id"],
            lambda values: {"work_title": values[0].get("work_title")},
        ),
        "by_chapter": _summaries_by(
            reviews,
            candidate_ids,
            lambda row: f"{row['work_id']}::{row['chapter_id']}",
            lambda values: {
                "chapter_id": values[0].get("chapter_id"),
                "chapter_title": values[0].get("chapter_title"),
                "work_id": values[0].get("work_id"),
            },
        ),
        "by_role": _summaries_by(
            reviews,
            candidate_ids,
            lambda row: audit_role(str(row.get("source_category", "ordinary"))),
            lambda _values: {
                "role_source": "source_category_audit_bucket_no_logit_influence"
            },
        ),
        "by_source_category": _summaries_by(
            reviews,
            candidate_ids,
            lambda row: row.get("source_category", "ordinary"),
            lambda _values: {},
        ),
    }
    report = {
        "authority": {
            "automatic_gold_promotions": 0,
            "fabricated_corrections": 0,
            "gold_evaluation_only": True,
            "priority_rows_promotion_allowed": 0,
        },
        "candidate_count": len(candidate_ids),
        "candidate_ids": list(candidate_ids),
        "counts": {
            "gold_excluded_from_priority": len(review_ids & set(gold.reviewed_ids)),
            "gold_excluded_from_pseudo": len(pseudo_ids & set(gold.reviewed_ids)),
            "gold_evaluation_rows": len(gold_rows),
            "next_pseudo_rows": len(next_pseudo),
            "priority_rows": len(priority),
            "pseudo_input_rows": len(pseudos),
            "review_rows": len(reviews),
            "splits": dict(sorted(by_split.items())),
        },
        "gold": gold_report,
        "groups": groups,
        "influence_audit": {
            "family_logit_fields": {name: 0.0 for name in sorted(INFLUENCE_FIELDS)},
            "gugi_candidate_slots": 0,
            "gugi_probability_mass": 0.0,
            "rows_with_nonzero_nonvisual_family_logit": 0,
            "role_grouping_is_posthoc_audit_only": True,
        },
        "next_pseudo_contract": {
            "dense_soft_teacher_rows": len(next_pseudo),
            "human_reviewed_rows": 0,
            "label_authority": "pseudo_soft_not_gold",
            "low_confidence_rows_before": low_confidence_before,
            "low_confidence_rows_retained": low_confidence_after,
            "test_rows": 0,
            "training_eligible_flag_true_rows": 0,
            "val_rows": 0,
        },
        "record_type": "manga_font_student_v7_mass21_relabel_audit",
        "schema_version": REPORT_SCHEMA,
        "transition": transition,
    }
    return AuditResult(report, tuple(priority), next_pseudo, tuple(gold_rows))


def _jsonl_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return b"".join((canonical_json(row) + "\n").encode("utf-8") for row in rows)


def _write_bytes(path: Path, payload: bytes) -> None:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def _descriptor(path: Path, *, rows: int | None = None) -> Mapping[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if rows is not None:
        result["row_count"] = rows
    return result


def _prepare_output(output_dir: Path) -> tuple[Path, Path]:
    target = output_dir.expanduser().resolve()
    if target.exists():
        marker = target / MARKER
        if target.is_symlink() or not marker.is_file():
            raise RelabelAuditError("refusing to replace an unowned audit output")
        existing = _mapping(json.loads(marker.read_text(encoding="utf-8")), "marker")
        validate_record_seal(existing, location="marker")
        if existing.get("owner") != OWNER or existing.get("safe_replace") is not True:
            raise RelabelAuditError("audit output ownership marker drifted")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    return target, staging


def write_output(
    output_dir: Path,
    result: AuditResult,
    *,
    source_bindings: Mapping[str, Any],
    gold_bindings: Mapping[str, Any],
) -> Mapping[str, Any]:
    target, staging = _prepare_output(output_dir)
    published = False
    try:
        marker = seal_record(
            {
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        _write_bytes(
            staging / MARKER,
            (json.dumps(marker, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
                "utf-8"
            ),
        )
        payloads = {
            PRIORITY_FILE: result.priority_rows,
            NEXT_PSEUDO_FILE: result.next_pseudo_rows,
            GOLD_EVAL_FILE: result.gold_evaluation_rows,
        }
        for name, rows in payloads.items():
            _write_bytes(staging / name, _jsonl_bytes(rows))
        report_core = copy.deepcopy(dict(result.report))
        report_core.update(
            {
                "artifacts": {
                    name: _descriptor(staging / name, rows=len(rows))
                    for name, rows in payloads.items()
                },
                "gold_bindings": copy.deepcopy(dict(gold_bindings)),
                "marker_record_sha256": marker["record_sha256"],
                "source_bindings": copy.deepcopy(dict(source_bindings)),
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        report = seal_record(report_core)
        _write_bytes(
            staging / REPORT_FILE,
            (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
                "utf-8"
            ),
        )
        validate_output(staging)
        if target.exists():
            shutil.rmtree(target)
        os.rename(staging, target)
        published = True
        return validate_output(target)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    marker = _mapping(json.loads((root / MARKER).read_text(encoding="utf-8")), "marker")
    report = _mapping(
        json.loads((root / REPORT_FILE).read_text(encoding="utf-8")), "report"
    )
    validate_record_seal(marker, location="marker")
    validate_record_seal(report, location="report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != REPORT_SCHEMA
        or report.get("marker_record_sha256") != marker.get("record_sha256")
        or report.get("source_code_sha256") != sha256_file(Path(__file__).resolve())
    ):
        raise RelabelAuditError("audit metadata drifted")
    if {path.name for path in root.iterdir()} != {
        MARKER,
        REPORT_FILE,
        PRIORITY_FILE,
        NEXT_PSEUDO_FILE,
        GOLD_EVAL_FILE,
    }:
        raise RelabelAuditError("audit output inventory drifted")
    artifacts = _mapping(report.get("artifacts"), "report.artifacts")
    counts = _mapping(report.get("counts"), "report.counts")
    expected_counts = {
        PRIORITY_FILE: int(counts["priority_rows"]),
        NEXT_PSEUDO_FILE: int(counts["next_pseudo_rows"]),
        GOLD_EVAL_FILE: int(counts["gold_evaluation_rows"]),
    }
    candidate_ids = active_candidate_ids()
    if tuple(str(value) for value in report.get("candidate_ids", ())) != candidate_ids:
        raise RelabelAuditError("audit report candidate order drifted")
    seen_by_file: dict[str, set[str]] = {}
    for name, expected_count in expected_counts.items():
        descriptor = _mapping(artifacts.get(name), f"artifact {name}")
        path = root / name
        if (
            path.is_symlink()
            or not path.is_file()
            or descriptor.get("file") != name
            or descriptor.get("sha256") != sha256_file(path)
            or int(descriptor.get("byte_size", -1)) != path.stat().st_size
            or int(descriptor.get("row_count", -1)) != expected_count
        ):
            raise RelabelAuditError(f"artifact descriptor drifted: {name}")
        rows = list(_iter_jsonl(path, name))
        if len(rows) != expected_count:
            raise RelabelAuditError(f"artifact row count drifted: {name}")
        seen: set[str] = set()
        for index, row in enumerate(rows, 1):
            sample_id = str(row.get("sample_id", ""))
            if not sample_id or sample_id in seen:
                raise RelabelAuditError(f"{name}: duplicate/empty sample identity")
            seen.add(sample_id)
            if name == NEXT_PSEUDO_FILE:
                _validate_pseudo_row(
                    row, candidate_ids=candidate_ids, location=f"{name}:{index}"
                )
            else:
                validate_record_seal(row, location=f"{name}:{index}")
                if row.get("training_eligible") is not False:
                    raise RelabelAuditError(f"{name}: authority elevation detected")
                if name == PRIORITY_FILE and (
                    row.get("schema_version") != PRIORITY_SCHEMA
                    or row.get("label_authority") != "pseudo_not_gold"
                    or row.get("promotion_allowed") is not False
                    or row.get("selected_font_id") not in candidate_ids
                ):
                    raise RelabelAuditError("priority authority contract drifted")
                if name == GOLD_EVAL_FILE and (
                    row.get("schema_version") != GOLD_EVAL_SCHEMA
                    or row.get("label_authority") != "human_gold_existing_read_only"
                    or row.get("evaluation_only") is not True
                    or row.get("promotion_allowed") is not False
                ):
                    raise RelabelAuditError("gold read-only contract drifted")
        seen_by_file[name] = seen
    contract = _mapping(report.get("next_pseudo_contract"), "next pseudo contract")
    authority = _mapping(report.get("authority"), "authority")
    influence = _mapping(report.get("influence_audit"), "influence audit")
    if (
        int(contract.get("test_rows", -1)) != 0
        or int(contract.get("val_rows", -1)) != 0
        or int(contract.get("human_reviewed_rows", -1)) != 0
        or contract.get("low_confidence_rows_before")
        != contract.get("low_confidence_rows_retained")
        or int(authority.get("automatic_gold_promotions", -1)) != 0
        or int(authority.get("fabricated_corrections", -1)) != 0
        or int(influence.get("gugi_candidate_slots", -1)) != 0
        or float(influence.get("gugi_probability_mass", -1.0)) != 0.0
        or int(influence.get("rows_with_nonzero_nonvisual_family_logit", -1)) != 0
        or seen_by_file[NEXT_PSEUDO_FILE] & seen_by_file[GOLD_EVAL_FILE]
        or seen_by_file[PRIORITY_FILE] & seen_by_file[GOLD_EVAL_FILE]
    ):
        raise RelabelAuditError("audit safety contract drifted")
    return {
        "gold_evaluation_rows": expected_counts[GOLD_EVAL_FILE],
        "next_pseudo_rows": expected_counts[NEXT_PSEUDO_FILE],
        "output_dir": str(root),
        "priority_rows": expected_counts[PRIORITY_FILE],
        "status": "validated_cpu_only_relabel_audit",
    }


def _add_gold_inputs(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-patch-cache-v1"),
    )
    parser.add_argument(
        "--authority-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1"
        ),
    )
    parser.add_argument(
        "--review-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"),
    )
    parser.add_argument(
        "--draft-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1"),
    )
    parser.add_argument(
        "--legacy-overlay-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy15-train-overlay-v1"),
    )
    parser.add_argument(
        "--human-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v2.json"),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    audit = commands.add_parser("audit")
    audit.add_argument("--pass-dir", type=Path, required=True)
    audit.add_argument("--previous-pseudo", type=Path)
    audit.add_argument("--output-dir", type=Path, required=True)
    _add_gold_inputs(audit)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            reviews, pseudos, pass_validation = load_sealed_pass(args.pass_dir)
            candidate_ids = active_candidate_ids()
            previous, previous_binding = load_previous_pseudo(
                args.previous_pseudo, candidate_ids=candidate_ids
            )
            gold = load_repository_gold(
                cache_dir=args.cache_dir,
                authority_dir=args.authority_dir,
                review_dir=args.review_dir,
                draft_dir=args.draft_dir,
                legacy_overlay_dir=args.legacy_overlay_dir,
                human_catalog_registry=args.human_catalog_registry,
            )
            audited = audit_records(
                reviews, pseudos, gold=gold, previous_top1=previous
            )
            pass_root = args.pass_dir.expanduser().resolve()
            result = write_output(
                args.output_dir,
                audited,
                source_bindings={
                    "pass_dir": str(pass_root),
                    "pass_report_sha256": sha256_file(pass_root / labeler.REPORT),
                    "pass_validation": copy.deepcopy(dict(pass_validation)),
                    "previous_pseudo": previous_binding,
                    "review_predictions_sha256": sha256_file(
                        pass_root / labeler.REVIEW_OUTPUT
                    ),
                    "pseudo_targets_sha256": sha256_file(
                        pass_root / labeler.PSEUDO_OUTPUT
                    ),
                },
                gold_bindings=gold.bindings,
            )
    except (
        RelabelAuditError,
        labeler.MangaFontV7PassError,
        mass21.MangaFontMass21DataError,
        base.MangaFontStudentError,
        OSError,
        ValueError,
    ) as error:
        raise SystemExit(f"manga-font relabel audit error: {error}") from error
    print(canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
