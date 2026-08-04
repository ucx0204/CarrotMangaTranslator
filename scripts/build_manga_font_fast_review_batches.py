#!/usr/bin/env python3
"""Build fast, named-font, multi-pass review batches for pseudo labels.

This is deliberately a *non-blind* review aid.  It combines the sealed
multi-stage queue with the 22-font render bank, exposes both pseudo passes,
and renders compact contact sheets containing raw/context/glyph views and
named top candidates.  Nothing emitted by this tool is gold or directly
training-eligible; a separate human-finalization step is always required.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    import build_font_matching_multistage_review_queue as queue_builder
    import build_manga_font_student_calibration_review as named_review
    import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_font_matching_multistage_review_queue as queue_builder
    from scripts import build_manga_font_student_calibration_review as named_review
    from scripts import font_matching_catalog_assets as catalog_assets


SCHEMA_VERSION = "manga-font-fast-named-review-batches-v1"
RECORD_TYPE = "manga_font_fast_named_review_item"
REPORT_TYPE = "manga_font_fast_named_review_report"
DECISION_TYPE = "manga_font_fast_named_review_decision_template"
V7_SOURCE_SCHEMA = "manga-font-student-v7-mass21-pass-v1"
HUMAN_GOLD_SCHEMA = "manga-font-fast-review-human-gold-separation-v1"
HUMAN_GOLD_RECORD_TYPE = "manga_font_fast_review_existing_human_gold"
OWNER = "carrot-manga-translator/manga-font-fast-named-review-batches-v1"
MARKER_FILE = ".manga-font-fast-review-owned.json"
REPORT_FILE = "report.json"
README_FILE = "README.txt"
HUMAN_GOLD_FILE = "human-gold-separated.jsonl"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
REVIEW_PASSES = (
    (1, "fast_pick"),
    (2, "prediction_disagreement_recheck"),
    (3, "chapter_and_variant_consistency_recheck"),
)
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ACTIVE21_CANDIDATE_IDS = tuple(
    candidate_id
    for candidate_id in named_review.EXPECTED_CANDIDATE_IDS
    if candidate_id != "gugi"
)
V7_ZERO_LOGIT_INFLUENCE_FIELDS = frozenset(
    {"gemma", "role", "genre", "chapter", "family_prior"}
)


class FastNamedReviewError(ValueError):
    """Raised when review inputs or output boundaries are unsafe."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise FastNamedReviewError(f"could not hash {path}: {error}") from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    declared = record.get("record_sha256")
    if not isinstance(declared, str) or SHA_RE.fullmatch(declared) is None:
        raise FastNamedReviewError(f"{location}: invalid record SHA")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if declared != actual:
        raise FastNamedReviewError(f"{location}: record seal mismatch")
    return actual


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise FastNamedReviewError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise FastNamedReviewError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise FastNamedReviewError(f"{location}: expected text")
    return result


def _safe_relative(value: Any, location: str) -> PurePosixPath:
    text = _text(value, location).replace("\\", "/")
    relative = PurePosixPath(text)
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise FastNamedReviewError(f"{location}: unsafe relative path")
    return relative


def _inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    root = root.resolve()
    path = root.joinpath(*relative.parts).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise FastNamedReviewError(f"{location}: path escapes output") from error
    return path


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise FastNamedReviewError(f"{location}: missing or linked file")
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FastNamedReviewError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _iter_jsonl(path: Path, location: str) -> Iterable[tuple[int, dict[str, Any]]]:
    if path.is_symlink() or not path.is_file():
        raise FastNamedReviewError(f"{location}: missing or linked JSONL")
    try:
        handle = path.open("r", encoding="utf-8-sig")
    except OSError as error:
        raise FastNamedReviewError(f"{location}: cannot open: {error}") from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise FastNamedReviewError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield line_number, dict(_mapping(value, f"{location}:{line_number}"))


def _is_variant(row: Mapping[str, Any]) -> bool:
    priority = _mapping(row.get("priority"), "queue.priority")
    signals = _mapping(priority.get("signals"), "queue.priority.signals")
    return signals.get("variant_category") is True or signals.get("variant_role") is True


