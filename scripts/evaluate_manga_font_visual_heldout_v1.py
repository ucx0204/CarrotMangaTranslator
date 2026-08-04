#!/usr/bin/env python3
"""Read-only A/B evaluator for visual-reviewed font decisions.

The held-out rows are model-visible, non-independent visual QA decisions.  They
must never be described as human gold or used as training supervision.  This
tool compares two sealed active21 relabel passes and reports corrections,
confirmations, and unresolved review rows separately.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts import audit_manga_font_student_v7_mass21_relabel as audit
    from scripts import build_manga_font_fast_review_batches as review
    from scripts import build_manga_font_visual_pseudo_overlay_v1 as visual
except ImportError:  # pragma: no cover - direct execution from scripts/
    import audit_manga_font_student_v7_mass21_relabel as audit
    import build_manga_font_fast_review_batches as review
    import build_manga_font_visual_pseudo_overlay_v1 as visual


SCHEMA = "manga-font-visual-heldout-evaluation-v1"
REPORT_SCHEMA = "manga-font-visual-heldout-evaluation-report-v1"
MANIFEST_SCHEMA = "manga-font-visual-heldout-evaluation-manifest-v1"
ROW_SCHEMA = "manga-font-visual-heldout-comparison-row-v1"
OWNER = "carrot-manga-translator/manga-font-visual-heldout-evaluation-v1"
MARKER_FILE = ".manga-font-visual-heldout-evaluation-v1-owned.json"
ROWS_FILE = "evaluation-rows.jsonl"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset({MARKER_FILE, ROWS_FILE, MANIFEST_FILE, REPORT_FILE})
QA_AUTHORITY = "visual_reviewed_qa_only_not_independent_gold"
EXPECTED_HELDOUT_ROWS = 365
ZERO_INFLUENCE_FIELDS = frozenset(
    {"gemma", "role", "genre", "chapter", "family_prior"}
)


class VisualHeldoutEvaluationError(ValueError):
    """Raised when a comparison crosses a sealed identity/authority boundary."""


@dataclass(frozen=True)
class HeldoutDecision:
    sample_id: str
    split: str
    cohort: str
    decision_kind: str
    review_item_sha256: str
    reviewed_font_ids: tuple[str, ...]
    selected_font_id: str | None
    acceptable_font_ids: tuple[str, ...]
    source_top1_font_id: str
    decision_sha256: str
    role: str
    source_category: str


@dataclass(frozen=True)
class Prediction:
    sample_id: str
    split: str
    work_id: str
    chapter_id: str
    page_id: str
    master_row_sha256: str
    source_category: str
    source_kind: str
    source_row_index: int
    candidate_ids: tuple[str, ...]
    probabilities: tuple[float, ...]
    ranking: tuple[str, ...]
    record_sha256: str


def canonical_json(value: Any) -> str:
    return visual.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return visual.json_bytes(value, pretty=pretty)


def sha256_file(path: Path) -> str:
    return visual.sha256_file(path)


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    return visual.seal_record(core)


def validate_record_seal(row: Mapping[str, Any], *, location: str) -> None:
    try:
        visual.validate_record_seal(row, location=location)
    except visual.VisualPseudoOverlayError as error:
        raise VisualHeldoutEvaluationError(str(error)) from error


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise VisualHeldoutEvaluationError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise VisualHeldoutEvaluationError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise VisualHeldoutEvaluationError(f"{location}: expected text")
    return result


def _iter_jsonl(path: Path, location: str) -> Iterable[tuple[int, dict[str, Any]]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise VisualHeldoutEvaluationError(f"{location}: missing or linked file")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise VisualHeldoutEvaluationError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield line_number, dict(_mapping(row, f"{location}:{line_number}"))


def _active_ids() -> tuple[str, ...]:
    values = audit.active_candidate_ids()
    if len(values) != 21 or "gugi" in values:
        raise VisualHeldoutEvaluationError("active21/Gugi contract drifted")
    return values


def _load_review_evidence(
    review_root: Path,
    *,
    expected_report_sha256: str,
    wanted_ids: set[str],
) -> tuple[dict[str, Mapping[str, Any]], Mapping[str, Any]]:
    root = review_root.expanduser().resolve()
    report_path = root / review.REPORT_FILE
    if sha256_file(report_path) != expected_report_sha256:
        raise VisualHeldoutEvaluationError("heldout review report binding drifted")
    report = _mapping(json.loads(report_path.read_text(encoding="utf-8")), "review report")
    try:
        review.validate_record_seal(report, location="review report")
    except review.FastNamedReviewError as error:
        raise VisualHeldoutEvaluationError(str(error)) from error
    if tuple(report.get("candidate_ids", ())) != _active_ids():
        raise VisualHeldoutEvaluationError("heldout review is not active21")
    found: dict[str, Mapping[str, Any]] = {}
    item_files: list[dict[str, Any]] = []
    for raw_batch in _list(report.get("batches"), "review batches"):
        batch = _mapping(raw_batch, "review batch")
        name = _text(batch.get("batch"), "review batch name")
        descriptor = _mapping(
            _mapping(batch.get("artifacts"), "review batch artifacts").get(
                "review_items"
            ),
            "review item descriptor",
        )
        path = root / "batches" / name / _text(
            descriptor.get("file"), "review item file"
        )
        if sha256_file(path) != descriptor.get("sha256"):
            raise VisualHeldoutEvaluationError("review item file binding drifted")
        item_files.append(
            {"file": str(path), "sha256": descriptor["sha256"]}
        )
        for line_number, row in _iter_jsonl(path, f"{name} review items"):
            sample_id = str(row.get("sample_id", ""))
            if sample_id not in wanted_ids:
                continue
            try:
                review.validate_review_item(row)
            except review.FastNamedReviewError as error:
                raise VisualHeldoutEvaluationError(
                    f"{name}:{line_number}: {error}"
                ) from error
            if sample_id in found:
                raise VisualHeldoutEvaluationError("heldout review identity duplicated")
            found[sample_id] = row
    if set(found) != wanted_ids:
        missing = sorted(wanted_ids - set(found))[:5]
        raise VisualHeldoutEvaluationError(f"heldout review items missing: {missing}")
    return found, {
        "file": str(root),
        "item_files": item_files,
        "report_sha256": expected_report_sha256,
    }


def _load_heldout(
    heldout_path: Path,
    *,
    expected_row_count: int,
) -> tuple[dict[str, HeldoutDecision], Mapping[str, Any]]:
    source = heldout_path.expanduser().resolve()
    if source.name != visual.HELDOUT_FILE:
        raise VisualHeldoutEvaluationError(
            "heldout input must be heldout-visual-decisions.jsonl"
        )
    try:
        validation = visual.validate_output(source.parent)
    except (visual.VisualPseudoOverlayError, OSError, KeyError, ValueError) as error:
        raise VisualHeldoutEvaluationError(f"heldout artifact failed: {error}") from error
    manifest = _mapping(
        json.loads((source.parent / visual.MANIFEST_FILE).read_text(encoding="utf-8")),
        "heldout manifest",
    )
    review_binding = _mapping(
        _mapping(manifest.get("inputs"), "heldout inputs").get("review"),
        "heldout review binding",
    )
    raw_rows = [row for _, row in _iter_jsonl(source, "heldout decisions")]
    if len(raw_rows) != expected_row_count:
        raise VisualHeldoutEvaluationError(
            f"heldout row count {len(raw_rows)} != expected {expected_row_count}"
        )
    wanted_ids = {
        _text(row.get("sample_id"), "heldout sample_id") for row in raw_rows
    }
    if len(wanted_ids) != len(raw_rows):
        raise VisualHeldoutEvaluationError("heldout sample identity duplicated")
    review_rows, review_source = _load_review_evidence(
        Path(_text(review_binding.get("file"), "heldout review path")),
        expected_report_sha256=_text(
            review_binding.get("report_sha256"), "heldout review report SHA"
        ),
        wanted_ids=wanted_ids,
    )
    output: dict[str, HeldoutDecision] = {}
    counts: Counter[str] = Counter()
    for index, raw in enumerate(raw_rows, 1):
        validate_record_seal(raw, location=f"heldout:{index}")
        if (
            raw.get("schema_version") != visual.HELDOUT_SCHEMA
            or raw.get("label_authority") != visual.AUTHORITY
            or raw.get("evaluation_authority") != QA_AUTHORITY
            or raw.get("training_eligible") is not False
            or raw.get("promotion_allowed") is not False
        ):
            raise VisualHeldoutEvaluationError("heldout QA authority drifted")
        sample_id = str(raw["sample_id"])
        source_item = review_rows[sample_id]
        candidates = tuple(
            _text(
                _mapping(value, "review candidate").get("candidate_id"),
                "review candidate id",
            )
            for value in _list(source_item.get("candidates"), "review candidates")
        )
        reviewed = tuple(str(value) for value in raw.get("reviewed_font_ids", ()))
        source_top1 = _text(
            _mapping(
                _list(source_item.get("pass_summaries"), "review summaries")[-1],
                "review summary",
            ).get("ranker_top1_font_id"),
            "review source top1",
        )
        split = _text(source_item.get("split"), "review split")
        if (
            raw.get("review_item_sha256") != source_item.get("record_sha256")
            or reviewed != candidates
            or len(reviewed) != 5
            or raw.get("source_current_top1_font_id") != source_top1
            or raw.get("split") != split
        ):
            raise VisualHeldoutEvaluationError(
                f"heldout {sample_id} review-item binding drifted"
            )
        exclusion = raw.get("exclusion_reason")
        if exclusion == "existing_human_supervision_overlap":
            if split != "train":
                raise VisualHeldoutEvaluationError("human overlap is not train split")
            cohort = "human_overlap"
        elif exclusion == "non_train_split" and split in {"val", "test"}:
            cohort = split
        else:
            raise VisualHeldoutEvaluationError("heldout exclusion/split drifted")
        kind = _text(raw.get("decision_kind"), "heldout decision kind")
        if kind not in {"correction", "confirmed", "review_needed"}:
            raise VisualHeldoutEvaluationError("unknown heldout decision kind")
        selected = raw.get("selected_font_id")
        if selected is not None and selected not in reviewed:
            raise VisualHeldoutEvaluationError("heldout selected font was not visible")
        acceptable = tuple(str(value) for value in raw.get("acceptable_font_ids", ()))
        if not set(acceptable) <= set(reviewed):
            raise VisualHeldoutEvaluationError("heldout acceptable font was not visible")
        if kind == "confirmed" and selected != source_top1:
            raise VisualHeldoutEvaluationError("confirmed row did not confirm baseline top1")
        if kind == "correction" and (selected is None or selected == source_top1):
            raise VisualHeldoutEvaluationError("correction row did not change baseline top1")
        if kind == "review_needed" and selected is not None:
            raise VisualHeldoutEvaluationError("review-needed row has a selected font")
        role_probe = _mapping(source_item.get("role_probe"), "review role probe")
        source_block = _mapping(source_item.get("source"), "review source")
        output[sample_id] = HeldoutDecision(
            sample_id=sample_id,
            split=split,
            cohort=cohort,
            decision_kind=kind,
            review_item_sha256=str(source_item["record_sha256"]),
            reviewed_font_ids=reviewed,
            selected_font_id=selected,
            acceptable_font_ids=acceptable,
            source_top1_font_id=source_top1,
            decision_sha256=_text(raw.get("decision_sha256"), "decision SHA"),
            role=_text(role_probe.get("role"), "review role"),
            source_category=_text(
                source_block.get("source_category"), "review source category"
            ),
        )
        counts[f"cohort_{cohort}"] += 1
        counts[f"kind_{kind}"] += 1
    return output, {
        "file": str(source),
        "row_count": len(output),
        "sha256": sha256_file(source),
        "overlay_validation": dict(validation),
        "review_source": review_source,
        "counts": dict(counts),
    }


def _load_pass(
    review_predictions: Path,
    *,
    wanted_ids: set[str],
    name: str,
) -> tuple[dict[str, Prediction], Mapping[str, Any]]:
    source = review_predictions.expanduser().resolve()
    if source.name != audit.labeler.REVIEW_OUTPUT:
        raise VisualHeldoutEvaluationError(
            f"{name}: input must be review-predictions.jsonl"
        )
    root = source.parent
    report_path = root / audit.labeler.REPORT
    marker_path = root / audit.labeler.MARKER
    report = _mapping(json.loads(report_path.read_text(encoding="utf-8")), f"{name} report")
    marker = _mapping(json.loads(marker_path.read_text(encoding="utf-8")), f"{name} marker")
    try:
        audit.labeler.validate_record_seal(report, location=f"{name} report")
        audit.labeler.validate_record_seal(marker, location=f"{name} marker")
    except audit.labeler.MangaFontV7PassError as error:
        raise VisualHeldoutEvaluationError(str(error)) from error
    candidate_ids = _active_ids()
    artifacts = _mapping(report.get("artifacts"), f"{name} artifacts")
    descriptor = _mapping(
        artifacts.get("review_predictions"), f"{name} review descriptor"
    )
    authority = _mapping(report.get("authority"), f"{name} authority")
    influence = _mapping(
        report.get("nonvisual_logit_influence"), f"{name} nonvisual influence"
    )
    if (
        marker.get("owner") != audit.labeler.OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != audit.labeler.SCHEMA
        or report.get("schema_version") != audit.labeler.REPORT_SCHEMA
        or report.get("marker_record_sha256") != marker.get("record_sha256")
        or tuple(report.get("candidate_ids", ())) != candidate_ids
        or float(report.get("gugi_probability_mass", -1.0)) != 0.0
        or set(influence) != ZERO_INFLUENCE_FIELDS
        or any(float(influence[key]) != 0.0 for key in influence)
        or authority.get("label_authority") != "pseudo_not_gold"
        or int(authority.get("training_eligible_rows", -1)) != 0
        or int(authority.get("test_training_eligible_rows", -1)) != 0
        or int(authority.get("val_training_eligible_rows", -1)) != 0
        or descriptor.get("file") != audit.labeler.REVIEW_OUTPUT
        or descriptor.get("sha256") != sha256_file(source)
        or descriptor.get("byte_size") != source.stat().st_size
    ):
        raise VisualHeldoutEvaluationError(f"{name}: sealed pass boundary drifted")
    expected_rows = int(_mapping(report.get("counts"), f"{name} counts")["review_rows"])
    found: dict[str, Prediction] = {}
    seen: set[str] = set()
    total = 0
    for line_number, row in _iter_jsonl(source, f"{name} predictions"):
        total += 1
        try:
            audit._validate_review_row(  # noqa: SLF001
                row,
                candidate_ids=candidate_ids,
                location=f"{name}:{line_number}",
            )
        except audit.RelabelAuditError as error:
            raise VisualHeldoutEvaluationError(str(error)) from error
        sample_id = _text(row.get("sample_id"), f"{name}:{line_number}.sample_id")
        if sample_id in seen:
            raise VisualHeldoutEvaluationError(f"{name}: duplicate sample identity")
        seen.add(sample_id)
        if sample_id not in wanted_ids:
            continue
        probabilities = tuple(float(value) for value in row["probabilities"])
        ranking = tuple(
            candidate_ids[index]
            for index in sorted(
                range(len(candidate_ids)), key=lambda index: (-probabilities[index], index)
            )
        )
        if ranking[0] != row.get("selected_font_id"):
            raise VisualHeldoutEvaluationError(f"{name}: probability/top1 drifted")
        found[sample_id] = Prediction(
            sample_id=sample_id,
            split=_text(row.get("split"), f"{name} split"),
            work_id=_text(row.get("work_id"), f"{name} work"),
            chapter_id=_text(row.get("chapter_id"), f"{name} chapter"),
            page_id=_text(row.get("page_id"), f"{name} page"),
            master_row_sha256=_text(
                row.get("master_row_sha256"), f"{name} master row SHA"
            ),
            source_category=_text(
                row.get("source_category"), f"{name} source category"
            ),
            source_kind=_text(row.get("source_kind"), f"{name} source kind"),
            source_row_index=int(row.get("source_row_index", -1)),
            candidate_ids=candidate_ids,
            probabilities=probabilities,
            ranking=ranking,
            record_sha256=_text(row.get("record_sha256"), f"{name} record SHA"),
        )
    if total != expected_rows or set(found) != wanted_ids:
        raise VisualHeldoutEvaluationError(
            f"{name}: row count or heldout identity coverage drifted"
        )
    return found, {
        "file": str(source),
        "report_sha256": sha256_file(report_path),
        "review_predictions_sha256": sha256_file(source),
        "row_count": total,
        "model": copy.deepcopy(report.get("model")),
    }


def _rank(prediction: Prediction, font_id: str) -> int:
    return prediction.ranking.index(font_id) + 1


def _prediction_metrics(
    prediction: Prediction, decision: HeldoutDecision
) -> Mapping[str, Any]:
    if decision.selected_font_id is None:
        return {
            "top1_font_id": prediction.ranking[0],
            "top3_font_ids": list(prediction.ranking[:3]),
        }
    selected_rank = _rank(prediction, decision.selected_font_id)
    positives = {decision.selected_font_id, *decision.acceptable_font_ids}
    best_positive_rank = min(_rank(prediction, font_id) for font_id in positives)
    return {
        "acceptable_at1": best_positive_rank == 1,
        "acceptable_at3": best_positive_rank <= 3,
        "best_positive_rank": best_positive_rank,
        "selected_at1": selected_rank == 1,
        "selected_at3": selected_rank <= 3,
        "selected_rank": selected_rank,
        "top1_font_id": prediction.ranking[0],
        "top3_font_ids": list(prediction.ranking[:3]),
    }


def _comparison_outcome(
    decision: HeldoutDecision,
    baseline_metrics: Mapping[str, Any],
    candidate_metrics: Mapping[str, Any],
) -> str | None:
    if decision.decision_kind == "review_needed":
        return None
    baseline_key = (
        int(baseline_metrics["best_positive_rank"]),
        int(baseline_metrics["selected_rank"]),
    )
    candidate_key = (
        int(candidate_metrics["best_positive_rank"]),
        int(candidate_metrics["selected_rank"]),
    )
    if candidate_key < baseline_key:
        return "improved"
    if candidate_key > baseline_key:
        return "worsened"
    return "same"


def build_evaluation_rows(
    decisions: Mapping[str, HeldoutDecision],
    baseline: Mapping[str, Prediction],
    candidate: Mapping[str, Prediction],
) -> tuple[dict[str, Any], ...]:
    output: list[dict[str, Any]] = []
    identity_fields = (
        "sample_id",
        "split",
        "work_id",
        "chapter_id",
        "page_id",
        "master_row_sha256",
        "source_category",
        "source_kind",
        "source_row_index",
        "candidate_ids",
    )
    for sample_id in sorted(decisions):
        decision = decisions[sample_id]
        before = baseline[sample_id]
        after = candidate[sample_id]
        if any(getattr(before, field) != getattr(after, field) for field in identity_fields):
            raise VisualHeldoutEvaluationError(
                f"{sample_id}: baseline/candidate identity binding drifted"
            )
        if (
            before.split != decision.split
            or before.source_category != decision.source_category
            or before.ranking[0] != decision.source_top1_font_id
        ):
            raise VisualHeldoutEvaluationError(
                f"{sample_id}: heldout/baseline binding drifted"
            )
        baseline_metrics = _prediction_metrics(before, decision)
        candidate_metrics = _prediction_metrics(after, decision)
        outcome = _comparison_outcome(decision, baseline_metrics, candidate_metrics)
        confirmed_retained = (
            after.ranking[0] == decision.source_top1_font_id
            if decision.decision_kind == "confirmed"
            else None
        )
        output.append(
            seal_record(
                {
                    "acceptable_font_ids": list(decision.acceptable_font_ids),
                    "baseline": {
                        **baseline_metrics,
                        "prediction_record_sha256": before.record_sha256,
                    },
                    "candidate": {
                        **candidate_metrics,
                        "prediction_record_sha256": after.record_sha256,
                    },
                    "cohort": decision.cohort,
                    "comparison_outcome": outcome,
                    "confirmed_baseline_top1_retained": confirmed_retained,
                    "decision_kind": decision.decision_kind,
                    "decision_sha256": decision.decision_sha256,
                    "evaluation_authority": QA_AUTHORITY,
                    "independent_gold": False,
                    "label_authority": visual.AUTHORITY,
                    "record_type": "manga_font_visual_heldout_comparison_row",
                    "review_item_sha256": decision.review_item_sha256,
                    "reviewed_font_ids": list(decision.reviewed_font_ids),
                    "role": decision.role,
                    "sample_id": sample_id,
                    "schema_version": ROW_SCHEMA,
                    "selected_font_id": decision.selected_font_id,
                    "source_category": decision.source_category,
                    "split": decision.split,
                    "training_eligible": False,
                }
            )
        )
    return tuple(output)


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 8) if denominator else None


def _metrics(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    kinds = Counter(str(row["decision_kind"]) for row in rows)
    correction = [row for row in rows if row["decision_kind"] == "correction"]
    confirmed = [row for row in rows if row["decision_kind"] == "confirmed"]
    unresolved = [row for row in rows if row["decision_kind"] == "review_needed"]
    outcomes = Counter(
        str(row["comparison_outcome"])
        for row in (*correction, *confirmed)
        if row["comparison_outcome"] is not None
    )

    def correction_side(name: str) -> Mapping[str, Any]:
        values = [_mapping(row[name], f"{name} metrics") for row in correction]
        count = len(values)
        return {
            metric: _ratio(sum(bool(value[metric]) for value in values), count)
            for metric in (
                "selected_at1",
                "selected_at3",
                "acceptable_at1",
                "acceptable_at3",
            )
        }

    baseline_correction = correction_side("baseline")
    candidate_correction = correction_side("candidate")
    correction_delta = {
        key: (
            round(float(candidate_correction[key]) - float(baseline_correction[key]), 8)
            if candidate_correction[key] is not None
            and baseline_correction[key] is not None
            else None
        )
        for key in baseline_correction
    }
    retained = sum(
        row["confirmed_baseline_top1_retained"] is True for row in confirmed
    )
    unresolved_stable = sum(
        _mapping(row["baseline"], "baseline")["top1_font_id"]
        == _mapping(row["candidate"], "candidate")["top1_font_id"]
        for row in unresolved
    )
    return {
        "comparison": {
            "definition": (
                "lexicographic lower (best selected-or-acceptable rank, selected rank); "
                "confirmed rows therefore can only remain same or worsen"
            ),
            "improved": outcomes["improved"],
            "improved_rate": _ratio(outcomes["improved"], sum(outcomes.values())),
            "same": outcomes["same"],
            "same_rate": _ratio(outcomes["same"], sum(outcomes.values())),
            "worsened": outcomes["worsened"],
            "worsened_rate": _ratio(outcomes["worsened"], sum(outcomes.values())),
        },
        "confirmed": {
            "baseline_top1_retained": retained,
            "baseline_top1_retention_rate": _ratio(retained, len(confirmed)),
            "rows": len(confirmed),
        },
        "correction": {
            "acceptable_definition": "selected preferred OR any listed acceptable font",
            "baseline": baseline_correction,
            "candidate": candidate_correction,
            "delta": correction_delta,
            "rows": len(correction),
        },
        "counts": {"rows": len(rows), **dict(sorted(kinds.items()))},
        "review_needed": {
            "correctness_metrics_excluded": True,
            "rows": len(unresolved),
            "top1_stability_rate": _ratio(unresolved_stable, len(unresolved)),
        },
    }


def compute_report_metrics(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    by_cohort: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
    by_role: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
    by_category: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        by_cohort[str(row["cohort"])].append(row)
        by_role[str(row["role"])].append(row)
        by_category[str(row["source_category"])].append(row)
    return {
        "all_visual_qa": _metrics(rows),
        "by_cohort": {key: _metrics(by_cohort[key]) for key in sorted(by_cohort)},
        "by_role": {key: _metrics(by_role[key]) for key in sorted(by_role)},
        "by_source_category": {
            key: _metrics(by_category[key]) for key in sorted(by_category)
        },
    }


def _descriptor(path: Path, *, row_count: int | None = None) -> Mapping[str, Any]:
    value: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        value["row_count"] = row_count
    return value


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("wb") as handle:
        for row in rows:
            handle.write(json_bytes(row))


def evaluate(
    *,
    baseline_review_predictions: Path,
    candidate_review_predictions: Path,
    heldout_decisions: Path,
    output_dir: Path,
    expected_heldout_rows: int = EXPECTED_HELDOUT_ROWS,
) -> Mapping[str, Any]:
    decisions, heldout_binding = _load_heldout(
        heldout_decisions, expected_row_count=expected_heldout_rows
    )
    wanted = set(decisions)
    baseline, baseline_binding = _load_pass(
        baseline_review_predictions, wanted_ids=wanted, name="baseline"
    )
    candidate, candidate_binding = _load_pass(
        candidate_review_predictions, wanted_ids=wanted, name="candidate"
    )
    rows = build_evaluation_rows(decisions, baseline, candidate)
    metrics = compute_report_metrics(rows)
    destination = output_dir.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        marker_path = destination / MARKER_FILE
        if not marker_path.is_file():
            raise VisualHeldoutEvaluationError("refusing to replace unowned output")
        old = _mapping(json.loads(marker_path.read_text(encoding="utf-8")), "marker")
        if old.get("owner") != OWNER or old.get("safe_replace") is not True:
            raise VisualHeldoutEvaluationError("refusing to replace unowned output")
    staging = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent)
    )
    try:
        rows_path = staging / ROWS_FILE
        _write_jsonl(rows_path, rows)
        manifest = seal_record(
            {
                "authority": {
                    "evaluation_authority": QA_AUTHORITY,
                    "human_gold": False,
                    "independent_gold": False,
                    "quality_gate_authority": False,
                    "training_eligible": False,
                },
                "candidate_ids": list(_active_ids()),
                "inputs": {
                    "baseline": baseline_binding,
                    "candidate": candidate_binding,
                    "heldout": heldout_binding,
                },
                "record_type": "manga_font_visual_heldout_evaluation_manifest",
                "row_count": len(rows),
                "schema_version": MANIFEST_SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "artifacts": {
                    MANIFEST_FILE: _descriptor(manifest_path),
                    ROWS_FILE: _descriptor(rows_path, row_count=len(rows)),
                },
                "authority": {
                    "evaluation_authority": QA_AUTHORITY,
                    "human_gold": False,
                    "independent_gold": False,
                    "interpretation": (
                        "read-only model-visible visual QA; not an independent accuracy "
                        "estimate and not training supervision"
                    ),
                    "quality_gate_authority": False,
                    "training_eligible": False,
                },
                "manifest_record_sha256": manifest["record_sha256"],
                "metrics": metrics,
                "record_type": "manga_font_visual_heldout_evaluation_report",
                "schema_version": REPORT_SCHEMA,
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "manifest_sha256": sha256_file(manifest_path),
                "owner": OWNER,
                "report_sha256": sha256_file(report_path),
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(destination)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if not root.is_dir() or root.is_symlink():
        raise VisualHeldoutEvaluationError("evaluation output is missing or linked")
    if {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise VisualHeldoutEvaluationError("evaluation exact inventory drifted")
    marker = _mapping(json.loads((root / MARKER_FILE).read_text(encoding="utf-8")), "marker")
    manifest = _mapping(
        json.loads((root / MANIFEST_FILE).read_text(encoding="utf-8")), "manifest"
    )
    report = _mapping(json.loads((root / REPORT_FILE).read_text(encoding="utf-8")), "report")
    validate_record_seal(marker, location="marker")
    validate_record_seal(manifest, location="manifest")
    validate_record_seal(report, location="report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or marker.get("manifest_sha256") != sha256_file(root / MANIFEST_FILE)
        or marker.get("report_sha256") != sha256_file(root / REPORT_FILE)
        or manifest.get("schema_version") != MANIFEST_SCHEMA
        or report.get("schema_version") != REPORT_SCHEMA
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or manifest.get("source_code_sha256") != sha256_file(Path(__file__).resolve())
        or tuple(manifest.get("candidate_ids", ())) != _active_ids()
    ):
        raise VisualHeldoutEvaluationError("evaluation metadata drifted")
    authority = _mapping(report.get("authority"), "report authority")
    if (
        authority.get("evaluation_authority") != QA_AUTHORITY
        or authority.get("human_gold") is not False
        or authority.get("independent_gold") is not False
        or authority.get("quality_gate_authority") is not False
        or authority.get("training_eligible") is not False
    ):
        raise VisualHeldoutEvaluationError("evaluation authority drifted")
    artifacts = _mapping(report.get("artifacts"), "report artifacts")
    rows_descriptor = _mapping(artifacts.get(ROWS_FILE), "rows descriptor")
    rows_path = root / ROWS_FILE
    if (
        rows_descriptor.get("file") != ROWS_FILE
        or rows_descriptor.get("sha256") != sha256_file(rows_path)
        or rows_descriptor.get("byte_size") != rows_path.stat().st_size
        or rows_descriptor.get("row_count") != manifest.get("row_count")
    ):
        raise VisualHeldoutEvaluationError("evaluation rows descriptor drifted")
    manifest_descriptor = _mapping(
        artifacts.get(MANIFEST_FILE), "manifest descriptor"
    )
    if (
        manifest_descriptor.get("file") != MANIFEST_FILE
        or manifest_descriptor.get("sha256") != sha256_file(root / MANIFEST_FILE)
        or manifest_descriptor.get("byte_size")
        != (root / MANIFEST_FILE).stat().st_size
    ):
        raise VisualHeldoutEvaluationError("manifest descriptor drifted")
    rows: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for line_number, row in _iter_jsonl(rows_path, "evaluation rows"):
        validate_record_seal(row, location=f"evaluation rows:{line_number}")
        sample_id = _text(row.get("sample_id"), "evaluation sample_id")
        if sample_id in seen:
            raise VisualHeldoutEvaluationError("evaluation identity duplicated")
        seen.add(sample_id)
        if (
            row.get("schema_version") != ROW_SCHEMA
            or row.get("evaluation_authority") != QA_AUTHORITY
            or row.get("independent_gold") is not False
            or row.get("training_eligible") is not False
            or row.get("cohort") not in {"val", "test", "human_overlap"}
            or row.get("decision_kind")
            not in {"correction", "confirmed", "review_needed"}
        ):
            raise VisualHeldoutEvaluationError("evaluation row authority drifted")
        rows.append(row)
    if len(rows) != manifest.get("row_count"):
        raise VisualHeldoutEvaluationError("evaluation row count drifted")
    recomputed = compute_report_metrics(rows)
    if canonical_json(recomputed) != canonical_json(report.get("metrics")):
        raise VisualHeldoutEvaluationError("evaluation metrics drifted")
    all_metrics = _mapping(recomputed.get("all_visual_qa"), "all metrics")
    return {
        "candidate_correction": _mapping(
            all_metrics.get("correction"), "correction metrics"
        ).get("candidate"),
        "confirmed_baseline_top1_retention_rate": _mapping(
            all_metrics.get("confirmed"), "confirmed metrics"
        ).get("baseline_top1_retention_rate"),
        "output_dir": str(root),
        "rows": len(rows),
        "status": "validated_read_only_visual_qa_not_independent_gold",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    evaluate_command = commands.add_parser("evaluate")
    evaluate_command.add_argument(
        "--baseline-review-predictions", type=Path, required=True
    )
    evaluate_command.add_argument(
        "--candidate-review-predictions", type=Path, required=True
    )
    evaluate_command.add_argument("--heldout-decisions", type=Path, required=True)
    evaluate_command.add_argument("--output-dir", type=Path, required=True)
    evaluate_command.add_argument(
        "--expected-heldout-rows", type=int, default=EXPECTED_HELDOUT_ROWS
    )
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            result = evaluate(
                baseline_review_predictions=args.baseline_review_predictions,
                candidate_review_predictions=args.candidate_review_predictions,
                heldout_decisions=args.heldout_decisions,
                output_dir=args.output_dir,
                expected_heldout_rows=args.expected_heldout_rows,
            )
    except (VisualHeldoutEvaluationError, OSError, KeyError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
