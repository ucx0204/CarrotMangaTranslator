#!/usr/bin/env python3
"""Build a metadata-only human review queue from multiple pseudo-label passes.

The queue is intentionally not a training-label export.  Every source record
must identify itself as ``pseudo_not_gold`` and as training-ineligible.  Test
rows may be reviewed, but their queue records permanently forbid promotion to
training, even after a later human decision.
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
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "font-matching-multistage-review-queue-v1"
RECORD_TYPE = "font_matching_multistage_review_queue_item"
PSEUDO_AUTHORITY = "pseudo_not_gold"
VALID_SPLITS = frozenset({"train", "val", "test"})
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
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
VALID_ROLES = BODY_ROLES | VARIANT_ROLES | {"other"}
VARIANT_CATEGORIES = frozenset(
    {"bubble_edge", "text_free", "ocr_hard", "page_sound", "ocr_anime_region"}
)
ORDINARY_BALLOON_CATEGORIES = frozenset({"ordinary", "bubble", "text_bubble"})
PASS_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
QUEUE_ID_RE = re.compile(r"^fmmrq_[0-9a-f]{24}$")
QUEUE_RECORD_KEYS = frozenset(
    {
        "chapter",
        "chapter_consistency",
        "geometry",
        "label_authority",
        "page",
        "passes",
        "priority",
        "promotion_policy",
        "provenance",
        "queue_id",
        "queue_rank",
        "recommended_top_candidates",
        "record_sha256",
        "record_type",
        "review_round",
        "review_status",
        "sample_id",
        "schema_version",
        "source_category",
        "source_row_index",
        "split",
        "training_eligible",
        "views",
        "work",
    }
)
PASS_EVIDENCE_KEYS = frozenset(
    {
        "candidate_count",
        "direct_reference",
        "label_authority",
        "label_status",
        "none_probability",
        "pass_id",
        "pass_number",
        "ranker_top5",
        "role",
        "selected_font_id",
        "selection_source",
        "source_file",
        "source_file_sha256",
        "source_kind",
        "source_record_sha256",
        "source_review",
        "source_row_index",
        "source_schema_version",
        "style",
        "top1_margin",
        "training_eligible",
        "treatment",
        "view_gate_weights",
    }
)


class MultistageReviewQueueError(ValueError):
    """Raised when a pseudo pass or its master binding is unsafe or ambiguous."""


@dataclass(frozen=True)
class PseudoPassSpec:
    pass_id: str
    path: Path


@dataclass(frozen=True)
class MasterSample:
    row: Mapping[str, Any]
    row_index: int
    row_sha256: str


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise MultistageReviewQueueError(f"cannot hash {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    record = copy.deepcopy(dict(core))
    record.pop("record_sha256", None)
    record["record_sha256"] = sha256_bytes(canonical_json(record).encode("utf-8"))
    return record


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or SHA_RE.fullmatch(expected) is None:
        raise MultistageReviewQueueError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise MultistageReviewQueueError(f"{location}: record seal mismatch")
    return actual


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MultistageReviewQueueError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise MultistageReviewQueueError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise MultistageReviewQueueError(f"{location}: expected text")
    return result


def _finite(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MultistageReviewQueueError(f"{location}: expected finite number")
    result = float(value)
    if not math.isfinite(result):
        raise MultistageReviewQueueError(f"{location}: expected finite number")
    return result


def _probability(value: Any, location: str) -> float:
    result = _finite(value, location)
    if not 0 <= result <= 1:
        raise MultistageReviewQueueError(f"{location}: probability outside [0,1]")
    return result


def _positive_integer(value: Any, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise MultistageReviewQueueError(f"{location}: expected positive integer")
    return value


def _nonnegative_integer(value: Any, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MultistageReviewQueueError(f"{location}: expected nonnegative integer")
    return value


def _iter_jsonl(path: Path) -> Iterable[tuple[int, Mapping[str, Any]]]:
    if path.is_symlink() or not path.is_file():
        raise MultistageReviewQueueError(f"missing or linked JSONL: {path}")
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as error:
        raise MultistageReviewQueueError(f"cannot open {path}: {error}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise MultistageReviewQueueError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            yield line_number, _mapping(value, f"{path}:{line_number}")


def _source_category(row: Mapping[str, Any]) -> str:
    metadata = row.get("metadata")
    if not isinstance(metadata, Mapping):
        return "ordinary"
    value = metadata.get("candidate_primary_category") or metadata.get(
        "candidate_category"
    )
    return str(value) if isinstance(value, str) and value.strip() else "ordinary"


def load_master_manifest(path: Path) -> tuple[dict[str, MasterSample], str]:
    manifest_sha256 = sha256_file(path)
    samples: dict[str, MasterSample] = {}
    for row_index, (line_number, row) in enumerate(_iter_jsonl(path)):
        sample_id = _text(row.get("id"), f"master:{line_number}.id")
        if sample_id in samples:
            raise MultistageReviewQueueError(f"duplicate master sample: {sample_id}")
        split = _text(row.get("split"), f"{sample_id}.split")
        if split not in VALID_SPLITS:
            raise MultistageReviewQueueError(f"{sample_id}: unsupported split")
        for key in ("work", "chapter", "page", "geometry"):
            _mapping(row.get(key), f"{sample_id}.{key}")
        views = _mapping(row.get("views"), f"{sample_id}.views")
        if set(views) != set(VIEW_NAMES):
            raise MultistageReviewQueueError(f"{sample_id}: view inventory drift")
        compact = {
            "chapter": copy.deepcopy(dict(_mapping(row["chapter"], "chapter"))),
            "geometry": copy.deepcopy(dict(_mapping(row["geometry"], "geometry"))),
            "id": sample_id,
            "metadata": {"candidate_primary_category": _source_category(row)},
            "page": copy.deepcopy(dict(_mapping(row["page"], "page"))),
            "split": split,
            "views": copy.deepcopy(dict(views)),
            "work": copy.deepcopy(dict(_mapping(row["work"], "work"))),
        }
        samples[sample_id] = MasterSample(
            row=compact,
            row_index=row_index,
            row_sha256=sha256_bytes(canonical_json(row).encode("utf-8")),
        )
    if not samples:
        raise MultistageReviewQueueError("master manifest is empty")
    if sha256_file(path) != manifest_sha256:
        raise MultistageReviewQueueError("master manifest changed while reading")
    return samples, manifest_sha256


def _normalize_top5(value: Any, *, location: str) -> list[dict[str, Any]]:
    raw_entries = _list(value, location)
    if len(raw_entries) != 5:
        raise MultistageReviewQueueError(f"{location}: expected exactly five ranks")
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    prior_probability = math.inf
    for index, raw_entry in enumerate(raw_entries, 1):
        entry = _mapping(raw_entry, f"{location}[{index - 1}]")
        font_id = _text(entry.get("font_id"), f"{location}[{index - 1}].font_id")
        if font_id in seen:
            raise MultistageReviewQueueError(f"{location}: duplicate font {font_id}")
        seen.add(font_id)
        rank = _positive_integer(entry.get("rank"), f"{location}[{index - 1}].rank")
        if rank != index:
            raise MultistageReviewQueueError(f"{location}: ranks must be 1..5")
        probability = _probability(
            entry.get("probability"), f"{location}[{index - 1}].probability"
        )
        if probability > prior_probability + 1e-12:
            raise MultistageReviewQueueError(f"{location}: probability order drift")
        prior_probability = probability
        entries.append(
            {
                "font_id": font_id,
                "probability": probability,
                "rank": rank,
                "score": _finite(entry.get("score"), f"{location}[{index - 1}].score"),
            }
        )
    return entries


def _normalize_role(value: Any, *, location: str) -> dict[str, Any]:
    role = _mapping(value, location)
    variant_probability = _probability(
        role.get("variant_probability"), f"{location}.variant_probability"
    )
    top3_raw = _list(role.get("top3"), f"{location}.top3")
    if not 1 <= len(top3_raw) <= 3:
        raise MultistageReviewQueueError(
            f"{location}.top3: expected one to three roles"
        )
    top3: list[dict[str, Any]] = []
    seen: set[str] = set()
    prior_confidence = math.inf
    for index, raw_entry in enumerate(top3_raw):
        entry = _mapping(raw_entry, f"{location}.top3[{index}]")
        role_name = _text(entry.get("role"), f"{location}.top3[{index}].role")
        if role_name not in VALID_ROLES or role_name in seen:
            raise MultistageReviewQueueError(f"{location}: invalid/duplicate role")
        seen.add(role_name)
        confidence = _probability(
            entry.get("confidence"), f"{location}.top3[{index}].confidence"
        )
        if confidence > prior_confidence + 1e-12:
            raise MultistageReviewQueueError(f"{location}: role order drift")
        prior_confidence = confidence
        top3.append({"confidence": confidence, "role": role_name})
    return {"top3": top3, "variant_probability": variant_probability}


def _same_master_value(
    pseudo: Mapping[str, Any],
    key: str,
    expected: Any,
    *,
    sample_id: str,
    pass_id: str,
) -> None:
    if key in pseudo and pseudo.get(key) != expected:
        raise MultistageReviewQueueError(
            f"{sample_id}/{pass_id}: pseudo {key} drifted from master"
        )


def _normalize_pass_row(
    row: Mapping[str, Any],
    *,
    spec: PseudoPassSpec,
    master: MasterSample,
    source_file_sha256: str,
    location: str,
) -> dict[str, Any]:
    source_record_sha256 = validate_record_seal(row, location=location)
    if row.get("label_authority") != PSEUDO_AUTHORITY:
        raise MultistageReviewQueueError(
            f"{location}: only pseudo_not_gold input is accepted"
        )
    if row.get("training_eligible") is not False:
        raise MultistageReviewQueueError(
            f"{location}: pseudo source must be training-ineligible"
        )
    sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
    master_row = master.row
    work = _mapping(master_row.get("work"), f"{sample_id}.work")
    chapter = _mapping(master_row.get("chapter"), f"{sample_id}.chapter")
    page = _mapping(master_row.get("page"), f"{sample_id}.page")
    source_category = _source_category(master_row)
    for key, expected in (
        ("split", _text(master_row.get("split"), f"{sample_id}.split")),
        ("work_id", _text(work.get("id"), f"{sample_id}.work.id")),
        ("work_title", _text(work.get("title"), f"{sample_id}.work.title")),
        ("chapter_id", _text(chapter.get("id"), f"{sample_id}.chapter.id")),
        (
            "chapter_title",
            _text(chapter.get("title"), f"{sample_id}.chapter.title"),
        ),
        ("page_id", _text(page.get("id"), f"{sample_id}.page.id")),
        ("page_name", _text(page.get("name"), f"{sample_id}.page.name")),
        ("source_category", source_category),
    ):
        _same_master_value(
            row, key, expected, sample_id=sample_id, pass_id=spec.pass_id
        )
    pass_number = _positive_integer(row.get("pass_number"), f"{location}.pass_number")
    candidate_count = _positive_integer(
        row.get("candidate_count"), f"{location}.candidate_count"
    )
    if candidate_count < 5:
        raise MultistageReviewQueueError(f"{location}: candidate count below top5")
    ranker = _mapping(row.get("ranker"), f"{location}.ranker")
    top5 = _normalize_top5(ranker.get("top5"), location=f"{location}.ranker.top5")
    selected_font_id = _text(
        ranker.get("selected_font_id"), f"{location}.ranker.selected_font_id"
    )
    if selected_font_id != top5[0]["font_id"]:
        raise MultistageReviewQueueError(f"{location}: top1/rank-1 mismatch")
    if "selected_font_id" in row and row.get("selected_font_id") != selected_font_id:
        raise MultistageReviewQueueError(f"{location}: selected font drift")
    margin = _probability(ranker.get("top1_margin"), f"{location}.ranker.top1_margin")
    probability_margin = top5[0]["probability"] - top5[1]["probability"]
    if not math.isclose(margin, probability_margin, rel_tol=0.0, abs_tol=2e-6):
        raise MultistageReviewQueueError(f"{location}: top1 margin drift")
    label_status = _text(row.get("label_status"), f"{location}.label_status")
    if not label_status.startswith("pseudo_"):
        raise MultistageReviewQueueError(f"{location}: non-pseudo label status")
    evidence = {
        "candidate_count": candidate_count,
        "direct_reference": copy.deepcopy(row.get("direct_reference")),
        "label_authority": PSEUDO_AUTHORITY,
        "label_status": label_status,
        "none_probability": _probability(
            row.get("none_probability"), f"{location}.none_probability"
        ),
        "pass_id": spec.pass_id,
        "pass_number": pass_number,
        "ranker_top5": top5,
        "role": _normalize_role(row.get("role"), location=f"{location}.role"),
        "selected_font_id": selected_font_id,
        "selection_source": _text(
            row.get("selection_source"), f"{location}.selection_source"
        ),
        "source_file": spec.path.name,
        "source_file_sha256": source_file_sha256,
        "source_record_sha256": source_record_sha256,
        "source_review": copy.deepcopy(row.get("review")),
        "source_row_index": _nonnegative_integer(
            row.get("source_row_index", master.row_index),
            f"{location}.source_row_index",
        ),
        "source_schema_version": _text(
            row.get("schema_version"), f"{location}.schema_version"
        ),
        "source_kind": _text(row.get("source_kind"), f"{location}.source_kind"),
        "style": copy.deepcopy(row.get("style")),
        "top1_margin": margin,
        "training_eligible": False,
        "treatment": copy.deepcopy(row.get("treatment")),
        "view_gate_weights": copy.deepcopy(row.get("view_gate_weights")),
    }
    return evidence


def load_pseudo_pass(
    spec: PseudoPassSpec, master: Mapping[str, MasterSample]
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if PASS_ID_RE.fullmatch(spec.pass_id) is None:
        raise MultistageReviewQueueError(f"invalid pass id: {spec.pass_id!r}")
    file_sha256 = sha256_file(spec.path)
    rows: dict[str, dict[str, Any]] = {}
    pass_numbers: set[int] = set()
    for line_number, row in _iter_jsonl(spec.path):
        sample_id = _text(row.get("sample_id"), f"{spec.path}:{line_number}.sample_id")
        if sample_id in rows:
            raise MultistageReviewQueueError(
                f"{spec.pass_id}: duplicate pseudo sample {sample_id}"
            )
        master_sample = master.get(sample_id)
        if master_sample is None:
            raise MultistageReviewQueueError(
                f"{spec.pass_id}: unknown master sample {sample_id}"
            )
        evidence = _normalize_pass_row(
            row,
            spec=spec,
            master=master_sample,
            source_file_sha256=file_sha256,
            location=f"{spec.path}:{line_number}",
        )
        pass_numbers.add(int(evidence["pass_number"]))
        rows[sample_id] = evidence
    if not rows:
        raise MultistageReviewQueueError(f"pseudo pass is empty: {spec.path}")
    if len(pass_numbers) != 1:
        raise MultistageReviewQueueError(f"{spec.pass_id}: source mixes pass numbers")
    if sha256_file(spec.path) != file_sha256:
        raise MultistageReviewQueueError(
            f"{spec.pass_id}: pseudo file changed while reading"
        )
    pass_number = next(iter(pass_numbers))
    descriptor = {
        "file": spec.path.name,
        "pass_id": spec.pass_id,
        "pass_number": pass_number,
        "record_count": len(rows),
        "sha256": file_sha256,
    }
    return rows, descriptor


def _recommended_candidates(
    passes: Sequence[Mapping[str, Any]], limit: int
) -> list[dict[str, Any]]:
    stats: defaultdict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "pass_ids": [],
            "probabilities": [],
            "ranks": [],
            "top1_support_count": 0,
        }
    )
    for evidence in passes:
        pass_id = str(evidence["pass_id"])
        selected = str(evidence["selected_font_id"])
        for raw_entry in evidence["ranker_top5"]:
            entry = _mapping(raw_entry, "ranker top5 entry")
            font_id = str(entry["font_id"])
            stat = stats[font_id]
            stat["pass_ids"].append(pass_id)
            stat["probabilities"].append(float(entry["probability"]))
            stat["ranks"].append(int(entry["rank"]))
            stat["top1_support_count"] += int(font_id == selected)
    records = [
        {
            "appearance_count": len(stat["ranks"]),
            "best_rank": min(stat["ranks"]),
            "font_id": font_id,
            "mean_probability": round(
                sum(stat["probabilities"]) / len(stat["probabilities"]), 8
            ),
            "mean_rank": round(sum(stat["ranks"]) / len(stat["ranks"]), 8),
            "supporting_pass_ids": sorted(stat["pass_ids"]),
            "top1_support_count": stat["top1_support_count"],
        }
        for font_id, stat in stats.items()
    ]
    records.sort(
        key=lambda row: (
            -int(row["top1_support_count"]),
            -int(row["appearance_count"]),
            float(row["mean_rank"]),
            -float(row["mean_probability"]),
            str(row["font_id"]),
        )
    )
    return records[:limit]


def _intermediate_state(
    *,
    sample_id: str,
    master: MasterSample,
    passes: Sequence[Mapping[str, Any]],
    all_pass_ids: Sequence[str],
    margin_threshold: float,
    variant_probability_threshold: float,
) -> dict[str, Any]:
    source_category = _source_category(master.row)
    top1_ids = [str(value["selected_font_id"]) for value in passes]
    margins = [float(value["top1_margin"]) for value in passes]
    role_names = [str(value["role"]["top3"][0]["role"]) for value in passes]
    variant_probabilities = [
        float(value["role"]["variant_probability"]) for value in passes
    ]
    present_pass_ids = {str(value["pass_id"]) for value in passes}
    missing = sorted(set(all_pass_ids) - present_pass_ids)
    variant_category = source_category in VARIANT_CATEGORIES
    variant_role = (
        any(role in VARIANT_ROLES for role in role_names)
        or max(variant_probabilities) >= variant_probability_threshold
    )
    top1_disagreement = len(set(top1_ids)) > 1
    min_margin = min(margins)
    stable_role = role_names[0] if len(set(role_names)) == 1 else None
    agreed_font = top1_ids[0] if len(set(top1_ids)) == 1 and not missing else None
    ordinary_balloon = (
        source_category in ORDINARY_BALLOON_CATEGORIES
        and stable_role in BODY_ROLES
        and not variant_role
    )
    return {
        "agreed_font": agreed_font,
        "chapter_font_switch": False,
        "chapter_context": None,
        "min_margin": min_margin,
        "missing_pass_ids": missing,
        "ordinary_balloon": ordinary_balloon,
        "passes": list(passes),
        "role_names": role_names,
        "sample_id": sample_id,
        "source_category": source_category,
        "stable_role": stable_role,
        "top1_disagreement": top1_disagreement,
        "top1_ids": top1_ids,
        "variant_category": variant_category,
        "variant_role": variant_role,
        "variant_probability": max(variant_probabilities),
        "small_margin": min_margin < margin_threshold,
    }


def _apply_chapter_consistency(
    states: Mapping[str, dict[str, Any]],
    master: Mapping[str, MasterSample],
    *,
    margin_threshold: float,
    minimum_support: int,
    minimum_ratio: float,
) -> None:
    votes: defaultdict[tuple[str, str, str], Counter[str]] = defaultdict(Counter)
    totals: Counter[tuple[str, str, str]] = Counter()
    for sample_id, state in states.items():
        if (
            not state["ordinary_balloon"]
            or state["agreed_font"] is None
            or state["min_margin"] < margin_threshold
        ):
            continue
        row = master[sample_id].row
        work_id = str(_mapping(row["work"], "work")["id"])
        chapter_id = str(_mapping(row["chapter"], "chapter")["id"])
        key = (work_id, chapter_id, str(state["stable_role"]))
        votes[key][str(state["agreed_font"])] += 1
        totals[key] += 1
    modes: dict[tuple[str, str, str], tuple[str, int, float]] = {}
    for key, font_votes in votes.items():
        ordered = font_votes.most_common()
        if not ordered or ordered[0][1] < minimum_support:
            continue
        if len(ordered) > 1 and ordered[0][1] == ordered[1][1]:
            continue
        font_id, support = ordered[0]
        ratio = support / totals[key]
        if ratio < minimum_ratio:
            continue
        modes[key] = (font_id, support, ratio)
    for sample_id, state in states.items():
        if not state["ordinary_balloon"] or state["agreed_font"] is None:
            continue
        row = master[sample_id].row
        key = (
            str(_mapping(row["work"], "work")["id"]),
            str(_mapping(row["chapter"], "chapter")["id"]),
            str(state["stable_role"]),
        )
        mode = modes.get(key)
        if mode is None:
            continue
        font_id, support, dominance = mode
        state["chapter_context"] = {
            "baseline_font_id": font_id,
            "baseline_support_count": support,
            "baseline_vote_ratio": round(dominance, 8),
            "body_role": state["stable_role"],
            "confident_ordinary_vote_count": totals[key],
        }
        state["chapter_font_switch"] = state["agreed_font"] != font_id


def _promotion_policy(split: str) -> dict[str, Any]:
    if split == "train":
        reason = "pseudo_not_gold_requires_human_gold_finalization"
    elif split == "val":
        reason = "validation_split_isolation"
    else:
        reason = "test_split_isolation"
    return {
        "direct_pseudo_training_allowed": False,
        "human_review_required": True,
        "post_review_gold_training_promotion_allowed": split == "train",
        "queue_inclusion_allowed": True,
        "test_split_training_promotion_forbidden": split == "test",
        "training_promotion_allowed": False,
        "training_promotion_forbidden_reason": reason,
    }


def _priority(state: Mapping[str, Any], margin_threshold: float) -> dict[str, Any]:
    reasons: list[str] = []
    if state["variant_category"]:
        reasons.append("variant_category")
    if state["variant_role"]:
        reasons.append("variant_role")
    if state["missing_pass_ids"]:
        reasons.append("missing_pseudo_pass")
    if state["top1_disagreement"]:
        reasons.append("cross_pass_top1_disagreement")
    if state["small_margin"]:
        reasons.append("small_top1_margin")
    if state["chapter_font_switch"]:
        reasons.append("ordinary_chapter_font_switch")
    if state["variant_category"] or state["variant_role"]:
        tier = 0
    elif state["top1_disagreement"] or state["missing_pass_ids"]:
        tier = 1
    elif state["small_margin"]:
        tier = 2
    elif state["chapter_font_switch"]:
        tier = 3
    else:
        tier = 4
        reasons.append("routine_consensus_review")
    margin_uncertainty = max(
        0.0, (margin_threshold - float(state["min_margin"])) / margin_threshold
    )
    score = (
        (4 - tier) * 200
        + round(float(state["variant_probability"]) * 100, 6)
        + int(bool(state["top1_disagreement"])) * 50
        + int(bool(state["missing_pass_ids"])) * 25
        + round(margin_uncertainty * 25, 6)
        + int(bool(state["chapter_font_switch"])) * 15
    )
    return {
        "reasons": reasons,
        "score": score,
        "signals": {
            "cross_pass_top1_disagreement": bool(state["top1_disagreement"]),
            "distinct_top1_font_ids": sorted(set(state["top1_ids"])),
            "max_variant_probability": float(state["variant_probability"]),
            "min_top1_margin": float(state["min_margin"]),
            "missing_pass_ids": list(state["missing_pass_ids"]),
            "ordinary_chapter_font_switch": bool(state["chapter_font_switch"]),
            "small_margin_threshold": margin_threshold,
            "small_top1_margin": bool(state["small_margin"]),
            "variant_category": bool(state["variant_category"]),
            "variant_role": bool(state["variant_role"]),
        },
        "tier": tier,
    }


def build_review_queue(
    *,
    master_manifest_path: Path,
    pseudo_pass_specs: Sequence[PseudoPassSpec],
    review_round: int = 1,
    margin_threshold: float = 0.08,
    variant_probability_threshold: float = 0.45,
    chapter_mode_minimum_support: int = 3,
    chapter_mode_minimum_ratio: float = 0.60,
    recommendation_limit: int = 5,
) -> list[dict[str, Any]]:
    if len(pseudo_pass_specs) < 2:
        raise MultistageReviewQueueError("at least two pseudo passes are required")
    if review_round < 1:
        raise MultistageReviewQueueError("review round must be positive")
    if not 0 < margin_threshold <= 1:
        raise MultistageReviewQueueError("margin threshold must be inside (0,1]")
    if not 0 <= variant_probability_threshold <= 1:
        raise MultistageReviewQueueError(
            "variant probability threshold must be inside [0,1]"
        )
    if chapter_mode_minimum_support < 2:
        raise MultistageReviewQueueError("chapter mode needs at least two votes")
    if not 0.5 < chapter_mode_minimum_ratio <= 1:
        raise MultistageReviewQueueError(
            "chapter mode minimum ratio must be inside (0.5,1]"
        )
    if not 1 <= recommendation_limit <= 10:
        raise MultistageReviewQueueError("recommendation limit must be 1..10")
    pass_ids = [spec.pass_id for spec in pseudo_pass_specs]
    if len(pass_ids) != len(set(pass_ids)):
        raise MultistageReviewQueueError("pseudo pass ids must be unique")
    master, master_sha256 = load_master_manifest(master_manifest_path)
    loaded_passes: list[tuple[dict[str, dict[str, Any]], dict[str, Any]]] = []
    pass_numbers: set[int] = set()
    for spec in pseudo_pass_specs:
        rows, descriptor = load_pseudo_pass(spec, master)
        pass_number = int(descriptor["pass_number"])
        if pass_number in pass_numbers:
            raise MultistageReviewQueueError("pseudo passes repeat pass_number")
        pass_numbers.add(pass_number)
        loaded_passes.append((rows, descriptor))
    loaded_passes.sort(
        key=lambda value: (
            int(value[1]["pass_number"]),
            str(value[1]["pass_id"]),
        )
    )
    rows_by_pass = [value[0] for value in loaded_passes]
    pass_descriptors = [value[1] for value in loaded_passes]
    pass_ids = [str(value["pass_id"]) for value in pass_descriptors]
    sample_ids = sorted(set().union(*(set(rows) for rows in rows_by_pass)))
    master = {sample_id: master[sample_id] for sample_id in sample_ids}
    states: dict[str, dict[str, Any]] = {}
    for sample_id in sample_ids:
        passes = [rows[sample_id] for rows in rows_by_pass if sample_id in rows]
        passes.sort(key=lambda row: (int(row["pass_number"]), str(row["pass_id"])))
        states[sample_id] = _intermediate_state(
            sample_id=sample_id,
            master=master[sample_id],
            passes=passes,
            all_pass_ids=pass_ids,
            margin_threshold=margin_threshold,
            variant_probability_threshold=variant_probability_threshold,
        )
    del loaded_passes, rows_by_pass, sample_ids
    _apply_chapter_consistency(
        states,
        master,
        margin_threshold=margin_threshold,
        minimum_support=chapter_mode_minimum_support,
        minimum_ratio=chapter_mode_minimum_ratio,
    )
    prioritization_policy = {
        "chapter_mode_minimum_ratio": chapter_mode_minimum_ratio,
        "chapter_mode_minimum_support": chapter_mode_minimum_support,
        "margin_threshold": margin_threshold,
        "recommendation_limit": recommendation_limit,
        "variant_probability_threshold": variant_probability_threshold,
    }
    input_binding = "\n".join(
        [master_sha256]
        + [f"{row['pass_id']}:{row['sha256']}" for row in pass_descriptors]
        + [canonical_json(prioritization_policy)]
    )
    for state in states.values():
        state["priority"] = _priority(state, margin_threshold)
    ordered_sample_ids = sorted(
        states,
        key=lambda sample_id: (
            int(states[sample_id]["priority"]["tier"]),
            -float(states[sample_id]["priority"]["score"]),
            master[sample_id].row_index,
            sample_id,
        ),
    )
    output: list[dict[str, Any]] = []
    for queue_rank, sample_id in enumerate(ordered_sample_ids, 1):
        state = states.pop(sample_id)
        master_sample = master.pop(sample_id)
        row = master_sample.row
        split = str(row["split"])
        queue_id = (
            "fmmrq_"
            + sha256_bytes(
                f"{sample_id}\0{review_round}\0{input_binding}".encode("utf-8")
            )[:24]
        )
        core = {
            "chapter": copy.deepcopy(dict(_mapping(row["chapter"], "chapter"))),
            "chapter_consistency": copy.deepcopy(state["chapter_context"]),
            "geometry": copy.deepcopy(dict(_mapping(row["geometry"], "geometry"))),
            "label_authority": PSEUDO_AUTHORITY,
            "page": copy.deepcopy(dict(_mapping(row["page"], "page"))),
            "passes": copy.deepcopy(state["passes"]),
            "priority": state["priority"],
            "promotion_policy": _promotion_policy(split),
            "provenance": {
                "authority": PSEUDO_AUTHORITY,
                "gold_supervision": False,
                "master_manifest_file": master_manifest_path.name,
                "master_manifest_sha256": master_sha256,
                "master_row_sha256": master_sample.row_sha256,
                "metadata_only": True,
                "pixels_opened": False,
                "prioritization_policy": copy.deepcopy(prioritization_policy),
                "pseudo_inputs": copy.deepcopy(pass_descriptors),
                "test_split_training_promotion_forbidden": split == "test",
            },
            "queue_id": queue_id,
            "queue_rank": queue_rank,
            "recommended_top_candidates": _recommended_candidates(
                state["passes"], recommendation_limit
            ),
            "record_type": RECORD_TYPE,
            "review_round": review_round,
            "review_status": "pending",
            "sample_id": sample_id,
            "schema_version": SCHEMA_VERSION,
            "source_category": state["source_category"],
            "source_row_index": master_sample.row_index,
            "split": split,
            "training_eligible": False,
            "views": copy.deepcopy(dict(_mapping(row["views"], "views"))),
            "work": copy.deepcopy(dict(_mapping(row["work"], "work"))),
        }
        sealed = seal_record(core)
        validate_queue_record(sealed)
        output.append(sealed)
    return output


def validate_queue_record(record: Mapping[str, Any]) -> dict[str, Any]:
    validate_record_seal(record, location="multistage review queue record")
    if set(record) != QUEUE_RECORD_KEYS:
        raise MultistageReviewQueueError("queue record field inventory drift")
    if (
        record.get("schema_version") != SCHEMA_VERSION
        or record.get("record_type") != RECORD_TYPE
        or record.get("label_authority") != PSEUDO_AUTHORITY
        or record.get("training_eligible") is not False
        or record.get("review_status") != "pending"
    ):
        raise MultistageReviewQueueError("queue authority/status drift")
    split = _text(record.get("split"), "queue.split")
    if split not in VALID_SPLITS:
        raise MultistageReviewQueueError("queue split drift")
    _positive_integer(record.get("queue_rank"), "queue.queue_rank")
    _positive_integer(record.get("review_round"), "queue.review_round")
    queue_id = _text(record.get("queue_id"), "queue.queue_id")
    if QUEUE_ID_RE.fullmatch(queue_id) is None:
        raise MultistageReviewQueueError("queue id drift")
    for key in ("work", "chapter", "page", "geometry", "priority"):
        _mapping(record.get(key), f"queue.{key}")
    views = _mapping(record.get("views"), "queue.views")
    if set(views) != set(VIEW_NAMES):
        raise MultistageReviewQueueError("queue view inventory drift")
    passes = _list(record.get("passes"), "queue.passes")
    if not passes:
        raise MultistageReviewQueueError("queue has no pseudo evidence")
    for index, raw_pass in enumerate(passes):
        evidence = _mapping(raw_pass, f"queue.passes[{index}]")
        if (
            set(evidence) != PASS_EVIDENCE_KEYS
            or evidence.get("label_authority") != PSEUDO_AUTHORITY
            or evidence.get("training_eligible") is not False
        ):
            raise MultistageReviewQueueError("queue pseudo evidence drift")
        for key in ("source_file_sha256", "source_record_sha256"):
            value = evidence.get(key)
            if not isinstance(value, str) or SHA_RE.fullmatch(value) is None:
                raise MultistageReviewQueueError("queue pseudo hash drift")
    recommendations = _list(
        record.get("recommended_top_candidates"), "queue recommendations"
    )
    if not 1 <= len(recommendations) <= 10:
        raise MultistageReviewQueueError("queue recommendation inventory drift")
    promotion = _mapping(record.get("promotion_policy"), "queue promotion policy")
    if dict(promotion) != _promotion_policy(split):
        raise MultistageReviewQueueError("queue promotion policy drift")
    provenance = _mapping(record.get("provenance"), "queue provenance")
    if (
        provenance.get("authority") != PSEUDO_AUTHORITY
        or provenance.get("gold_supervision") is not False
        or provenance.get("metadata_only") is not True
        or provenance.get("pixels_opened") is not False
        or provenance.get("test_split_training_promotion_forbidden")
        is not (split == "test")
    ):
        raise MultistageReviewQueueError("queue provenance boundary drift")
    for key in ("master_manifest_sha256", "master_row_sha256"):
        value = provenance.get(key)
        if not isinstance(value, str) or SHA_RE.fullmatch(value) is None:
            raise MultistageReviewQueueError("queue master provenance hash drift")
    _mapping(
        provenance.get("prioritization_policy"),
        "queue provenance.prioritization_policy",
    )
    pseudo_inputs = _list(
        provenance.get("pseudo_inputs"), "queue provenance.pseudo_inputs"
    )
    if len(pseudo_inputs) < 2:
        raise MultistageReviewQueueError("queue lost multistage provenance")
    input_ids: set[str] = set()
    input_numbers: set[int] = set()
    for index, raw_input in enumerate(pseudo_inputs):
        descriptor = _mapping(raw_input, f"queue pseudo_inputs[{index}]")
        pass_id = _text(descriptor.get("pass_id"), "queue pseudo input pass id")
        pass_number = _positive_integer(
            descriptor.get("pass_number"), "queue pseudo input pass number"
        )
        sha256 = descriptor.get("sha256")
        if (
            pass_id in input_ids
            or pass_number in input_numbers
            or not isinstance(sha256, str)
            or SHA_RE.fullmatch(sha256) is None
        ):
            raise MultistageReviewQueueError("queue pseudo input provenance drift")
        input_ids.add(pass_id)
        input_numbers.add(pass_number)
    return copy.deepcopy(dict(record))


def write_jsonl(
    path: Path, rows: Sequence[Mapping[str, Any]], *, replace_existing: bool
) -> None:
    target = path.expanduser().resolve()
    if path.exists() and path.is_symlink():
        raise MultistageReviewQueueError("refusing linked output")
    if target.exists() and not replace_existing:
        raise MultistageReviewQueueError("output exists; pass --replace-existing")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                validate_queue_record(row)
                handle.write(canonical_json(row) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def parse_pass_spec(value: str) -> PseudoPassSpec:
    pass_id, separator, raw_path = value.partition("=")
    if not separator or PASS_ID_RE.fullmatch(pass_id) is None or not raw_path.strip():
        raise argparse.ArgumentTypeError("expected PASS_ID=PATH")
    return PseudoPassSpec(pass_id=pass_id, path=Path(raw_path))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument(
        "--pseudo-pass",
        type=parse_pass_spec,
        action="append",
        required=True,
        metavar="PASS_ID=PATH",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--review-round", type=int, default=1)
    parser.add_argument("--margin-threshold", type=float, default=0.08)
    parser.add_argument("--variant-probability-threshold", type=float, default=0.45)
    parser.add_argument("--chapter-mode-minimum-support", type=int, default=3)
    parser.add_argument("--chapter-mode-minimum-ratio", type=float, default=0.60)
    parser.add_argument("--recommendation-limit", type=int, default=5)
    parser.add_argument("--replace-existing", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    rows = build_review_queue(
        master_manifest_path=args.master_manifest,
        pseudo_pass_specs=args.pseudo_pass,
        review_round=args.review_round,
        margin_threshold=args.margin_threshold,
        variant_probability_threshold=args.variant_probability_threshold,
        chapter_mode_minimum_support=args.chapter_mode_minimum_support,
        chapter_mode_minimum_ratio=args.chapter_mode_minimum_ratio,
        recommendation_limit=args.recommendation_limit,
    )
    write_jsonl(args.output, rows, replace_existing=args.replace_existing)
    counts = Counter(int(row["priority"]["tier"]) for row in rows)
    split_counts = Counter(str(row["split"]) for row in rows)
    print(
        canonical_json(
            {
                "output_sha256": sha256_file(args.output),
                "priority_tier_counts": dict(sorted(counts.items())),
                "records": len(rows),
                "split_counts": dict(sorted(split_counts.items())),
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MultistageReviewQueueError as error:
        raise SystemExit(f"multistage-review-queue error: {error}") from error