def load_and_validate_queue(
    *,
    queue_path: Path,
    master_manifest_path: Path,
    pass1_path: Path,
    pass2_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    input_hashes = {
        "master_manifest": sha256_file(master_manifest_path),
        "pass1": sha256_file(pass1_path),
        "pass2": sha256_file(pass2_path),
        "queue": sha256_file(queue_path),
    }
    expected_passes = {"pass1": input_hashes["pass1"], "pass2": input_hashes["pass2"]}
    rows: list[dict[str, Any]] = []
    sample_ids: set[str] = set()
    queue_ranks: set[int] = set()
    for line_number, row in _iter_jsonl(queue_path, "review queue"):
        location = f"review queue:{line_number}"
        try:
            queue_builder.validate_queue_record(row)
        except queue_builder.MultistageReviewQueueError as error:
            raise FastNamedReviewError(f"{location}: {error}") from error
        sample_id = _text(row.get("sample_id"), f"{location}.sample_id")
        rank = row.get("queue_rank")
        if sample_id in sample_ids or not isinstance(rank, int) or rank in queue_ranks:
            raise FastNamedReviewError(f"{location}: duplicate identity or rank")
        sample_ids.add(sample_id)
        queue_ranks.add(rank)
        provenance = _mapping(row.get("provenance"), f"{location}.provenance")
        if provenance.get("master_manifest_sha256") != input_hashes["master_manifest"]:
            raise FastNamedReviewError(f"{location}: master manifest binding drift")
        pseudo_inputs = _list(
            provenance.get("pseudo_inputs"), f"{location}.provenance.pseudo_inputs"
        )
        actual_passes = {
            _text(value.get("pass_id"), f"{location}.pseudo pass id"): value.get("sha256")
            for value in pseudo_inputs
            if isinstance(value, Mapping)
        }
        if actual_passes != expected_passes:
            raise FastNamedReviewError(f"{location}: pseudo input binding drift")
        if (
            row.get("label_authority") != "pseudo_not_gold"
            or row.get("training_eligible") is not False
        ):
            raise FastNamedReviewError(f"{location}: pseudo authority was elevated")
        rows.append(row)
    if not rows or queue_ranks != set(range(1, len(rows) + 1)):
        raise FastNamedReviewError("review queue ranks are incomplete")
    rows.sort(key=lambda value: (int(value["queue_rank"]), str(value["sample_id"])))
    return rows, input_hashes


def _bounded_float(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise FastNamedReviewError(f"{location}: expected bounded number")
    result = float(value)
    if not 0.0 <= result <= 1.0:
        raise FastNamedReviewError(f"{location}: expected value inside [0,1]")
    return result


def _ordered_ids_sha256(values: Iterable[str]) -> str:
    normalized = sorted(set(values))
    return sha256_bytes(("\n".join(normalized) + "\n").encode("utf-8"))


def validate_v7_prediction(record: Mapping[str, Any], *, location: str) -> None:
    """Validate the visual-only active21 record used by the fast review adapter."""

    validate_record_seal(record, location=location)
    candidate_ids = tuple(str(value) for value in record.get("candidate_ids", ()))
    probabilities = record.get("probabilities")
    if (
        record.get("schema_version") != V7_SOURCE_SCHEMA
        or record.get("label_authority") != "pseudo_not_gold"
        or record.get("training_eligible") is not False
        or record.get("promotion_allowed") is not False
        or candidate_ids != ACTIVE21_CANDIDATE_IDS
        or record.get("candidate_count") != len(ACTIVE21_CANDIDATE_IDS)
        or record.get("gugi_probability") != 0.0
        or not isinstance(probabilities, list)
        or len(probabilities) != len(ACTIVE21_CANDIDATE_IDS)
    ):
        raise FastNamedReviewError(f"{location}: v7 active21 authority drift")
    probability_values = [
        _bounded_float(value, location=f"{location}.probabilities")
        for value in probabilities
    ]
    if abs(sum(probability_values) - 1.0) > 1e-5:
        raise FastNamedReviewError(f"{location}: v7 probability simplex drift")
    influence = _mapping(
        record.get("family_logit_influence"), f"{location}.family_logit_influence"
    )
    if set(influence) != V7_ZERO_LOGIT_INFLUENCE_FIELDS or any(
        float(influence[name]) != 0.0 for name in V7_ZERO_LOGIT_INFLUENCE_FIELDS
    ):
        raise FastNamedReviewError(f"{location}: nonvisual logits influenced v7 labels")
    selected = _text(record.get("selected_font_id"), f"{location}.selected_font_id")
    ranker = _mapping(record.get("ranker"), f"{location}.ranker")
    top5 = _list(ranker.get("top5"), f"{location}.ranker.top5")
    if (
        selected not in ACTIVE21_CANDIDATE_IDS
        or ranker.get("selected_font_id") != selected
        or len(top5) != 5
        or [value.get("rank") for value in top5 if isinstance(value, Mapping)]
        != list(range(1, 6))
        or len(
            {
                value.get("font_id")
                for value in top5
                if isinstance(value, Mapping)
                and value.get("font_id") in ACTIVE21_CANDIDATE_IDS
            }
        )
        != 5
        or top5[0].get("font_id") != selected
    ):
        raise FastNamedReviewError(f"{location}: v7 top5 drift")
    _bounded_float(record.get("entropy"), location=f"{location}.entropy")
    _bounded_float(ranker.get("top1_margin"), location=f"{location}.top1_margin")
    disagreement = _mapping(
        record.get("view_disagreement"), f"{location}.view_disagreement"
    )
    _bounded_float(
        disagreement.get("top1_disagreement"),
        location=f"{location}.view_disagreement.top1_disagreement",
    )


def _chapter_majorities(
    predictions: Sequence[Mapping[str, Any]],
) -> dict[tuple[str, str], dict[str, Any]]:
    counts: dict[tuple[str, str], Counter[str]] = {}
    for row in predictions:
        key = (str(row["work_id"]), str(row["chapter_id"]))
        counts.setdefault(key, Counter())[str(row["selected_font_id"])] += 1
    output: dict[tuple[str, str], dict[str, Any]] = {}
    for key, values in counts.items():
        ordered = sorted(values.items(), key=lambda item: (-item[1], item[0]))
        total = sum(values.values())
        unique_winner = len(ordered) == 1 or ordered[0][1] > ordered[1][1]
        majority_id = ordered[0][0] if unique_winner and ordered[0][1] >= 2 else None
        majority_count = ordered[0][1] if majority_id is not None else 0
        output[key] = {
            "chapter_row_count": total,
            "majority_count": majority_count,
            "majority_font_id": majority_id,
            "majority_share": round(majority_count / total, 8) if total else 0.0,
            "unique_majority": majority_id is not None,
        }
    return output


def _v7_priority(
    prediction: Mapping[str, Any], chapter_consistency: Mapping[str, Any]
) -> dict[str, Any]:
    ranker = _mapping(prediction.get("ranker"), "v7 prediction.ranker")
    disagreement_row = _mapping(
        prediction.get("view_disagreement"), "v7 prediction.view_disagreement"
    )
    entropy = float(prediction["entropy"])
    margin = float(ranker["top1_margin"])
    disagreement = float(disagreement_row["top1_disagreement"])
    margin_uncertainty = 1.0 - min(max(margin, 0.0) / 0.35, 1.0)
    selected = str(prediction["selected_font_id"])
    majority_id = chapter_consistency.get("majority_font_id")
    chapter_outlier = majority_id is not None and selected != majority_id
    source_category = str(prediction.get("source_category", "ordinary"))
    variant_category = source_category != "ordinary"
    score = min(
        1.0,
        0.30 * disagreement
        + 0.30 * entropy
        + 0.25 * margin_uncertainty
        + 0.15 * float(chapter_outlier),
    )
    reasons: list[str] = []
    if chapter_outlier:
        reasons.append("same_chapter_majority_outlier")
    if disagreement > 0.0:
        reasons.append("view_top1_disagreement")
    if entropy >= 0.55:
        reasons.append("high_entropy")
    if margin <= 0.12:
        reasons.append("small_top1_margin")
    if variant_category:
        reasons.append("variant_crop")
    if not reasons:
        reasons.append("routine_consensus_review")
    if chapter_outlier or disagreement >= (1.0 / 3.0 - 1e-6):
        tier = 0
    elif entropy >= 0.65 or margin <= 0.08:
        tier = 1
    elif variant_category:
        tier = 2
    else:
        tier = 3
    return {
        "reasons": reasons,
        "score": round(score, 8),
        "signals": {
            "chapter_majority_font_id": majority_id,
            "chapter_majority_outlier": chapter_outlier,
            "entropy": round(entropy, 8),
            "margin_uncertainty": round(margin_uncertainty, 8),
            "small_top1_margin": margin <= 0.12,
            "top1_margin": round(margin, 8),
            "variant_category": variant_category,
            "variant_role": False,
            "view_js_divergence": disagreement_row.get("js_divergence"),
            "view_top1_disagreement": round(disagreement, 8),
        },
        "tier": tier,
    }


def _review_probe_role(source_category: str) -> str:
    if source_category == "page_sound":
        return "sfx_impact"
    if source_category in {"text_free", "free_near_bubble"}:
        return "emphasis_dialogue"
    return "dialogue"


def _v7_queue_record(
    prediction: Mapping[str, Any],
    master_row: Mapping[str, Any],
    *,
    chapter_consistency: Mapping[str, Any],
    queue_rank: int,
) -> dict[str, Any]:
    sample_id = str(prediction["sample_id"])
    source_category = str(prediction.get("source_category", "ordinary"))
    role = _review_probe_role(source_category)
    metadata = master_row.get("metadata")
    orientation = (
        metadata.get("orientation") if isinstance(metadata, Mapping) else "horizontal"
    )
    writing_mode = "vertical" if orientation == "vertical" else "horizontal"
    ranker = _mapping(prediction.get("ranker"), f"{sample_id}.ranker")
    ranker_top5 = copy.deepcopy(_list(ranker.get("top5"), f"{sample_id}.top5"))
    direct = _mapping(
        prediction.get("direct_reference"), f"{sample_id}.direct_reference"
    )
    direct_selected = str(direct.get("selected_font_id", prediction["selected_font_id"]))
    direct_order: list[str] = []
    disagreement = _mapping(
        prediction.get("view_disagreement"), f"{sample_id}.view_disagreement"
    )
    for value in disagreement.get("top1_candidate_ids", (direct_selected,)):
        candidate_id = str(value)
        if candidate_id in ACTIVE21_CANDIDATE_IDS and candidate_id not in direct_order:
            direct_order.append(candidate_id)
    for value in ranker_top5:
        candidate_id = str(value.get("font_id"))
        if candidate_id not in direct_order:
            direct_order.append(candidate_id)
    direct_top5 = [
        {
            "font_id": candidate_id,
            "probability": None,
            "rank": index,
            "score": None,
        }
        for index, candidate_id in enumerate(direct_order[:5], 1)
    ]
    priority = _v7_priority(prediction, chapter_consistency)
    work = _mapping(master_row.get("work"), f"{sample_id}.work")
    chapter = _mapping(master_row.get("chapter"), f"{sample_id}.chapter")
    page = _mapping(master_row.get("page"), f"{sample_id}.page")
    pass_row = {
        "candidate_count": len(ACTIVE21_CANDIDATE_IDS),
        "direct_reference": {
            "selected_font_id": direct_selected,
            "source": direct.get("source"),
            "top5": direct_top5,
        },
        "entropy": prediction["entropy"],
        "label_authority": "pseudo_not_gold",
        "label_status": prediction.get("label_status"),
        "none_probability": 0.0,
        "pass_id": f"v7-mass21-round-{prediction.get('round')}",
        "pass_number": int(prediction.get("round", 1)),
        "ranker_top5": ranker_top5,
        "role": {
            "source": "review_probe_only_no_logit_influence",
            "top3": [{"confidence": 0.0, "role": role}],
            "variant_probability": 0.0,
        },
        "selected_font_id": prediction["selected_font_id"],
        "style": copy.deepcopy(prediction.get("style")),
        "top1_margin": ranker["top1_margin"],
        "training_eligible": False,
        "treatment": {
            "orientation": {"confidence": 1.0, "value": writing_mode}
        },
        "view_disagreement": copy.deepcopy(disagreement),
    }
    recommendations = [
        {
            "best_rank": value["rank"],
            "font_id": value["font_id"],
            "mean_probability": value["probability"],
        }
        for value in ranker_top5
    ]
    consistency = {
        **copy.deepcopy(dict(chapter_consistency)),
        "outlier": priority["signals"]["chapter_majority_outlier"],
        "selected_font_id": prediction["selected_font_id"],
        "selected_matches_majority": not priority["signals"][
            "chapter_majority_outlier"
        ],
    }
    core = {
        "chapter": {"id": chapter.get("id"), "title": chapter.get("title")},
        "chapter_consistency": consistency,
        "geometry": copy.deepcopy(master_row.get("geometry")),
        "label_authority": "pseudo_not_gold",
        "page": {"id": page.get("id"), "name": page.get("name")},
        "passes": [pass_row],
        "priority": priority,
        "promotion_policy": {"training_promotion_allowed": False},
        "queue_id": f"v7-mass21-review-{sample_id}",
        "queue_rank": queue_rank,
        "recommended_top_candidates": recommendations,
        "sample_id": sample_id,
        "source_category": source_category,
        "source_row_index": prediction.get("source_row_index"),
        "split": prediction["split"],
        "training_eligible": False,
        "v7_prediction_record_sha256": prediction["record_sha256"],
        "views": copy.deepcopy(master_row.get("views")),
        "work": {"id": work.get("id"), "title": work.get("title")},
    }
    return seal_record(core)


def _human_gold_record(
    sample_id: str, prediction: Mapping[str, Any] | None
) -> dict[str, Any]:
    snapshot = None
    if prediction is not None:
        ranker = _mapping(prediction.get("ranker"), f"{sample_id}.ranker")
        snapshot = {
            "entropy": prediction.get("entropy"),
            "prediction_record_sha256": prediction.get("record_sha256"),
            "selected_font_id": prediction.get("selected_font_id"),
            "split": prediction.get("split"),
            "top1_margin": ranker.get("top1_margin"),
            "view_disagreement": copy.deepcopy(prediction.get("view_disagreement")),
        }
    return seal_record(
        {
            "excluded_from_re_review": True,
            "human_authority": "existing_active21_human_supervision",
            "in_v7_master_review": prediction is not None,
            "label_authority": "human_gold_existing",
            "record_type": HUMAN_GOLD_RECORD_TYPE,
            "review_training_eligible": False,
            "sample_id": sample_id,
            "schema_version": HUMAN_GOLD_SCHEMA,
            "v7_prediction_audit": snapshot,
        }
    )


def validate_human_gold_record(record: Mapping[str, Any]) -> None:
    validate_record_seal(record, location="human gold separation")
    if (
        record.get("schema_version") != HUMAN_GOLD_SCHEMA
        or record.get("record_type") != HUMAN_GOLD_RECORD_TYPE
        or record.get("label_authority") != "human_gold_existing"
        or record.get("excluded_from_re_review") is not True
        or record.get("review_training_eligible") is not False
        or not str(record.get("sample_id", "")).strip()
    ):
        raise FastNamedReviewError("human gold separation boundary drift")
    audit = record.get("v7_prediction_audit")
    if audit is not None:
        audit_row = _mapping(audit, "human gold prediction audit")
        selected = audit_row.get("selected_font_id")
        if selected not in ACTIVE21_CANDIDATE_IDS:
            raise FastNamedReviewError("human gold audit retained a non-active candidate")


def load_v7_review_queue(
    *,
    v7_review_path: Path,
    master_manifest_path: Path,
    human_gold_ids: frozenset[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Join v7 predictions to master views and exclude existing human gold."""

    if not human_gold_ids:
        raise FastNamedReviewError("human gold separation set is empty")
    input_hashes: dict[str, Any] = {
        "human_gold_ids": _ordered_ids_sha256(human_gold_ids),
        "master_manifest": sha256_file(master_manifest_path),
        "v7_review": sha256_file(v7_review_path),
    }
    predictions: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for line_number, prediction in _iter_jsonl(v7_review_path, "v7 review"):
        location = f"v7 review:{line_number}"
        validate_v7_prediction(prediction, location=location)
        sample_id = _text(prediction.get("sample_id"), f"{location}.sample_id")
        if sample_id in by_id:
            raise FastNamedReviewError(f"{location}: duplicate sample identity")
        if prediction.get("split") not in {"train", "val", "test"}:
            raise FastNamedReviewError(f"{location}: invalid split")
        by_id[sample_id] = prediction
        predictions.append(prediction)
    if not predictions:
        raise FastNamedReviewError("v7 review input is empty")
    chapter_majorities = _chapter_majorities(predictions)
    gold_rows = [
        _human_gold_record(sample_id, by_id.get(sample_id))
        for sample_id in sorted(human_gold_ids)
    ]
    for row in gold_rows:
        validate_human_gold_record(row)

    pending = {
        sample_id: prediction
        for sample_id, prediction in by_id.items()
        if sample_id not in human_gold_ids
    }
    queue_rows: list[dict[str, Any]] = []
    source_row_index = -1
    for line_number, master_row in _iter_jsonl(master_manifest_path, "master manifest"):
        source_row_index += 1
        sample_id = str(master_row.get("id", ""))
        prediction = pending.pop(sample_id, None)
        if prediction is None:
            continue
        master_sha = sha256_bytes(canonical_json(master_row).encode("utf-8"))
        work = _mapping(master_row.get("work"), f"master:{line_number}.work")
        chapter = _mapping(master_row.get("chapter"), f"master:{line_number}.chapter")
        page = _mapping(master_row.get("page"), f"master:{line_number}.page")
        views = _mapping(master_row.get("views"), f"master:{line_number}.views")
        if (
            prediction.get("master_row_sha256") != master_sha
            or prediction.get("source_row_index") != source_row_index
            or prediction.get("split") != master_row.get("split")
            or prediction.get("work_id") != work.get("id")
            or prediction.get("chapter_id") != chapter.get("id")
            or prediction.get("page_id") != page.get("id")
            or set(views) != set(VIEW_NAMES)
        ):
            raise FastNamedReviewError(
                f"master:{line_number}: v7/master binding drift for {sample_id}"
            )
        chapter_key = (str(work.get("id")), str(chapter.get("id")))
        queue_rows.append(
            _v7_queue_record(
                prediction,
                master_row,
                chapter_consistency=chapter_majorities[chapter_key],
                queue_rank=0,
            )
        )
        if not pending:
            break
    if pending:
        raise FastNamedReviewError(
            f"v7 review rows are absent from master: {sorted(pending)[:5]}"
        )
    if sha256_file(master_manifest_path) != input_hashes["master_manifest"]:
        raise FastNamedReviewError("master manifest changed while joining v7 review")
    queue_rows.sort(
        key=lambda row: (
            int(_mapping(row["priority"], "priority")["tier"]),
            -float(_mapping(row["priority"], "priority")["score"]),
            int(row.get("source_row_index", 0)),
            str(row["sample_id"]),
        )
    )
    ranked_rows: list[dict[str, Any]] = []
    for queue_rank, row in enumerate(queue_rows, 1):
        core = dict(row)
        core.pop("record_sha256", None)
        core["queue_rank"] = queue_rank
        ranked_rows.append(seal_record(core))
    input_hashes["v7_candidate_ids"] = _ordered_ids_sha256(ACTIVE21_CANDIDATE_IDS)
    input_hashes["human_gold_universe_rows"] = len(human_gold_ids)
    input_hashes["human_gold_matched_v7_rows"] = sum(
        sample_id in by_id for sample_id in human_gold_ids
    )
    return ranked_rows, gold_rows, input_hashes


def load_human_gold_id_file(path: Path) -> frozenset[str]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise FastNamedReviewError("human gold ID file is missing or linked")
    values: list[str] = []
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                parsed = stripped
            if isinstance(parsed, Mapping):
                parsed = parsed.get("sample_id")
            sample_id = parsed.strip() if isinstance(parsed, str) else ""
            if not sample_id:
                raise FastNamedReviewError(
                    f"human gold IDs:{line_number}: invalid sample ID"
                )
            values.append(sample_id)
    if len(values) != len(set(values)) or not values:
        raise FastNamedReviewError("human gold ID file is empty or duplicated")
    return frozenset(values)


def load_mass21_human_gold_ids(
    *,
    cache_dir: Path,
    authority_dir: Path,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    human_catalog_registry: Path,
) -> frozenset[str]:
    """Load the exact 675 active21 human-supervised identities."""

    try:
        import train_manga_font_student_v6_mass21_data as mass21
    except ImportError:  # pragma: no cover - repository-root import
        from scripts import train_manga_font_student_v6_mass21_data as mass21

    cache_root = cache_dir.expanduser().resolve()
    mass21.v6.validate_patch_cache(cache_root)
    cache_contract = mass21.base.read_json(
        cache_root / mass21.v6.CACHE_CONTRACT,
        location="v6 mass21 cache contract",
    )
    projection = mass21.candidate_projection(cache_contract.get("candidate_ids", ()))
    human = mass21.load_human_supervision(
        cache_contract=cache_contract,
        authority_dir=authority_dir,
        review_dir=review_dir,
        draft_dir=draft_dir,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=human_catalog_registry,
        projection=projection,
    )
    original = {
        str(_mapping(row, "cached human row").get("sample_id"))
        for row in _list(cache_contract.get("human_train"), "cache human_train")
    }
    additions = {example.sample_id for example in human.addition_examples}
    retired = {example.sample_id for example in human.retired_only_examples}
    values = frozenset(original | additions)
    if (
        len(values) != mass21.SUPERVISED_HUMAN_ROWS
        or len(original) != mass21.ORIGINAL_FULL_ROWS
        or values & retired
        or not values <= human.all_sample_ids
    ):
        raise FastNamedReviewError("active21 human gold identity boundary drift")
    return values


def assign_review_batches(
    rows: Sequence[Mapping[str, Any]],
    *,
    batch_size: int = 5000,
    first_batch_min_variants: int = 5000,
    per_work_cap: int = 800,
    per_chapter_cap: int = 160,
) -> list[list[Mapping[str, Any]]]:
    if batch_size < 1:
        raise FastNamedReviewError("batch_size must be positive")
    if not 0 <= first_batch_min_variants <= batch_size:
        raise FastNamedReviewError("first_batch_min_variants must be inside [0,batch_size]")
    if per_work_cap < 1 or per_chapter_cap < 1:
        raise FastNamedReviewError("work/chapter caps must be positive")
    remaining = list(rows)
    batches: list[list[Mapping[str, Any]]] = []
    available_variants = sum(_is_variant(row) for row in remaining)
    variant_target = min(first_batch_min_variants, batch_size, available_variants)
    while remaining:
        selected: list[Mapping[str, Any]] = []
        selected_ids: set[str] = set()
        work_counts: Counter[str] = Counter()
        chapter_counts: Counter[str] = Counter()

        def take(row: Mapping[str, Any]) -> bool:
            if len(selected) >= batch_size:
                return False
            work_id = _text(_mapping(row.get("work"), "queue.work").get("id"), "work.id")
            chapter_id = _text(
                _mapping(row.get("chapter"), "queue.chapter").get("id"),
                "chapter.id",
            )
            if work_counts[work_id] >= per_work_cap or chapter_counts[chapter_id] >= per_chapter_cap:
                return False
            selected.append(row)
            selected_ids.add(str(row["sample_id"]))
            work_counts[work_id] += 1
            chapter_counts[chapter_id] += 1
            return True

        if not batches and variant_target:
            for row in remaining:
                if _is_variant(row):
                    take(row)
                    if len(selected) >= variant_target:
                        break
            if len(selected) < variant_target:
                raise FastNamedReviewError(
                    "work/chapter caps cannot satisfy the first variant batch; "
                    "increase --per-work-cap or --per-chapter-cap"
                )
        if len(selected) < batch_size:
            for row in remaining:
                if str(row["sample_id"]) in selected_ids:
                    continue
                take(row)
                if len(selected) >= batch_size:
                    break
        if not selected:
            raise FastNamedReviewError("batch caps prevented all remaining rows")
        batches.append(selected)
        remaining = [row for row in remaining if str(row["sample_id"]) not in selected_ids]
    return batches


def _latest_pass(row: Mapping[str, Any]) -> Mapping[str, Any]:
    passes = _list(row.get("passes"), "queue.passes")
    return max(passes, key=lambda value: (int(value["pass_number"]), str(value["pass_id"])))


def _role_and_orientation(row: Mapping[str, Any]) -> tuple[str, str]:
    latest = _latest_pass(row)
    role_rows = _list(_mapping(latest.get("role"), "pass.role").get("top3"), "pass.role.top3")
    role = _text(_mapping(role_rows[0], "pass.role.top3[0]").get("role"), "role")
    orientation = str(
        _mapping(_mapping(latest.get("treatment"), "pass.treatment").get("orientation"), "orientation").get("value")
    )
    return role, "vertical" if orientation == "vertical" else "horizontal"


def _render_descriptor(
    candidate_id: str,
    *,
    role: str,
    writing_mode: str,
    renders: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> dict[str, Any]:
    probe = named_review.ROLE_PROBES.get(role, "dialogue-body")
    render = (
        renders.get((candidate_id, probe, writing_mode))
        or renders.get((candidate_id, probe, "horizontal"))
        or renders.get((candidate_id, probe, "vertical"))
    )
    if render is None:
        raise FastNamedReviewError(f"missing render for {candidate_id}/{probe}")
    artifact = _mapping(render.get("artifact"), "render.artifact")
    return {
        "file": _text(artifact.get("file"), "render.artifact.file"),
        "height": artifact.get("height"),
        "probe_id": probe,
        "sha256": _text(artifact.get("sha256"), "render.artifact.sha256"),
        "width": artifact.get("width"),
        "writing_mode": _text(render.get("writing_mode"), "render.writing_mode"),
    }


def _find_prediction(
    pass_row: Mapping[str, Any], candidate_id: str, source: str
) -> dict[str, Any] | None:
    values = pass_row.get(source)
    if source == "ranker_top5":
        rows = values
        selected = pass_row.get("selected_font_id")
    else:
        direct = _mapping(values, "pass.direct_reference")
        rows = direct.get("top5")
        selected = direct.get("selected_font_id")
    if not isinstance(rows, list):
        return None
    for raw in rows:
        if isinstance(raw, Mapping) and raw.get("font_id") == candidate_id:
            return {
                "probability": raw.get("probability"),
                "rank": raw.get("rank"),
                "score": raw.get("score"),
                "selected": selected == candidate_id,
            }
    return None


def prepare_review_item(
    queue_row: Mapping[str, Any],
    *,
    batch_number: int,
    batch_position: int,
    candidate_limit: int,
    canonical_candidates: Mapping[str, Mapping[str, Any]],
    renders: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> dict[str, Any]:
    if not 1 <= candidate_limit <= 10:
        raise FastNamedReviewError("candidate_limit must be inside [1,10]")
    role, writing_mode = _role_and_orientation(queue_row)
    recommendations = _list(
        queue_row.get("recommended_top_candidates"), "queue.recommended_top_candidates"
    )[:candidate_limit]
    candidates: list[dict[str, Any]] = []
    passes = _list(queue_row.get("passes"), "queue.passes")
    for recommendation in recommendations:
        aggregate = dict(_mapping(recommendation, "queue recommendation"))
        candidate_id = _text(aggregate.get("font_id"), "recommendation.font_id")
        metadata = canonical_candidates.get(candidate_id)
        if metadata is None:
            raise FastNamedReviewError(f"unknown recommended candidate: {candidate_id}")
        predictions = []
        for pass_row in passes:
            predictions.append(
                {
                    "direct": _find_prediction(pass_row, candidate_id, "direct_reference"),
                    "pass_id": pass_row["pass_id"],
                    "pass_number": pass_row["pass_number"],
                    "ranker": _find_prediction(pass_row, candidate_id, "ranker_top5"),
                    "ranker_top1_font_id": pass_row["selected_font_id"],
                }
            )
        candidates.append(
            {
                "aggregate": aggregate,
                "candidate_id": candidate_id,
                "font_label": _text(metadata.get("font_label"), f"{candidate_id}.font_label"),
                "predictions": predictions,
                "render": _render_descriptor(
                    candidate_id, role=role, writing_mode=writing_mode, renders=renders
                ),
            }
        )
    pass_summaries = []
    for pass_row in passes:
        pass_summaries.append(
            {
                "direct_top1_font_id": _mapping(
                    pass_row.get("direct_reference"), "pass.direct_reference"
                ).get("selected_font_id"),
                "none_probability": pass_row.get("none_probability"),
                "pass_id": pass_row.get("pass_id"),
                "pass_number": pass_row.get("pass_number"),
                "ranker_top1_font_id": pass_row.get("selected_font_id"),
                "role": copy.deepcopy(pass_row.get("role")),
                "style": copy.deepcopy(pass_row.get("style")),
                "top1_margin": pass_row.get("top1_margin"),
                "treatment": copy.deepcopy(pass_row.get("treatment")),
            }
        )
    core = {
        "batch_number": batch_number,
        "batch_position": batch_position,
        "candidates": candidates,
        "chapter": copy.deepcopy(queue_row.get("chapter")),
        "chapter_consistency": copy.deepcopy(queue_row.get("chapter_consistency")),
        "label_authority": "pseudo_not_gold",
        "model_suggestions_visible": True,
        "page": copy.deepcopy(queue_row.get("page")),
        "pass_summaries": pass_summaries,
        "priority": copy.deepcopy(queue_row.get("priority")),
        "promotion_allowed": False,
        "queue_id": queue_row.get("queue_id"),
        "queue_rank": queue_row.get("queue_rank"),
        "queue_record_sha256": queue_row.get("record_sha256"),
        "record_type": RECORD_TYPE,
        "review_mode": "named_non_blind_three_pass",
        "role_probe": {"probe_id": named_review.ROLE_PROBES.get(role, "dialogue-body"), "role": role, "writing_mode": writing_mode},
        "sample_id": queue_row.get("sample_id"),
        "schema_version": SCHEMA_VERSION,
        "sheet": None,
        "source": {
            "geometry": copy.deepcopy(queue_row.get("geometry")),
            "source_category": queue_row.get("source_category"),
            "views": copy.deepcopy(queue_row.get("views")),
        },
        "split": queue_row.get("split"),
        "test_split_training_promotion_forbidden": queue_row.get("split") == "test",
        "training_eligible": False,
        "work": copy.deepcopy(queue_row.get("work")),
    }
    return core


def validate_review_item(record: Mapping[str, Any]) -> None:
    validate_record_seal(record, location="review item")
    if (
        record.get("schema_version") != SCHEMA_VERSION
        or record.get("record_type") != RECORD_TYPE
        or record.get("label_authority") != "pseudo_not_gold"
        or record.get("training_eligible") is not False
        or record.get("promotion_allowed") is not False
        or record.get("model_suggestions_visible") is not True
    ):
        raise FastNamedReviewError("review item pseudo boundary drift")
    split = record.get("split")
    if split not in {"train", "val", "test"}:
        raise FastNamedReviewError("review item split drift")
    if record.get("test_split_training_promotion_forbidden") is not (split == "test"):
        raise FastNamedReviewError("review item test isolation drift")
    source = _mapping(record.get("source"), "review item.source")
    if set(_mapping(source.get("views"), "review item.source.views")) != set(VIEW_NAMES):
        raise FastNamedReviewError("review item view inventory drift")
    candidates = _list(record.get("candidates"), "review item.candidates")
    if not candidates or len(candidates) != len(
        {candidate.get("candidate_id") for candidate in candidates if isinstance(candidate, Mapping)}
    ):
        raise FastNamedReviewError("review item candidate inventory drift")


def _decision_template(record: Mapping[str, Any], pass_number: int, purpose: str) -> dict[str, Any]:
    return {
        "acceptable_font_ids": [],
        "confidence": None,
        "decision_status": "pending",
        "label_authority": "pseudo_not_gold",
        "none_acceptable": None,
        "notes": "",
        "promotion_allowed": False,
        "record_type": DECISION_TYPE,
        "review_item_sha256": record["record_sha256"],
        "review_pass": pass_number,
        "review_purpose": purpose,
        "reviewed_at": None,
        "reviewer": None,
        "sample_id": record["sample_id"],
        "schema_version": SCHEMA_VERSION,
        "selected_font_id": None,
        "training_eligible": False,
    }


def _font(size: int, path: Path | None) -> ImageFont.ImageFont:
    if path is not None:
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            pass
    return ImageFont.load_default(size=max(10, size))


def _fit_paste(canvas: Image.Image, source: Image.Image, box: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = box
    fitted = ImageOps.contain(
        source.convert("RGB"),
        (max(1, right - left), max(1, bottom - top)),
        Image.Resampling.LANCZOS,
    )
    canvas.paste(fitted, (left + (right - left - fitted.width) // 2, top + (bottom - top - fitted.height) // 2))
    fitted.close()


def _load_render_image(render_root: Path, descriptor: Mapping[str, Any]) -> Image.Image:
    relative = _safe_relative(descriptor.get("file"), "candidate render file")
    path = _inside(render_root, relative, "candidate render file")
    if path.is_symlink() or not path.is_file() or sha256_file(path) != descriptor.get("sha256"):
        raise FastNamedReviewError(f"candidate render hash mismatch: {relative}")
    try:
        with Image.open(path) as opened:
            opened.load()
            image = opened.convert("RGB")
    except OSError as error:
        raise FastNamedReviewError(f"candidate render decode failed: {relative}") from error
    if image.size != (descriptor.get("width"), descriptor.get("height")):
        image.close()
        raise FastNamedReviewError(f"candidate render size drift: {relative}")
    return image


def _prediction_line(candidate: Mapping[str, Any]) -> str:
    parts: list[str] = []
    for prediction in _list(candidate.get("predictions"), "candidate.predictions"):
        ranker = prediction.get("ranker")
        if isinstance(ranker, Mapping):
            probability = ranker.get("probability")
            shown = f"{float(probability) * 100:.1f}%" if isinstance(probability, (int, float)) else "?"
            parts.append(f"P{prediction['pass_number']} R{ranker.get('rank')} {shown}")
        else:
            parts.append(f"P{prediction['pass_number']} --")
    return " | ".join(parts)


def render_contact_sheets(
    records: Sequence[dict[str, Any]],
    *,
    batch_dir: Path,
    catalog_registry_path: Path,
    render_bank_root: Path,
    canonical_candidates: Mapping[str, Mapping[str, Any]],
    project_root: Path,
    rows_per_sheet: int,
) -> list[dict[str, Any]]:
    if not 1 <= rows_per_sheet <= 48:
        raise FastNamedReviewError("rows_per_sheet must be inside [1,48]")
    resolver = catalog_assets.CatalogAssetResolver(catalog_registry_path)
    font_path = named_review._annotation_font_path(canonical_candidates, project_root)  # noqa: SLF001
    title_font = _font(24, font_path)
    body_font = _font(14, font_path)
    small_font = _font(12, font_path)
    source_width = 420
    cell_width = 248
    row_height = 236
    header_height = 72
    candidate_count = max(len(record["candidates"]) for record in records)
    width = source_width + cell_width * candidate_count
    sheets_dir = batch_dir / "contact-sheets"
    sheets_dir.mkdir(parents=True)
    render_cache: dict[tuple[str, str], Image.Image] = {}
    sheets: list[dict[str, Any]] = []
    try:
        for sheet_number, start in enumerate(range(0, len(records), rows_per_sheet), 1):
            chunk = records[start : start + rows_per_sheet]
            canvas = Image.new("RGB", (width, header_height + row_height * len(chunk)), (245, 247, 250))
            draw = ImageDraw.Draw(canvas)
            draw.text((16, 10), "FAST NAMED FONT REVIEW — NOT GOLD", fill=(24, 28, 36), font=title_font)
            draw.text((16, 43), "raw / context / glyph + visible model suggestions; review all candidates", fill=(150, 38, 38), font=body_font)
            for local_index, record in enumerate(chunk):
                top = header_height + local_index * row_height
                bottom = top + row_height
                draw.rectangle((0, top, width - 1, bottom - 1), outline=(185, 190, 198), width=2)
                reasons = ",".join(record["priority"]["reasons"][:3])
                draw.text((8, top + 5), f"{record['batch_position']:04d} {record['sample_id']}  {reasons}", fill=(25, 29, 36), font=body_font)
                views: dict[str, Image.Image] = {}
                for view_name in VIEW_NAMES:
                    try:
                        with resolver.resolve_view_descriptor(
                            record["source"]["views"][view_name],
                            sample_id=record["sample_id"],
                            view_name=view_name,
                            location=f"{record['sample_id']}.views.{view_name}",
                        ) as resolved:
                            views[view_name] = resolved.image.copy()
                    except catalog_assets.CatalogAssetError as error:
                        raise FastNamedReviewError(str(error)) from error
                _fit_paste(canvas, views["raw_224"], (8, top + 31, 188, bottom - 8))
                _fit_paste(canvas, views["context_224"], (194, top + 31, 302, top + 127))
                _fit_paste(canvas, views["glyph_224"], (306, top + 31, 414, top + 127))
                draw.text((194, top + 136), f"role: {record['role_probe']['role']}", fill=(50, 55, 65), font=small_font)
                draw.text((194, top + 157), f"work: {record['work']['title'][:20]}", fill=(50, 55, 65), font=small_font)
                draw.text((194, top + 178), f"chapter: {record['chapter']['title'][:18]}", fill=(50, 55, 65), font=small_font)
                for image in views.values():
                    image.close()
                for candidate_index, candidate in enumerate(record["candidates"]):
                    left = source_width + candidate_index * cell_width
                    draw.rectangle((left + 3, top + 3, left + cell_width - 4, bottom - 4), fill=(255, 255, 255), outline=(80, 112, 164), width=2)
                    draw.text((left + 8, top + 9), f"#{candidate_index + 1} {candidate['font_label'][:17]}", fill=(18, 24, 34), font=body_font)
                    draw.text((left + 8, top + 31), candidate["candidate_id"][:27], fill=(65, 70, 80), font=small_font)
                    draw.text((left + 8, top + 51), _prediction_line(candidate), fill=(32, 82, 142), font=small_font)
                    render = candidate["render"]
                    cache_key = (str(render["file"]), str(render["sha256"]))
                    if cache_key not in render_cache:
                        render_cache[cache_key] = _load_render_image(render_bank_root, render)
                    _fit_paste(canvas, render_cache[cache_key], (left + 8, top + 75, left + cell_width - 8, bottom - 13))
            relative = f"contact-sheets/sheet-{sheet_number:04d}.png"
            target = batch_dir.joinpath(*PurePosixPath(relative).parts)
            canvas.save(target, format="PNG", optimize=False, compress_level=6)
            canvas.close()
            descriptor = {
                "file": relative,
                "height": header_height + row_height * len(chunk),
                "row_count": len(chunk),
                "sha256": sha256_file(target),
                "width": width,
            }
            sheets.append(descriptor)
            for local_index, record in enumerate(chunk):
                record["sheet"] = {
                    "file": relative,
                    "row_index": local_index,
                    "sha256": descriptor["sha256"],
                }
    finally:
        for image in render_cache.values():
            image.close()
    return sheets


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(canonical_json(row) + "\n")


def _safe_output(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(resolved.anchor)}
    if resolved in forbidden or len(resolved.parts) < 3 or len(resolved.name) < 3:
        raise FastNamedReviewError(f"unsafe output directory: {resolved}")
    return resolved


def _batch_stats(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    signals: Counter[str] = Counter()
    fonts: Counter[str] = Counter()
    splits: Counter[str] = Counter()
    works: Counter[str] = Counter()
    chapters: Counter[str] = Counter()
    for row in rows:
        splits[str(row["split"])] += 1
        works[str(_mapping(row["work"], "work")["id"])] += 1
        chapters[str(_mapping(row["chapter"], "chapter")["id"])] += 1
        for reason in _list(_mapping(row["priority"], "priority").get("reasons"), "priority.reasons"):
            signals[str(reason)] += 1
        candidates = row.get("recommended_top_candidates", row.get("candidates", []))
        if candidates:
            first = candidates[0]
            if isinstance(first, Mapping):
                fonts[str(first.get("font_id", first.get("candidate_id")))] += 1
    return {
        "chapter_count": len(chapters),
        "max_rows_per_chapter": max(chapters.values(), default=0),
        "max_rows_per_work": max(works.values(), default=0),
        "priority_reason_counts": dict(sorted(signals.items())),
        "rows": len(rows),
        "split_counts": dict(sorted(splits.items())),
        "top1_candidate_counts": dict(sorted(fonts.items())),
        "variant_rows": sum(_is_variant(row) for row in rows),
        "work_count": len(works),
    }


def build_review_bundle(
    *,
    master_manifest_path: Path,
    pass1_path: Path,
    pass2_path: Path,
    queue_path: Path,
    catalog_registry_path: Path,
    render_bank_manifest_path: Path,
    output_dir: Path,
    project_root: Path,
    batch_size: int = 5000,
    first_batch_min_variants: int = 5000,
    per_work_cap: int = 800,
    per_chapter_cap: int = 160,
    candidate_limit: int = 5,
    rows_per_sheet: int = 20,
    render_batch_count: int = 1,
    replace_owned_output: bool = False,
) -> dict[str, Any]:
    if render_batch_count < 0:
        raise FastNamedReviewError("render_batch_count must be nonnegative")
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise FastNamedReviewError("output exists; pass --replace-owned-output")
        validate_review_bundle(target, verify_items=False)
    queue_rows, input_hashes = load_and_validate_queue(
        queue_path=queue_path,
        master_manifest_path=master_manifest_path,
        pass1_path=pass1_path,
        pass2_path=pass2_path,
    )
    batches = assign_review_batches(
        queue_rows,
        batch_size=batch_size,
        first_batch_min_variants=first_batch_min_variants,
        per_work_cap=per_work_cap,
        per_chapter_cap=per_chapter_cap,
    )
    canonical_candidates, renders = named_review.load_render_bank(render_bank_manifest_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    batch_reports: list[dict[str, Any]] = []
    try:
        for batch_index, queue_batch in enumerate(batches, 1):
            batch_name = f"batch-{batch_index:03d}"
            batch_dir = staging / "batches" / batch_name
            batch_dir.mkdir(parents=True)
            records = [
                prepare_review_item(
                    row,
                    batch_number=batch_index,
                    batch_position=position,
                    candidate_limit=candidate_limit,
                    canonical_candidates=canonical_candidates,
                    renders=renders,
                )
                for position, row in enumerate(queue_batch, 1)
            ]
            rendered = batch_index <= render_batch_count
            sheets = (
                render_contact_sheets(
                    records,
                    batch_dir=batch_dir,
                    catalog_registry_path=catalog_registry_path,
                    render_bank_root=render_bank_manifest_path.parent,
                    canonical_candidates=canonical_candidates,
                    project_root=project_root,
                    rows_per_sheet=rows_per_sheet,
                )
                if rendered
                else []
            )
            sealed_records = [seal_record(record) for record in records]
            for record in sealed_records:
                validate_review_item(record)
            items_file = batch_dir / "review-items.jsonl"
            _write_jsonl(items_file, sealed_records)
            decision_artifacts: dict[str, dict[str, Any]] = {}
            for pass_number, purpose in REVIEW_PASSES:
                filename = f"review-pass-{pass_number}-{purpose}.template.jsonl"
                path = batch_dir / filename
                _write_jsonl(
                    path,
                    [_decision_template(record, pass_number, purpose) for record in sealed_records],
                )
                decision_artifacts[filename] = {"file": filename, "sha256": sha256_file(path)}
            batch_reports.append(
                {
                    "artifacts": {
                        "review_items": {"file": "review-items.jsonl", "sha256": sha256_file(items_file)},
                        "review_pass_templates": decision_artifacts,
                    },
                    "batch": batch_name,
                    "batch_number": batch_index,
                    "cards_rendered": rendered,
                    "sheets": sheets,
                    "stats": _batch_stats(queue_batch),
                }
            )
        readme = (
            "FAST NAMED FONT REVIEW (pseudo_not_gold)\n\n"
            "1. Open each rendered contact sheet; font names and P1/P2 suggestions are intentionally visible.\n"
            "2. Copy (do not overwrite) review-pass-1-*.template.jsonl and make a quick top choice.\n"
            "3. Recheck model disagreements in pass 2, then chapter/variant consistency in pass 3.\n"
            "4. These files never become training gold automatically. Use a separate human-finalization tool.\n"
            "5. Rebuild with a larger --render-batch-count to materialize later batches.\n"
        )
        (staging / README_FILE).write_text(readme, encoding="utf-8", newline="\n")
        total_stats = _batch_stats(queue_rows)
        report = seal_record(
            {
                "artifacts": {"readme": {"file": README_FILE, "sha256": sha256_file(staging / README_FILE)}},
                "batches": batch_reports,
                "boundary": {
                    "direct_gold_promotion_allowed": False,
                    "label_authority": "pseudo_not_gold",
                    "model_suggestions_visible": True,
                    "review_passes": len(REVIEW_PASSES),
                    "test_split_training_promotion_forbidden": True,
                    "training_eligible_rows": 0,
                },
                "candidate_count": len(named_review.EXPECTED_CANDIDATE_IDS),
                "candidate_ids": list(named_review.EXPECTED_CANDIDATE_IDS),
                "configuration": {
                    "batch_size": batch_size,
                    "candidate_limit": candidate_limit,
                    "first_batch_min_variants": first_batch_min_variants,
                    "per_chapter_cap": per_chapter_cap,
                    "per_work_cap": per_work_cap,
                    "render_batch_count": render_batch_count,
                    "rows_per_sheet": rows_per_sheet,
                },
                "inputs": {
                    **input_hashes,
                    "catalog_registry": sha256_file(catalog_registry_path),
                    "render_bank_manifest": sha256_file(render_bank_manifest_path),
                },
                "record_type": REPORT_TYPE,
                "schema_version": SCHEMA_VERSION,
                "stats": total_stats,
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = {
            "owner": OWNER,
            "report_sha256": sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_review_bundle(staging, verify_items=True)
        if target.exists():
            validate_review_bundle(target, verify_items=False)
            shutil.rmtree(target)
        os.replace(staging, target)
        return validate_review_bundle(target, verify_items=False)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def _load_active21_render_bank(
    manifest_path: Path,
) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str, str], dict[str, Any]]]:
    canonical, renders = named_review.load_render_bank(manifest_path)
    active_canonical = {
        candidate_id: canonical[candidate_id]
        for candidate_id in ACTIVE21_CANDIDATE_IDS
    }
    active_renders = {
        key: value
        for key, value in renders.items()
        if key[0] in active_canonical
    }
    if (
        tuple(active_canonical) != ACTIVE21_CANDIDATE_IDS
        or "gugi" in active_canonical
        or any(key[0] == "gugi" for key in active_renders)
    ):
        raise FastNamedReviewError("active21 render bank projection retained Gugi")
    return active_canonical, active_renders


def build_v7_review_bundle(
    *,
    master_manifest_path: Path,
    v7_review_path: Path,
    human_gold_ids: frozenset[str],
    catalog_registry_path: Path,
    render_bank_manifest_path: Path,
    output_dir: Path,
    project_root: Path,
    batch_size: int = 5000,
    first_batch_min_variants: int = 0,
    per_work_cap: int = 800,
    per_chapter_cap: int = 160,
    candidate_limit: int = 5,
    rows_per_sheet: int = 36,
    render_batch_count: int = 1,
    replace_owned_output: bool = False,
    expected_human_gold_count: int = 675,
) -> dict[str, Any]:
    """Build candidate-5 sheets directly from visual-only v7 predictions."""

    if render_batch_count < 0:
        raise FastNamedReviewError("render_batch_count must be nonnegative")
    if len(human_gold_ids) != expected_human_gold_count:
        raise FastNamedReviewError(
            "human gold set count drifted: "
            f"actual={len(human_gold_ids)} expected={expected_human_gold_count}"
        )
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise FastNamedReviewError("output exists; pass --replace-owned-output")
        validate_review_bundle(target, verify_items=False)
    queue_rows, gold_rows, input_hashes = load_v7_review_queue(
        v7_review_path=v7_review_path,
        master_manifest_path=master_manifest_path,
        human_gold_ids=human_gold_ids,
    )
    if not queue_rows:
        raise FastNamedReviewError("all v7 rows were human gold; no re-review rows remain")
    batches = assign_review_batches(
        queue_rows,
        batch_size=batch_size,
        first_batch_min_variants=first_batch_min_variants,
        per_work_cap=per_work_cap,
        per_chapter_cap=per_chapter_cap,
    )
    canonical_candidates, renders = _load_active21_render_bank(
        render_bank_manifest_path
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    batch_reports: list[dict[str, Any]] = []
    try:
        gold_path = staging / HUMAN_GOLD_FILE
        _write_jsonl(gold_path, gold_rows)
        for batch_index, queue_batch in enumerate(batches, 1):
            batch_name = f"batch-{batch_index:03d}"
            batch_dir = staging / "batches" / batch_name
            batch_dir.mkdir(parents=True)
            records = [
                prepare_review_item(
                    row,
                    batch_number=batch_index,
                    batch_position=position,
                    candidate_limit=candidate_limit,
                    canonical_candidates=canonical_candidates,
                    renders=renders,
                )
                for position, row in enumerate(queue_batch, 1)
            ]
            rendered = batch_index <= render_batch_count
            sheets = (
                render_contact_sheets(
                    records,
                    batch_dir=batch_dir,
                    catalog_registry_path=catalog_registry_path,
                    render_bank_root=render_bank_manifest_path.parent,
                    canonical_candidates=canonical_candidates,
                    project_root=project_root,
                    rows_per_sheet=rows_per_sheet,
                )
                if rendered
                else []
            )
            sealed_records = [seal_record(record) for record in records]
            for record in sealed_records:
                validate_review_item(record)
                if any(
                    candidate.get("candidate_id") == "gugi"
                    for candidate in record["candidates"]
                ):
                    raise FastNamedReviewError("v7 review item retained Gugi")
            items_file = batch_dir / "review-items.jsonl"
            _write_jsonl(items_file, sealed_records)
            decision_artifacts: dict[str, dict[str, Any]] = {}
            for pass_number, purpose in REVIEW_PASSES:
                filename = f"review-pass-{pass_number}-{purpose}.template.jsonl"
                path = batch_dir / filename
                _write_jsonl(
                    path,
                    [
                        _decision_template(record, pass_number, purpose)
                        for record in sealed_records
                    ],
                )
                decision_artifacts[filename] = {
                    "file": filename,
                    "sha256": sha256_file(path),
                }
            batch_reports.append(
                {
                    "artifacts": {
                        "review_items": {
                            "file": "review-items.jsonl",
                            "sha256": sha256_file(items_file),
                        },
                        "review_pass_templates": decision_artifacts,
                    },
                    "batch": batch_name,
                    "batch_number": batch_index,
                    "cards_rendered": rendered,
                    "sheets": sheets,
                    "stats": _batch_stats(queue_batch),
                }
            )
        readme = (
            "V7 ACTIVE21 FAST NAMED FONT REVIEW (pseudo_not_gold)\n\n"
            "1. Each row shows raw/context/glyph source views and five rendered Korean candidates.\n"
            "2. Queue order prioritizes view disagreement, entropy, small margin, and chapter-majority outliers.\n"
            "3. The 675 existing active21 human-gold identities are excluded into human-gold-separated.jsonl.\n"
            "4. Gugi is retired and cannot appear in predictions, candidates, or rendered review cells.\n"
            "5. Role/category selects only the Korean review phrase; it contributes exactly zero font logits.\n"
            "6. Review templates never become training gold without a separate human finalization step.\n"
        )
        (staging / README_FILE).write_text(readme, encoding="utf-8", newline="\n")
        total_stats = _batch_stats(queue_rows)
        report = seal_record(
            {
                "artifacts": {
                    "human_gold_separated": {
                        "file": HUMAN_GOLD_FILE,
                        "rows": len(gold_rows),
                        "sha256": sha256_file(gold_path),
                    },
                    "readme": {
                        "file": README_FILE,
                        "sha256": sha256_file(staging / README_FILE),
                    },
                },
                "batches": batch_reports,
                "boundary": {
                    "direct_gold_promotion_allowed": False,
                    "existing_human_gold_rows_separated": len(gold_rows),
                    "gugi_candidate_rows": 0,
                    "label_authority": "pseudo_not_gold",
                    "model_suggestions_visible": True,
                    "nonvisual_font_logit_influence": {
                        name: 0.0 for name in sorted(V7_ZERO_LOGIT_INFLUENCE_FIELDS)
                    },
                    "re_review_human_gold_rows": 0,
                    "review_passes": len(REVIEW_PASSES),
                    "test_split_training_promotion_forbidden": True,
                    "training_eligible_rows": 0,
                },
                "candidate_count": len(ACTIVE21_CANDIDATE_IDS),
                "candidate_ids": list(ACTIVE21_CANDIDATE_IDS),
                "configuration": {
                    "batch_size": batch_size,
                    "candidate_limit": candidate_limit,
                    "first_batch_min_variants": first_batch_min_variants,
                    "per_chapter_cap": per_chapter_cap,
                    "per_work_cap": per_work_cap,
                    "priority_order": [
                        "view_top1_disagreement",
                        "entropy",
                        "small_top1_margin",
                        "same_chapter_majority_outlier",
                    ],
                    "render_batch_count": render_batch_count,
                    "rows_per_sheet": rows_per_sheet,
                    "source_mode": "v7_mass21_active21",
                },
                "human_gold": {
                    "matched_v7_rows": input_hashes["human_gold_matched_v7_rows"],
                    "re_review_rows": 0,
                    "universe_rows": len(gold_rows),
                },
                "inputs": {
                    **input_hashes,
                    "catalog_registry": sha256_file(catalog_registry_path),
                    "render_bank_manifest": sha256_file(render_bank_manifest_path),
                },
                "record_type": REPORT_TYPE,
                "schema_version": SCHEMA_VERSION,
                "stats": total_stats,
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = {
            "owner": OWNER,
            "report_sha256": sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_review_bundle(staging, verify_items=True)
        if target.exists():
            validate_review_bundle(target, verify_items=False)
            shutil.rmtree(target)
        os.replace(staging, target)
        return validate_review_bundle(target, verify_items=False)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def render_existing_v7_batch(
    *,
    master_manifest_path: Path,
    v7_review_path: Path,
    catalog_registry_path: Path,
    render_bank_manifest_path: Path,
    output_dir: Path,
    project_root: Path,
    batch_number: int,
    expected_human_gold_count: int = 675,
) -> dict[str, Any]:
    """Render exactly the next unrendered batch without rebuilding earlier sheets."""

    root = _safe_output(output_dir)
    if root.is_symlink() or not root.is_dir():
        raise FastNamedReviewError("existing review output is missing or linked")
    before = validate_review_bundle(root, verify_items=True)
    report_path = root / REPORT_FILE
    marker_path = root / MARKER_FILE
    report = _read_json(report_path, "existing v7 review report")
    configuration = _mapping(
        report.get("configuration"), "existing v7 review configuration"
    )
    boundary = _mapping(report.get("boundary"), "existing v7 review boundary")
    inputs = _mapping(report.get("inputs"), "existing v7 review inputs")
    candidate_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
    if (
        configuration.get("source_mode") != "v7_mass21_active21"
        or candidate_ids != ACTIVE21_CANDIDATE_IDS
        or "gugi" in candidate_ids
        or boundary.get("gugi_candidate_rows") != 0
        or boundary.get("label_authority") != "pseudo_not_gold"
        or boundary.get("training_eligible_rows") != 0
        or boundary.get("re_review_human_gold_rows") != 0
        or boundary.get("existing_human_gold_rows_separated")
        != expected_human_gold_count
    ):
        raise FastNamedReviewError("incremental render requires a sealed active21 v7 bundle")
    source_paths = (
        catalog_registry_path,
        master_manifest_path,
        render_bank_manifest_path,
        v7_review_path,
    )
    if any(path.is_symlink() or not path.is_file() for path in source_paths):
        raise FastNamedReviewError("incremental render source is missing or linked")
    expected_inputs = {
        "catalog_registry": sha256_file(catalog_registry_path),
        "master_manifest": sha256_file(master_manifest_path),
        "render_bank_manifest": sha256_file(render_bank_manifest_path),
        "v7_review": sha256_file(v7_review_path),
    }
    if any(inputs.get(name) != digest for name, digest in expected_inputs.items()):
        raise FastNamedReviewError("incremental render source binding drifted")
    rows_per_sheet = int(configuration.get("rows_per_sheet", 0))
    candidate_limit = int(configuration.get("candidate_limit", 0))
    if not 1 <= rows_per_sheet <= 48 or not 1 <= candidate_limit <= 10:
        raise FastNamedReviewError("incremental render configuration drifted")

    raw_batches = _list(report.get("batches"), "existing v7 review batches")
    batches = [
        dict(_mapping(value, f"existing v7 review batch:{index + 1}"))
        for index, value in enumerate(raw_batches)
    ]
    if not 1 <= batch_number <= len(batches):
        raise FastNamedReviewError("incremental batch number is out of range")
    rendered_prefix = 0
    found_unrendered = False
    for index, batch in enumerate(batches, 1):
        expected_name = f"batch-{index:03d}"
        if batch.get("batch_number") != index or batch.get("batch") != expected_name:
            raise FastNamedReviewError("incremental batch order/name drifted")
        rendered = batch.get("cards_rendered")
        if rendered is True:
            if found_unrendered:
                raise FastNamedReviewError("rendered batches are not a contiguous prefix")
            rendered_prefix += 1
        elif rendered is False and batch.get("sheets") == []:
            found_unrendered = True
        else:
            raise FastNamedReviewError("incremental batch materialization state drifted")
    if (
        int(configuration.get("render_batch_count", -1)) != rendered_prefix
        or batch_number != rendered_prefix + 1
    ):
        raise FastNamedReviewError(
            "incremental rendering is restricted to the first unrendered batch"
        )
    selected_batch = batches[batch_number - 1]
    batch_name = str(selected_batch["batch"])
    batch_dir = root / "batches" / batch_name
    contact_dir = batch_dir / "contact-sheets"
    if contact_dir.exists():
        raise FastNamedReviewError("unrendered batch unexpectedly has contact sheets")
    item_descriptor = _mapping(
        _mapping(selected_batch.get("artifacts"), "selected batch artifacts").get(
            "review_items"
        ),
        "selected batch review items",
    )
    item_path = batch_dir / _safe_relative(
        item_descriptor.get("file"), "selected batch review items file"
    )
    loaded = list(_iter_jsonl(item_path, "selected batch review items"))
    expected_rows = int(_mapping(selected_batch.get("stats"), "selected batch stats")["rows"])
    if len(loaded) != expected_rows or expected_rows < 1:
        raise FastNamedReviewError("selected batch row inventory drifted")
    records: list[dict[str, Any]] = []
    for position, (_, raw_record) in enumerate(loaded, 1):
        record = copy.deepcopy(dict(raw_record))
        validate_review_item(record)
        item_candidates = tuple(
            str(candidate.get("candidate_id"))
            for candidate in _list(record.get("candidates"), "selected item candidates")
            if isinstance(candidate, Mapping)
        )
        if (
            record.get("batch_number") != batch_number
            or record.get("batch_position") != position
            or record.get("sheet") is not None
            or len(item_candidates) != candidate_limit
            or not set(item_candidates) <= set(ACTIVE21_CANDIDATE_IDS)
            or "gugi" in item_candidates
            or record.get("label_authority") != "pseudo_not_gold"
            or record.get("training_eligible") is not False
        ):
            raise FastNamedReviewError("selected v7 review item boundary drifted")
        records.append(record)

    canonical_candidates, _renders = _load_active21_render_bank(
        render_bank_manifest_path
    )
    staging = Path(
        tempfile.mkdtemp(prefix=f".{root.name}.{batch_name}.incremental-", dir=root.parent)
    )
    staged_batch = staging / batch_name
    staged_batch.mkdir()
    backup = staging / "backup"
    backup.mkdir()
    contact_published = False
    originals = [
        item_path,
        *(
            batch_dir / str(_mapping(value, "selected review pass artifact")["file"])
            for value in _mapping(
                _mapping(selected_batch["artifacts"], "selected batch artifacts").get(
                    "review_pass_templates"
                ),
                "selected review pass templates",
            ).values()
        ),
        report_path,
        marker_path,
    ]
    try:
        sheets = render_contact_sheets(
            records,
            batch_dir=staged_batch,
            catalog_registry_path=catalog_registry_path,
            render_bank_root=render_bank_manifest_path.parent,
            canonical_candidates=canonical_candidates,
            project_root=project_root,
            rows_per_sheet=rows_per_sheet,
        )
        expected_sheet_count = (expected_rows + rows_per_sheet - 1) // rows_per_sheet
        if len(sheets) != expected_sheet_count or any(
            record.get("sheet") is None for record in records
        ):
            raise FastNamedReviewError("incremental contact-sheet coverage drifted")
        sealed_records = [seal_record(record) for record in records]
        for record in sealed_records:
            validate_review_item(record)
        staged_items = staged_batch / "review-items.jsonl"
        _write_jsonl(staged_items, sealed_records)
        decision_artifacts: dict[str, dict[str, Any]] = {}
        for pass_number, purpose in REVIEW_PASSES:
            filename = f"review-pass-{pass_number}-{purpose}.template.jsonl"
            path = staged_batch / filename
            _write_jsonl(
                path,
                [
                    _decision_template(record, pass_number, purpose)
                    for record in sealed_records
                ],
            )
            decision_artifacts[filename] = {
                "file": filename,
                "sha256": sha256_file(path),
            }
        selected_batch["artifacts"] = {
            "review_items": {
                "file": "review-items.jsonl",
                "sha256": sha256_file(staged_items),
            },
            "review_pass_templates": decision_artifacts,
        }
        selected_batch["cards_rendered"] = True
        selected_batch["sheets"] = sheets
        batches[batch_number - 1] = selected_batch
        report_core = copy.deepcopy(dict(report))
        report_core.pop("record_sha256", None)
        report_core["batches"] = batches
        updated_configuration = dict(configuration)
        updated_configuration["render_batch_count"] = batch_number
        report_core["configuration"] = updated_configuration
        updated_report = seal_record(report_core)
        staged_report = staging / REPORT_FILE
        staged_report.write_bytes(json_bytes(updated_report, pretty=True))
        staged_marker = staging / MARKER_FILE
        staged_marker.write_bytes(
            json_bytes(
                {
                    "owner": OWNER,
                    "report_sha256": sha256_file(staged_report),
                    "safe_replace": True,
                    "schema_version": SCHEMA_VERSION,
                },
                pretty=True,
            )
        )
        for original in originals:
            if original.is_symlink() or not original.is_file():
                raise FastNamedReviewError("incremental replace target drifted")
            shutil.copy2(original, backup / original.name)

        os.replace(staged_batch / "contact-sheets", contact_dir)
        contact_published = True
        os.replace(staged_items, item_path)
        for descriptor in decision_artifacts.values():
            filename = str(descriptor["file"])
            os.replace(staged_batch / filename, batch_dir / filename)
        os.replace(staged_report, report_path)
        os.replace(staged_marker, marker_path)
        validated = validate_review_bundle(root, verify_items=True)
        return {
            **validated,
            "incrementally_rendered_batch": batch_number,
            "new_sheet_count": len(sheets),
            "previous_rendered_batch_count": before["rendered_batch_count"],
            "previous_report_sha256": sha256_file(backup / REPORT_FILE),
        }
    except BaseException:
        if contact_published and contact_dir.is_dir() and not contact_dir.is_symlink():
            shutil.rmtree(contact_dir)
        for original in originals:
            saved = backup / original.name
            if saved.is_file() and not saved.is_symlink():
                os.replace(saved, original)
        try:
            validate_review_bundle(root, verify_items=True)
        except (FastNamedReviewError, OSError):
            pass
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def validate_review_bundle(output_dir: Path, *, verify_items: bool = True) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = _read_json(root / REPORT_FILE, "review report")
    validate_record_seal(report, location="review report")
    if report.get("schema_version") != SCHEMA_VERSION or report.get("record_type") != REPORT_TYPE:
        raise FastNamedReviewError("review report schema drift")
    boundary = _mapping(report.get("boundary"), "review report.boundary")
    if (
        boundary.get("direct_gold_promotion_allowed") is not False
        or boundary.get("label_authority") != "pseudo_not_gold"
        or boundary.get("training_eligible_rows") != 0
        or boundary.get("test_split_training_promotion_forbidden") is not True
    ):
        raise FastNamedReviewError("review report authority boundary drift")
    candidate_ids = tuple(str(value) for value in report.get("candidate_ids", ()))
    if (
        not candidate_ids
        or len(candidate_ids) != len(set(candidate_ids))
        or report.get("candidate_count") != len(candidate_ids)
    ):
        raise FastNamedReviewError("review report candidate inventory drift")
    configuration = _mapping(report.get("configuration"), "review configuration")
    v7_mode = configuration.get("source_mode") == "v7_mass21_active21"
    if v7_mode:
        influence = _mapping(
            boundary.get("nonvisual_font_logit_influence"),
            "review boundary nonvisual influence",
        )
        if (
            candidate_ids != ACTIVE21_CANDIDATE_IDS
            or "gugi" in candidate_ids
            or boundary.get("gugi_candidate_rows") != 0
            or boundary.get("re_review_human_gold_rows") != 0
            or set(influence) != V7_ZERO_LOGIT_INFLUENCE_FIELDS
            or any(float(influence[name]) != 0.0 for name in influence)
        ):
            raise FastNamedReviewError("v7 active21 review boundary drift")
    marker = _read_json(root / MARKER_FILE, "review marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("report_sha256") != sha256_file(root / REPORT_FILE)
    ):
        raise FastNamedReviewError("review marker drift")
    expected_files = {REPORT_FILE, MARKER_FILE, README_FILE}
    report_artifacts = _mapping(report.get("artifacts"), "artifacts")
    readme = _mapping(report_artifacts.get("readme"), "readme")
    if readme.get("sha256") != sha256_file(root / README_FILE):
        raise FastNamedReviewError("review README hash drift")
    human_gold_ids: set[str] = set()
    human_gold_descriptor = report_artifacts.get("human_gold_separated")
    if v7_mode:
        descriptor = _mapping(
            human_gold_descriptor, "human gold separation descriptor"
        )
        relative = _safe_relative(
            descriptor.get("file"), "human gold separation file"
        )
        path = _inside(root, relative, "human gold separation file")
        if (
            relative.as_posix() != HUMAN_GOLD_FILE
            or descriptor.get("sha256") != sha256_file(path)
        ):
            raise FastNamedReviewError("human gold separation artifact drift")
        expected_files.add(relative.as_posix())
        gold_rows = list(_iter_jsonl(path, "human gold separation"))
        if len(gold_rows) != descriptor.get("rows"):
            raise FastNamedReviewError("human gold separation count drift")
        for _, record in gold_rows:
            validate_human_gold_record(record)
            sample_id = _text(record.get("sample_id"), "human gold sample_id")
            if sample_id in human_gold_ids:
                raise FastNamedReviewError("human gold identity duplicated")
            human_gold_ids.add(sample_id)
        human_gold = _mapping(report.get("human_gold"), "review report human_gold")
        if (
            len(human_gold_ids) != human_gold.get("universe_rows")
            or human_gold.get("re_review_rows") != 0
            or boundary.get("existing_human_gold_rows_separated")
            != len(human_gold_ids)
        ):
            raise FastNamedReviewError("human gold separation report drift")
    elif human_gold_descriptor is not None:
        raise FastNamedReviewError("legacy review unexpectedly has human gold artifact")
    total_rows = 0
    sample_ids: set[str] = set()
    for raw_batch in _list(report.get("batches"), "report.batches"):
        batch = _mapping(raw_batch, "report batch")
        batch_name = _text(batch.get("batch"), "report batch name")
        _inside(root, PurePosixPath("batches") / batch_name, "batch root")
        artifacts = _mapping(batch.get("artifacts"), "batch artifacts")
        item_descriptor = _mapping(artifacts.get("review_items"), "review items")
        item_relative = PurePosixPath("batches") / batch_name / _safe_relative(item_descriptor.get("file"), "review items file")
        item_path = _inside(root, item_relative, "review items")
        if item_descriptor.get("sha256") != sha256_file(item_path):
            raise FastNamedReviewError("review items hash drift")
        expected_files.add(item_relative.as_posix())
        pass_templates = _mapping(artifacts.get("review_pass_templates"), "review pass templates")
        if len(pass_templates) != len(REVIEW_PASSES):
            raise FastNamedReviewError("review pass template inventory drift")
        for descriptor in pass_templates.values():
            value = _mapping(descriptor, "review pass template")
            relative = PurePosixPath("batches") / batch_name / _safe_relative(value.get("file"), "review pass file")
            path = _inside(root, relative, "review pass template")
            if value.get("sha256") != sha256_file(path):
                raise FastNamedReviewError("review pass template hash drift")
            expected_files.add(relative.as_posix())
        sheets = _list(batch.get("sheets"), "batch sheets")
        if bool(sheets) is not (batch.get("cards_rendered") is True):
            raise FastNamedReviewError("batch card materialization drift")
        for sheet in sheets:
            descriptor = _mapping(sheet, "batch sheet")
            relative = PurePosixPath("batches") / batch_name / _safe_relative(descriptor.get("file"), "sheet file")
            path = _inside(root, relative, "sheet")
            if descriptor.get("sha256") != sha256_file(path):
                raise FastNamedReviewError("review sheet hash drift")
            expected_files.add(relative.as_posix())
        if verify_items:
            rows = list(_iter_jsonl(item_path, "review items"))
            if len(rows) != _mapping(batch.get("stats"), "batch stats").get("rows"):
                raise FastNamedReviewError("batch item count drift")
            for _, record in rows:
                validate_review_item(record)
                sample_id = _text(record.get("sample_id"), "review item sample_id")
                if sample_id in sample_ids or sample_id in human_gold_ids:
                    raise FastNamedReviewError("review item duplicated across batches")
                item_candidates = {
                    str(candidate.get("candidate_id"))
                    for candidate in _list(record.get("candidates"), "item candidates")
                    if isinstance(candidate, Mapping)
                }
                if not item_candidates <= set(candidate_ids) or (
                    v7_mode and "gugi" in item_candidates
                ):
                    raise FastNamedReviewError("review item candidate escaped report vocabulary")
                sample_ids.add(sample_id)
            total_rows += len(rows)
        else:
            total_rows += int(_mapping(batch.get("stats"), "batch stats")["rows"])
    actual_files = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    if actual_files != expected_files:
        raise FastNamedReviewError(
            f"review bundle exact inventory drift; missing={sorted(expected_files - actual_files)[:5]}, unexpected={sorted(actual_files - expected_files)[:5]}"
        )
    expected_total = int(_mapping(report.get("stats"), "report stats")["rows"])
    if total_rows != expected_total or (verify_items and len(sample_ids) != expected_total):
        raise FastNamedReviewError("review bundle total row count drift")
    return {
        "batch_count": len(report["batches"]),
        "first_batch_variant_rows": report["batches"][0]["stats"]["variant_rows"],
        "human_gold_separated_rows": len(human_gold_ids),
        "output_dir": str(root),
        "record_count": expected_total,
        "rendered_batch_count": sum(batch["cards_rendered"] for batch in report["batches"]),
        "status": "ready_for_fast_named_multi_pass_review",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build")
    build.add_argument("--master-manifest", type=Path, required=True)
    build.add_argument("--pass1", type=Path, required=True)
    build.add_argument("--pass2", type=Path, required=True)
    build.add_argument("--queue", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--render-bank-manifest", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--project-root", type=Path, default=Path("."))
    build.add_argument("--batch-size", type=int, default=5000)
    build.add_argument("--first-batch-min-variants", type=int, default=5000)
    build.add_argument("--per-work-cap", type=int, default=800)
    build.add_argument("--per-chapter-cap", type=int, default=160)
    build.add_argument("--candidate-limit", type=int, default=5)
    build.add_argument("--rows-per-sheet", type=int, default=20)
    build.add_argument("--render-batch-count", type=int, default=1)
    build.add_argument("--replace-owned-output", action="store_true")
    build_v7 = subparsers.add_parser("build-v7")
    build_v7.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
    build_v7.add_argument("--v7-review", type=Path, required=True)
    build_v7.add_argument(
        "--catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    build_v7.add_argument(
        "--render-bank-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v2/manifest.json"),
    )
    build_v7.add_argument("--output-dir", type=Path, required=True)
    build_v7.add_argument("--project-root", type=Path, default=Path("."))
    build_v7.add_argument("--batch-size", type=int, default=5000)
    build_v7.add_argument("--first-batch-min-variants", type=int, default=0)
    build_v7.add_argument("--per-work-cap", type=int, default=800)
    build_v7.add_argument("--per-chapter-cap", type=int, default=160)
    build_v7.add_argument("--candidate-limit", type=int, default=5)
    build_v7.add_argument("--rows-per-sheet", type=int, default=36)
    build_v7.add_argument("--render-batch-count", type=int, default=1)
    build_v7.add_argument("--replace-owned-output", action="store_true")
    build_v7.add_argument(
        "--human-gold-ids",
        type=Path,
        help="optional JSONL/plain-text set; must contain the exact 675 active21 gold IDs",
    )
    build_v7.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v6-patch-cache-v1"),
    )
    build_v7.add_argument(
        "--authority-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-full22-authority-all160-v1"
        ),
    )
    build_v7.add_argument(
        "--review-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-review-variant160-v1"
        ),
    )
    build_v7.add_argument(
        "--draft-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-legacy-new7-expansion-visual-draft-all160-v1"
        ),
    )
    build_v7.add_argument(
        "--legacy-overlay-dir",
        type=Path,
        default=Path("artifacts/manga-font-legacy15-train-overlay-v1"),
    )
    build_v7.add_argument(
        "--human-catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v2.json"),
    )
    incremental_v7 = subparsers.add_parser("render-existing-v7-batch")
    incremental_v7.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
    incremental_v7.add_argument("--v7-review", type=Path, required=True)
    incremental_v7.add_argument(
        "--catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    incremental_v7.add_argument(
        "--render-bank-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v2/manifest.json"),
    )
    incremental_v7.add_argument("--output-dir", type=Path, required=True)
    incremental_v7.add_argument("--project-root", type=Path, default=Path("."))
    incremental_v7.add_argument("--batch-number", type=int, required=True)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    validate.add_argument("--skip-item-scan", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "build":
        result = build_review_bundle(
            master_manifest_path=args.master_manifest,
            pass1_path=args.pass1,
            pass2_path=args.pass2,
            queue_path=args.queue,
            catalog_registry_path=args.catalog_registry,
            render_bank_manifest_path=args.render_bank_manifest,
            output_dir=args.output_dir,
            project_root=args.project_root.resolve(),
            batch_size=args.batch_size,
            first_batch_min_variants=args.first_batch_min_variants,
            per_work_cap=args.per_work_cap,
            per_chapter_cap=args.per_chapter_cap,
            candidate_limit=args.candidate_limit,
            rows_per_sheet=args.rows_per_sheet,
            render_batch_count=args.render_batch_count,
            replace_owned_output=args.replace_owned_output,
        )
    elif args.command == "build-v7":
        human_gold_ids = (
            load_human_gold_id_file(args.human_gold_ids)
            if args.human_gold_ids is not None
            else load_mass21_human_gold_ids(
                cache_dir=args.cache_dir,
                authority_dir=args.authority_dir,
                review_dir=args.review_dir,
                draft_dir=args.draft_dir,
                legacy_overlay_dir=args.legacy_overlay_dir,
                human_catalog_registry=args.human_catalog_registry,
            )
        )
        result = build_v7_review_bundle(
            master_manifest_path=args.master_manifest,
            v7_review_path=args.v7_review,
            human_gold_ids=human_gold_ids,
            catalog_registry_path=args.catalog_registry,
            render_bank_manifest_path=args.render_bank_manifest,
            output_dir=args.output_dir,
            project_root=args.project_root.resolve(),
            batch_size=args.batch_size,
            first_batch_min_variants=args.first_batch_min_variants,
            per_work_cap=args.per_work_cap,
            per_chapter_cap=args.per_chapter_cap,
            candidate_limit=args.candidate_limit,
            rows_per_sheet=args.rows_per_sheet,
            render_batch_count=args.render_batch_count,
            replace_owned_output=args.replace_owned_output,
        )
    elif args.command == "render-existing-v7-batch":
        result = render_existing_v7_batch(
            master_manifest_path=args.master_manifest,
            v7_review_path=args.v7_review,
            catalog_registry_path=args.catalog_registry,
            render_bank_manifest_path=args.render_bank_manifest,
            output_dir=args.output_dir,
            project_root=args.project_root.resolve(),
            batch_number=args.batch_number,
        )
    else:
        result = validate_review_bundle(
            args.output_dir, verify_items=not args.skip_item_scan
        )
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FastNamedReviewError as error:
        raise SystemExit(f"fast-named-review error: {error}") from error
