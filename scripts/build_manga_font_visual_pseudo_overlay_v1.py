#!/usr/bin/env python3
"""Build a pseudo-only overlay from bounded, visible-candidate visual reviews.

This is deliberately *not* a human-gold promotion tool.  It keeps the mass21
pseudo loader contract, changes correction probabilities only inside the five
fonts that were actually visible, leaves confirmed probabilities unchanged,
and excludes validation, test, and existing-human identities from training.
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
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts import audit_manga_font_student_v7_mass21_relabel as audit
    from scripts import build_manga_font_fast_review_batches as review
except ImportError:  # pragma: no cover - direct execution from scripts/
    import audit_manga_font_student_v7_mass21_relabel as audit
    import build_manga_font_fast_review_batches as review


SCHEMA = "manga-font-visual-pseudo-overlay-v1"
REPORT_SCHEMA = "manga-font-visual-pseudo-overlay-report-v1"
MANIFEST_SCHEMA = "manga-font-visual-pseudo-overlay-manifest-v1"
HELDOUT_SCHEMA = "manga-font-visual-reviewed-qa-only-v1"
OWNER = "carrot-manga-translator/manga-font-visual-pseudo-overlay-v1"
AUTHORITY = "pseudo_visual_review_not_human_gold"
QA_AUTHORITY = "visual_reviewed_qa_only_not_independent_gold"
MARKER_FILE = ".manga-font-visual-pseudo-overlay-v1-owned.json"
PSEUDO_FILE = "next-pseudo-targets.jsonl"
HELDOUT_FILE = "heldout-visual-decisions.jsonl"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset(
    {MARKER_FILE, PSEUDO_FILE, HELDOUT_FILE, MANIFEST_FILE, REPORT_FILE}
)
EXPECTED_PSEUDO_ROWS = 18_952
RETIRED_FONT_ID = "gugi"

# The defaults deliberately move only visible-candidate mass.  A 50% convex
# step is additionally capped at 0.20 of the global probability simplex.
DEFAULT_CORRECTION_MIX = 0.50
DEFAULT_MAX_TRANSFER = 0.20
DEFAULT_SELECTED_SHARE = 0.85
DEFAULT_CORRECTION_WEIGHT_MIX = 0.10
DEFAULT_CORRECTION_WEIGHT_MAX_DELTA = 0.05
DEFAULT_CONFIRMED_WEIGHT_MIX = 0.05
DEFAULT_CONFIRMED_WEIGHT_MAX_DELTA = 0.025


class VisualPseudoOverlayError(ValueError):
    """Raised when pseudo or visual-review evidence crosses a safety boundary."""


@dataclass(frozen=True)
class ReviewItem:
    sample_id: str
    record_sha256: str
    split: str
    visible_font_ids: tuple[str, ...]
    current_top1_font_id: str


@dataclass(frozen=True)
class VisualDecision:
    sample_id: str
    kind: str
    review_item_sha256: str
    reviewed_font_ids: tuple[str, ...]
    selected_font_id: str | None
    acceptable_font_ids: tuple[str, ...]
    confidence: float | None
    source_path: str
    source_sha256: str
    source_line: int
    decision_sha256: str
    raw: Mapping[str, Any]


@dataclass(frozen=True)
class Parameters:
    correction_mix: float = DEFAULT_CORRECTION_MIX
    max_transfer: float = DEFAULT_MAX_TRANSFER
    selected_share: float = DEFAULT_SELECTED_SHARE
    correction_weight_mix: float = DEFAULT_CORRECTION_WEIGHT_MIX
    correction_weight_max_delta: float = DEFAULT_CORRECTION_WEIGHT_MAX_DELTA
    confirmed_weight_mix: float = DEFAULT_CONFIRMED_WEIGHT_MIX
    confirmed_weight_max_delta: float = DEFAULT_CONFIRMED_WEIGHT_MAX_DELTA


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    row = copy.deepcopy(dict(core))
    row.pop("record_sha256", None)
    row["record_sha256"] = sha256_bytes(canonical_json(row).encode("utf-8"))
    return row


def validate_record_seal(row: Mapping[str, Any], *, location: str) -> None:
    expected = row.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise VisualPseudoOverlayError(f"{location}: invalid record seal")
    core = {key: value for key, value in row.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise VisualPseudoOverlayError(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise VisualPseudoOverlayError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise VisualPseudoOverlayError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise VisualPseudoOverlayError(f"{location}: expected text")
    return result


def _iter_jsonl(path: Path, location: str) -> Iterable[tuple[int, dict[str, Any]]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise VisualPseudoOverlayError(f"{location}: missing or linked file")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise VisualPseudoOverlayError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield line_number, dict(_mapping(row, f"{location}:{line_number}"))


def _ordered_sha(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _active_ids() -> tuple[str, ...]:
    values = audit.active_candidate_ids()
    if len(values) != 21 or RETIRED_FONT_ID in values:
        raise VisualPseudoOverlayError("active21/Gugi retirement contract drifted")
    return values


def _validate_parameters(parameters: Parameters) -> None:
    values = (
        parameters.correction_mix,
        parameters.max_transfer,
        parameters.selected_share,
        parameters.correction_weight_mix,
        parameters.correction_weight_max_delta,
        parameters.confirmed_weight_mix,
        parameters.confirmed_weight_max_delta,
    )
    if any(not math.isfinite(value) or not 0.0 <= value <= 1.0 for value in values):
        raise VisualPseudoOverlayError("all redistribution parameters must be in [0,1]")
    if parameters.correction_mix <= 0.0 or parameters.max_transfer <= 0.0:
        raise VisualPseudoOverlayError("correction redistribution must be positive")
    if not 0.5 < parameters.selected_share <= 1.0:
        raise VisualPseudoOverlayError("selected-share must prefer the selected font")


def _load_sealed_pseudo(
    path: Path, *, expected_row_count: int
) -> tuple[list[dict[str, Any]], tuple[str, ...], set[str], Mapping[str, Any]]:
    source = path.expanduser().resolve()
    if source.name != audit.NEXT_PSEUDO_FILE:
        raise VisualPseudoOverlayError("pseudo input must be sealed next-pseudo-targets.jsonl")
    try:
        validation = audit.validate_output(source.parent)
    except (audit.RelabelAuditError, OSError, KeyError, ValueError) as error:
        raise VisualPseudoOverlayError(f"sealed pseudo audit failed: {error}") from error
    if source != source.parent / audit.NEXT_PSEUDO_FILE:
        raise VisualPseudoOverlayError("pseudo path escaped its sealed audit bundle")
    candidate_ids = _active_ids()
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line_number, row in _iter_jsonl(source, "source pseudo"):
        try:
            audit._validate_pseudo_row(  # noqa: SLF001
                row,
                candidate_ids=candidate_ids,
                location=f"source pseudo:{line_number}",
            )
        except audit.RelabelAuditError as error:
            raise VisualPseudoOverlayError(str(error)) from error
        sample_id = _text(row.get("sample_id"), f"source pseudo:{line_number}.sample_id")
        if sample_id in seen:
            raise VisualPseudoOverlayError("source pseudo contains duplicate identities")
        seen.add(sample_id)
        rows.append(row)
    if len(rows) != expected_row_count:
        raise VisualPseudoOverlayError(
            f"source pseudo row count {len(rows)} != expected {expected_row_count}"
        )
    gold_ids: set[str] = set()
    for _, row in _iter_jsonl(source.parent / audit.GOLD_EVAL_FILE, "audit human QA"):
        gold_ids.add(_text(row.get("sample_id"), "audit human QA sample_id"))
    if seen & gold_ids:
        raise VisualPseudoOverlayError("source pseudo overlaps existing human supervision")
    audit_report = _mapping(
        json.loads((source.parent / audit.REPORT_FILE).read_text(encoding="utf-8")),
        "audit report",
    )
    source_bindings = _mapping(
        audit_report.get("source_bindings"), "audit source bindings"
    )
    pass_root = Path(
        _text(source_bindings.get("pass_dir"), "audit source pass directory")
    ).expanduser().resolve()
    pass_report = pass_root / audit.labeler.REPORT
    if (
        pass_report.is_symlink()
        or not pass_report.is_file()
        or sha256_file(pass_report) != source_bindings.get("pass_report_sha256")
    ):
        raise VisualPseudoOverlayError("audit source pass binding drifted")
    pass_report_row = _mapping(
        json.loads(pass_report.read_text(encoding="utf-8")), "audit source pass report"
    )
    try:
        audit.validate_record_seal(pass_report_row, location="audit source pass report")
    except audit.RelabelAuditError as error:
        raise VisualPseudoOverlayError(str(error)) from error
    pass_pseudo_path = pass_root / audit.labeler.PSEUDO_OUTPUT
    pseudo_descriptor = _mapping(
        _mapping(pass_report_row.get("artifacts"), "source pass artifacts").get(
            "pseudo_targets"
        ),
        "source pass pseudo descriptor",
    )
    nonvisual = _mapping(
        pass_report_row.get("nonvisual_logit_influence"),
        "source pass nonvisual influence",
    )
    if (
        pass_report_row.get("schema_version") != audit.labeler.REPORT_SCHEMA
        or tuple(pass_report_row.get("candidate_ids", ())) != candidate_ids
        or RETIRED_FONT_ID in pass_report_row.get("candidate_ids", ())
        or float(pass_report_row.get("gugi_probability_mass", -1.0)) != 0.0
        or any(float(value) != 0.0 for value in nonvisual.values())
        or pseudo_descriptor.get("file") != audit.labeler.PSEUDO_OUTPUT
        or pseudo_descriptor.get("sha256") != sha256_file(pass_pseudo_path)
        or pseudo_descriptor.get("byte_size") != pass_pseudo_path.stat().st_size
    ):
        raise VisualPseudoOverlayError("audit source pass safety binding drifted")
    pass_pseudo_ids: set[str] = set()
    for line_number, row in _iter_jsonl(
        pass_pseudo_path, "audit source pass pseudo"
    ):
        sample_id = _text(
            row.get("sample_id"), f"audit source pass pseudo:{line_number}.sample_id"
        )
        if sample_id in pass_pseudo_ids:
            raise VisualPseudoOverlayError("audit source pass pseudo identity duplicated")
        pass_pseudo_ids.add(sample_id)
    if not seen <= pass_pseudo_ids:
        raise VisualPseudoOverlayError("next pseudo escaped its sealed source pass")
    excluded_by_audit = pass_pseudo_ids - seen
    expected_excluded = int(
        _mapping(audit_report.get("counts"), "audit counts").get(
            "gold_excluded_from_pseudo", -1
        )
    )
    if len(excluded_by_audit) != expected_excluded:
        raise VisualPseudoOverlayError("sealed audit human exclusion count drifted")
    gold_ids.update(excluded_by_audit)
    return rows, candidate_ids, gold_ids, {
        "audit_validation": dict(validation),
        "file": str(source),
        "sha256": sha256_file(source),
        "byte_size": source.stat().st_size,
        "row_count": len(rows),
        "sample_order_sha256": _ordered_sha(row["sample_id"] for row in rows),
        "sealed_audit_human_excluded_rows": len(excluded_by_audit),
        "source_pass_pseudo_sha256": sha256_file(pass_pseudo_path),
    }


def _load_review_bundle(
    review_dir: Path,
) -> tuple[dict[str, ReviewItem], set[str], Mapping[str, Any]]:
    root = review_dir.expanduser().resolve()
    try:
        validation = review.validate_review_bundle(root, verify_items=True)
        report = review._read_json(root / review.REPORT_FILE, "review report")  # noqa: SLF001
    except (review.FastNamedReviewError, OSError, KeyError, ValueError) as error:
        raise VisualPseudoOverlayError(f"sealed active21 review failed: {error}") from error
    if tuple(str(value) for value in report.get("candidate_ids", ())) != _active_ids():
        raise VisualPseudoOverlayError("review bundle is not the sealed active21 inventory")
    items: dict[str, ReviewItem] = {}
    for raw_batch in _list(report.get("batches"), "review report.batches"):
        batch = _mapping(raw_batch, "review batch")
        batch_name = _text(batch.get("batch"), "review batch name")
        descriptor = _mapping(
            _mapping(batch.get("artifacts"), "review batch artifacts").get("review_items"),
            "review item descriptor",
        )
        path = root / "batches" / batch_name / _text(
            descriptor.get("file"), "review item file"
        )
        for line_number, row in _iter_jsonl(path, f"{batch_name} review items"):
            sample_id = _text(row.get("sample_id"), "review item sample_id")
            candidates = tuple(
                _text(
                    _mapping(value, "review candidate").get("candidate_id"),
                    "review candidate id",
                )
                for value in _list(row.get("candidates"), "review candidates")
            )
            summaries = _list(row.get("pass_summaries"), "review pass summaries")
            if not summaries:
                raise VisualPseudoOverlayError("review item lacks a model summary")
            current = _text(
                _mapping(summaries[-1], "review pass summary").get(
                    "ranker_top1_font_id"
                ),
                "review current top1",
            )
            if current != candidates[0] or len(candidates) != 5:
                raise VisualPseudoOverlayError("visible candidate/top1 binding drifted")
            item = ReviewItem(
                sample_id=sample_id,
                record_sha256=_text(row.get("record_sha256"), "review item seal"),
                split=_text(row.get("split"), "review item split"),
                visible_font_ids=candidates,
                current_top1_font_id=current,
            )
            if sample_id in items:
                raise VisualPseudoOverlayError("review item identity duplicated")
            items[sample_id] = item
    human_ids: set[str] = set()
    for _, row in _iter_jsonl(root / review.HUMAN_GOLD_FILE, "review human separation"):
        human_ids.add(_text(row.get("sample_id"), "review human sample_id"))
    return items, human_ids, {
        "file": str(root),
        "report_sha256": sha256_file(root / review.REPORT_FILE),
        "record_count": len(items),
        "human_gold_separated_rows": len(human_ids),
        "validation": dict(validation),
    }


def _decision_digest(row: Mapping[str, Any]) -> str:
    if "record_sha256" in row:
        try:
            review.validate_record_seal(row, location="visual decision")
        except review.FastNamedReviewError as error:
            raise VisualPseudoOverlayError(str(error)) from error
        return str(row["record_sha256"])
    return sha256_bytes(canonical_json(row).encode("utf-8"))


def _parse_decision(
    row: Mapping[str, Any], *, path: Path, source_sha: str, line_number: int
) -> VisualDecision:
    location = f"{path}:{line_number}"
    record_type = row.get("record_type")
    if record_type in {
        "manga_font_visual_review_needed_row",
        "manga_font_v7_visual_review_needed_note",
    }:
        legacy_needed = record_type == "manga_font_visual_review_needed_row"
        if legacy_needed:
            valid_boundary = (
                row.get("schema_version") == "manga-font-visual-review-needed-v1"
                and row.get("label_authority") == "review_needed_not_gold"
            )
            reviewed_value = row.get("candidate_font_ids")
        else:
            valid_boundary = (
                row.get("schema_version") == "manga-font-v7-visual-audit-note-v1"
                and row.get("label_authority") == "pseudo_not_gold"
                and row.get("review_authority")
                == "codex_visual_review_not_human_gold"
                and row.get("status") == "review_needed"
                and row.get("training_eligible") is False
                and row.get("promotion_allowed") is False
            )
            reviewed_value = row.get("reviewed_font_ids")
        if not valid_boundary:
            raise VisualPseudoOverlayError(f"{location}: review-needed authority drifted")
        return VisualDecision(
            sample_id=_text(row.get("sample_id"), f"{location}.sample_id"),
            kind="review_needed",
            review_item_sha256=_text(
                row.get("review_item_sha256"), f"{location}.review_item_sha256"
            ),
            reviewed_font_ids=tuple(
                _text(value, f"{location}.candidate_font_ids")
                for value in _list(reviewed_value, f"{location}.reviewed_font_ids")
            ),
            selected_font_id=None,
            acceptable_font_ids=(),
            confidence=None,
            source_path=str(path),
            source_sha256=source_sha,
            source_line=line_number,
            decision_sha256=_decision_digest(row),
            raw=copy.deepcopy(dict(row)),
        )
    if record_type != "manga_font_fast_named_review_decision_template":
        raise VisualPseudoOverlayError(f"{location}: unsupported decision record type")
    if (
        row.get("schema_version") != review.SCHEMA_VERSION
        or row.get("decision_status") != "completed"
        or row.get("review_pass") not in dict(review.REVIEW_PASSES)
        or row.get("review_purpose")
        != dict(review.REVIEW_PASSES).get(row.get("review_pass"))
        or row.get("label_authority") != "pseudo_not_gold"
        or row.get("promotion_allowed") is not False
        or row.get("training_eligible") is not False
        or row.get("none_acceptable") is not False
    ):
        raise VisualPseudoOverlayError(f"{location}: decision authority/pass drifted")
    confidence = row.get("confidence")
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not math.isfinite(float(confidence))
        or not 0.0 <= float(confidence) <= 1.0
    ):
        raise VisualPseudoOverlayError(f"{location}: invalid confidence")
    reviewed = tuple(
        _text(value, f"{location}.reviewed_font_ids")
        for value in _list(row.get("reviewed_font_ids"), f"{location}.reviewed_font_ids")
    )
    selected = _text(row.get("selected_font_id"), f"{location}.selected_font_id")
    acceptable = tuple(
        _text(value, f"{location}.acceptable_font_ids")
        for value in _list(row.get("acceptable_font_ids"), f"{location}.acceptable_font_ids")
    )
    if len(set(reviewed)) != len(reviewed) or len(set(acceptable)) != len(acceptable):
        raise VisualPseudoOverlayError(f"{location}: duplicate candidate identity")
    if selected in acceptable:
        raise VisualPseudoOverlayError(f"{location}: preferred also listed acceptable")
    reason = str(row.get("correction_reason", ""))
    metadata = row.get("decision_metadata")
    audit_set = metadata.get("audit_set") if isinstance(metadata, Mapping) else None
    if audit_set not in {None, "correction", "confirmed"}:
        raise VisualPseudoOverlayError(f"{location}: unsupported audit disposition")
    declared_confirmed = (
        audit_set == "confirmed"
        if audit_set is not None
        else reason == "visual_top1_confirmed"
    )
    return VisualDecision(
        sample_id=_text(row.get("sample_id"), f"{location}.sample_id"),
        kind="confirmed" if declared_confirmed else "correction",
        review_item_sha256=_text(
            row.get("review_item_sha256"), f"{location}.review_item_sha256"
        ),
        reviewed_font_ids=reviewed,
        selected_font_id=selected,
        acceptable_font_ids=acceptable,
        confidence=float(confidence),
        source_path=str(path),
        source_sha256=source_sha,
        source_line=line_number,
        decision_sha256=_decision_digest(row),
        raw=copy.deepcopy(dict(row)),
    )


def _load_decisions(paths: Sequence[Path]) -> tuple[dict[str, VisualDecision], list[dict[str, Any]]]:
    if not paths:
        raise VisualPseudoOverlayError("at least one decision/review-needed file is required")
    decisions: dict[str, VisualDecision] = {}
    sources: list[dict[str, Any]] = []
    seen_paths: set[Path] = set()
    for raw_path in paths:
        path = raw_path.expanduser().resolve()
        if path in seen_paths:
            continue
        seen_paths.add(path)
        source_sha = sha256_file(path)
        count = 0
        for line_number, row in _iter_jsonl(path, "visual decisions"):
            count += 1
            decision = _parse_decision(
                row, path=path, source_sha=source_sha, line_number=line_number
            )
            previous = decisions.get(decision.sample_id)
            if previous is not None:
                if (
                    previous.kind != decision.kind
                    or previous.decision_sha256 != decision.decision_sha256
                ):
                    raise VisualPseudoOverlayError(
                        f"contradictory duplicate decision for {decision.sample_id}"
                    )
                continue
            decisions[decision.sample_id] = decision
        sources.append(
            {
                "file": str(path),
                "sha256": source_sha,
                "byte_size": path.stat().st_size,
                "row_count": count,
            }
        )
    return decisions, sources


def _bind_decisions(
    decisions: Mapping[str, VisualDecision],
    *,
    items: Mapping[str, ReviewItem],
    pseudo_ids: set[str],
    human_ids: set[str],
    candidate_ids: tuple[str, ...],
) -> tuple[dict[str, VisualDecision], list[dict[str, Any]], Mapping[str, int]]:
    train: dict[str, VisualDecision] = {}
    heldout: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    active = set(candidate_ids)
    for decision in decisions.values():
        item = items.get(decision.sample_id)
        if item is None:
            raise VisualPseudoOverlayError(
                f"decision {decision.sample_id} is absent from sealed review items"
            )
        if (
            decision.review_item_sha256 != item.record_sha256
            or decision.reviewed_font_ids != item.visible_font_ids
            or len(item.visible_font_ids) != 5
            or not set(item.visible_font_ids) <= active
            or RETIRED_FONT_ID in item.visible_font_ids
        ):
            raise VisualPseudoOverlayError(
                f"decision {decision.sample_id} visible-candidate join drifted"
            )
        if decision.kind == "review_needed":
            if decision.raw.get("current_top1_font_id") != item.current_top1_font_id:
                raise VisualPseudoOverlayError(
                    f"decision {decision.sample_id} review-needed top1 drifted"
                )
        else:
            positive = {decision.selected_font_id, *decision.acceptable_font_ids}
            if None in positive or not positive <= set(item.visible_font_ids):
                raise VisualPseudoOverlayError(
                    f"decision {decision.sample_id} positive escaped visible candidates"
                )
            expected_kind = (
                "confirmed"
                if decision.selected_font_id == item.current_top1_font_id
                else "correction"
            )
            if decision.kind != expected_kind:
                raise VisualPseudoOverlayError(
                    f"decision {decision.sample_id} correction/confirmation drifted"
                )
            metadata = decision.raw.get("decision_metadata")
            if isinstance(metadata, Mapping):
                declared_top1 = metadata.get(
                    "old_top1_font_id", metadata.get("current_top1_font_id")
                )
                if declared_top1 not in (None, item.current_top1_font_id):
                    raise VisualPseudoOverlayError(
                        f"decision {decision.sample_id} old top1 binding drifted"
                    )

        in_human = decision.sample_id in human_ids
        in_pseudo = decision.sample_id in pseudo_ids
        if in_human and in_pseudo:
            raise VisualPseudoOverlayError("human-reviewed identity leaked into pseudo input")
        if item.split == "train" and not in_pseudo and not in_human:
            raise VisualPseudoOverlayError(
                f"train decision {decision.sample_id} escaped pseudo/human universes"
            )
        if item.split != "train" and in_pseudo:
            raise VisualPseudoOverlayError("validation/test decision leaked into pseudo input")

        counts[f"input_{decision.kind}"] += 1
        counts[f"input_split_{item.split}"] += 1
        if item.split == "train" and in_pseudo:
            if decision.kind != "review_needed":
                train[decision.sample_id] = decision
                counts[f"train_applied_{decision.kind}"] += 1
            else:
                counts["train_review_needed_unchanged"] += 1
            continue

        exclusion = "existing_human_supervision_overlap" if in_human else "non_train_split"
        counts[f"heldout_{exclusion}"] += 1
        counts[f"heldout_split_{item.split}"] += 1
        heldout.append(
            seal_record(
                {
                    "acceptable_font_ids": list(decision.acceptable_font_ids),
                    "decision_kind": decision.kind,
                    "decision_sha256": decision.decision_sha256,
                    "evaluation_authority": QA_AUTHORITY,
                    "exclusion_reason": exclusion,
                    "label_authority": AUTHORITY,
                    "promotion_allowed": False,
                    "record_type": "manga_font_visual_reviewed_qa_only_row",
                    "review_item_sha256": item.record_sha256,
                    "reviewed_font_ids": list(decision.reviewed_font_ids),
                    "sample_id": decision.sample_id,
                    "schema_version": HELDOUT_SCHEMA,
                    "selected_font_id": decision.selected_font_id,
                    "source_current_top1_font_id": item.current_top1_font_id,
                    "split": item.split,
                    "training_eligible": False,
                }
            )
        )
    return train, heldout, dict(counts)


def _top1(candidate_ids: Sequence[str], probabilities: Sequence[float]) -> str:
    return candidate_ids[max(range(len(candidate_ids)), key=lambda index: probabilities[index])]


def _raised_weight(
    old: float, confidence: float, *, mix: float, max_delta: float
) -> float:
    return min(1.0, old + min(max_delta, mix * confidence * (1.0 - old)))


def _apply_correction(
    probabilities: Sequence[float],
    *,
    candidate_ids: tuple[str, ...],
    decision: VisualDecision,
    parameters: Parameters,
) -> tuple[list[float], Mapping[str, float]]:
    values = [float(value) for value in probabilities]
    index = {font_id: position for position, font_id in enumerate(candidate_ids)}
    positives = {decision.selected_font_id, *decision.acceptable_font_ids}
    donors = [
        index[font_id]
        for font_id in decision.reviewed_font_ids
        if font_id not in positives
    ]
    donor_mass = sum(values[position] for position in donors)
    if donor_mass <= 0.0:
        raise VisualPseudoOverlayError(
            f"correction {decision.sample_id} has no visible non-positive mass"
        )
    transfer = min(donor_mass * parameters.correction_mix, parameters.max_transfer)
    fraction = transfer / donor_mass
    updated = list(values)
    for position in donors:
        updated[position] = values[position] * (1.0 - fraction)
    actual_transfer = sum(values[position] - updated[position] for position in donors)
    selected_index = index[str(decision.selected_font_id)]
    acceptable = list(decision.acceptable_font_ids)
    selected_share = parameters.selected_share if acceptable else 1.0
    selected_delta = actual_transfer * selected_share
    updated[selected_index] += selected_delta
    acceptable_delta = actual_transfer - selected_delta
    if acceptable:
        priors = [values[index[font_id]] + 1e-9 for font_id in acceptable]
        denominator = sum(priors)
        allocated = 0.0
        for font_id, prior in zip(acceptable[:-1], priors[:-1], strict=True):
            delta = acceptable_delta * prior / denominator
            updated[index[font_id]] += delta
            allocated += delta
        updated[index[acceptable[-1]]] += acceptable_delta - allocated
    invisible = set(candidate_ids) - set(decision.reviewed_font_ids)
    if any(updated[index[font_id]] != values[index[font_id]] for font_id in invisible):
        raise VisualPseudoOverlayError("correction changed an invisible candidate")
    if updated[selected_index] <= values[selected_index] or any(
        updated[index[font_id]] <= values[index[font_id]] for font_id in acceptable
    ):
        raise VisualPseudoOverlayError("correction failed to raise every visible positive")
    if not math.isclose(sum(updated), sum(values), rel_tol=0.0, abs_tol=1e-12):
        raise VisualPseudoOverlayError("correction changed probability simplex mass")
    return updated, {
        "actual_transfer": actual_transfer,
        "effective_visible_convex_mix": fraction,
        "selected_probability_delta": selected_delta,
    }


def _apply_train_decisions(
    source_rows: Sequence[Mapping[str, Any]],
    *,
    decisions: Mapping[str, VisualDecision],
    candidate_ids: tuple[str, ...],
    parameters: Parameters,
) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    output: list[dict[str, Any]] = []
    stats: Counter[str] = Counter()
    transfers: list[float] = []
    for source in source_rows:
        sample_id = str(source["sample_id"])
        decision = decisions.get(sample_id)
        if decision is None:
            output.append(copy.deepcopy(dict(source)))
            stats["unchanged_rows"] += 1
            continue
        original_probabilities = [float(value) for value in source["probabilities"]]
        original_weight = float(source["weight"])
        source_top1 = _top1(candidate_ids, original_probabilities)
        if source_top1 != decision.raw.get("decision_metadata", {}).get(
            "old_top1_font_id", source_top1
        ):
            raise VisualPseudoOverlayError(f"{sample_id}: pseudo/decision top1 drifted")
        if decision.kind == "confirmed":
            if decision.selected_font_id != source_top1:
                raise VisualPseudoOverlayError(f"{sample_id}: invalid confirmation")
            probabilities = original_probabilities
            weight = _raised_weight(
                original_weight,
                float(decision.confidence),
                mix=parameters.confirmed_weight_mix,
                max_delta=parameters.confirmed_weight_max_delta,
            )
            redistribution: Mapping[str, float] = {
                "actual_transfer": 0.0,
                "effective_visible_convex_mix": 0.0,
                "selected_probability_delta": 0.0,
            }
        elif decision.kind == "correction":
            probabilities, redistribution = _apply_correction(
                original_probabilities,
                candidate_ids=candidate_ids,
                decision=decision,
                parameters=parameters,
            )
            weight = _raised_weight(
                original_weight,
                float(decision.confidence),
                mix=parameters.correction_weight_mix,
                max_delta=parameters.correction_weight_max_delta,
            )
            transfers.append(float(redistribution["actual_transfer"]))
        else:  # pragma: no cover - bound decisions exclude review-needed
            raise VisualPseudoOverlayError("unexpected train decision kind")
        row = copy.deepcopy(dict(source))
        row["probabilities"] = probabilities
        row["weight"] = weight
        row["pseudo_visual_review"] = {
            "acceptable_font_ids": list(decision.acceptable_font_ids),
            "authority": AUTHORITY,
            "confidence": decision.confidence,
            "decision_kind": decision.kind,
            "decision_sha256": decision.decision_sha256,
            "original_record_sha256": source["record_sha256"],
            "original_top1_font_id": source_top1,
            "original_weight": original_weight,
            "redistribution": dict(redistribution),
            "review_item_sha256": decision.review_item_sha256,
            "reviewed_font_ids": list(decision.reviewed_font_ids),
            "selected_font_id": decision.selected_font_id,
            "visible_candidates_only": True,
        }
        # Keep the existing loader's top-level pseudo authority contract.  The
        # narrower visual authority is explicit in pseudo_visual_review.
        row["label_authority"] = "pseudo_soft_not_gold"
        row["training_eligible"] = False
        row = seal_record(row)
        output.append(row)
        stats[f"applied_{decision.kind}"] += 1
        stats[f"top1_after_{_top1(candidate_ids, probabilities)}"] += 1
        if _top1(candidate_ids, probabilities) == decision.selected_font_id:
            stats[f"{decision.kind}_selected_is_top1_after"] += 1
    return output, {
        **dict(stats),
        "correction_mean_probability_transfer": (
            sum(transfers) / len(transfers) if transfers else 0.0
        ),
        "correction_max_probability_transfer": max(transfers, default=0.0),
    }


def _artifact_descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "file": path.name,
        "sha256": sha256_file(path),
        "byte_size": path.stat().st_size,
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("wb") as handle:
        for row in rows:
            handle.write(json_bytes(row))


def build_overlay(
    *,
    pseudo_targets: Path,
    review_dir: Path,
    decision_paths: Sequence[Path],
    output_dir: Path,
    expected_row_count: int = EXPECTED_PSEUDO_ROWS,
    parameters: Parameters = Parameters(),
) -> Mapping[str, Any]:
    _validate_parameters(parameters)
    source_rows, candidate_ids, audit_human, pseudo_binding = _load_sealed_pseudo(
        pseudo_targets, expected_row_count=expected_row_count
    )
    items, review_human, review_binding = _load_review_bundle(review_dir)
    decisions, decision_sources = _load_decisions(decision_paths)
    human_ids = audit_human | review_human
    pseudo_ids = {str(row["sample_id"]) for row in source_rows}
    train_decisions, heldout, binding_counts = _bind_decisions(
        decisions,
        items=items,
        pseudo_ids=pseudo_ids,
        human_ids=human_ids,
        candidate_ids=candidate_ids,
    )
    output_rows, application = _apply_train_decisions(
        source_rows,
        decisions=train_decisions,
        candidate_ids=candidate_ids,
        parameters=parameters,
    )
    if len(output_rows) != len(source_rows):
        raise VisualPseudoOverlayError("pseudo row count changed")

    destination = output_dir.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        marker_path = destination / MARKER_FILE
        if not marker_path.is_file():
            raise VisualPseudoOverlayError("refusing to replace an unowned output directory")
        old_marker = _mapping(json.loads(marker_path.read_text(encoding="utf-8")), "marker")
        if old_marker.get("owner") != OWNER or old_marker.get("safe_replace") is not True:
            raise VisualPseudoOverlayError("refusing to replace an unowned output directory")
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent))
    try:
        pseudo_path = staging / PSEUDO_FILE
        heldout_path = staging / HELDOUT_FILE
        _write_jsonl(pseudo_path, output_rows)
        _write_jsonl(heldout_path, heldout)
        parameters_dict = {
            "acceptable_allocation": "remaining share, prior-proportional with epsilon floor",
            "confirmed_probability_policy": "exactly_preserved",
            "confirmed_weight_max_delta": parameters.confirmed_weight_max_delta,
            "confirmed_weight_mix": parameters.confirmed_weight_mix,
            "correction_mix": parameters.correction_mix,
            "correction_weight_max_delta": parameters.correction_weight_max_delta,
            "correction_weight_mix": parameters.correction_weight_mix,
            "invisible_candidate_probability_policy": "exactly_preserved",
            "max_probability_transfer": parameters.max_transfer,
            "selected_share": parameters.selected_share,
        }
        manifest = seal_record(
            {
                "authority": {
                    "human_gold_promotions": 0,
                    "label_authority": AUTHORITY,
                    "loader_top_level_authority": "pseudo_soft_not_gold",
                    "promotion_allowed": False,
                    "training_eligible": False,
                },
                "candidate_ids": list(candidate_ids),
                "counts": {
                    "heldout_visual_qa_rows": len(heldout),
                    "input_visual_rows": len(decisions),
                    "output_pseudo_rows": len(output_rows),
                    "train_applied_rows": len(train_decisions),
                },
                "decision_sources": decision_sources,
                "inputs": {"pseudo": pseudo_binding, "review": review_binding},
                "output_sample_order_sha256": _ordered_sha(
                    str(row["sample_id"]) for row in output_rows
                ),
                "parameters": parameters_dict,
                "record_type": "manga_font_visual_pseudo_overlay_manifest",
                "schema_version": MANIFEST_SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "application": application,
                "artifacts": {
                    HELDOUT_FILE: _artifact_descriptor(
                        heldout_path, row_count=len(heldout)
                    ),
                    MANIFEST_FILE: _artifact_descriptor(manifest_path),
                    PSEUDO_FILE: _artifact_descriptor(
                        pseudo_path, row_count=len(output_rows)
                    ),
                },
                "authority": {
                    "heldout_is_independent_gold": False,
                    "heldout_label": QA_AUTHORITY,
                    "human_gold_promotions": 0,
                    "label_authority": AUTHORITY,
                    "training_eligible": False,
                },
                "binding_counts": binding_counts,
                "candidate_ids": list(candidate_ids),
                "manifest_record_sha256": manifest["record_sha256"],
                "parameters": parameters_dict,
                "record_type": "manga_font_visual_pseudo_overlay_report",
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
        raise VisualPseudoOverlayError("overlay output is missing or linked")
    actual = {path.name for path in root.iterdir()}
    if actual != OUTPUT_FILES:
        raise VisualPseudoOverlayError("overlay exact inventory drifted")
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
    ):
        raise VisualPseudoOverlayError("overlay metadata drifted")
    candidate_ids = _active_ids()
    if tuple(manifest.get("candidate_ids", ())) != candidate_ids or tuple(
        report.get("candidate_ids", ())
    ) != candidate_ids:
        raise VisualPseudoOverlayError("overlay active21 inventory drifted")
    artifacts = _mapping(report.get("artifacts"), "report artifacts")
    counts = _mapping(manifest.get("counts"), "manifest counts")
    expected = {
        PSEUDO_FILE: int(counts["output_pseudo_rows"]),
        HELDOUT_FILE: int(counts["heldout_visual_qa_rows"]),
    }
    seen: set[str] = set()
    pseudo_order: list[str] = []
    for name, expected_rows in expected.items():
        path = root / name
        descriptor = _mapping(artifacts.get(name), f"artifact {name}")
        if (
            descriptor.get("file") != name
            or descriptor.get("sha256") != sha256_file(path)
            or descriptor.get("byte_size") != path.stat().st_size
            or descriptor.get("row_count") != expected_rows
        ):
            raise VisualPseudoOverlayError(f"artifact descriptor drifted: {name}")
        rows = list(_iter_jsonl(path, name))
        if len(rows) != expected_rows:
            raise VisualPseudoOverlayError(f"artifact count drifted: {name}")
        for line_number, row in rows:
            sample_id = _text(row.get("sample_id"), f"{name}:{line_number}.sample_id")
            if name == PSEUDO_FILE:
                try:
                    audit._validate_pseudo_row(  # noqa: SLF001
                        row,
                        candidate_ids=candidate_ids,
                        location=f"{name}:{line_number}",
                    )
                except audit.RelabelAuditError as error:
                    raise VisualPseudoOverlayError(str(error)) from error
                if sample_id in seen:
                    raise VisualPseudoOverlayError("output pseudo identity duplicated")
                seen.add(sample_id)
                pseudo_order.append(sample_id)
                visual = row.get("pseudo_visual_review")
                if visual is not None and (
                    not isinstance(visual, Mapping)
                    or visual.get("authority") != AUTHORITY
                    or visual.get("visible_candidates_only") is not True
                ):
                    raise VisualPseudoOverlayError("visual pseudo authority drifted")
            else:
                validate_record_seal(row, location=f"{name}:{line_number}")
                if (
                    row.get("schema_version") != HELDOUT_SCHEMA
                    or row.get("label_authority") != AUTHORITY
                    or row.get("evaluation_authority") != QA_AUTHORITY
                    or row.get("training_eligible") is not False
                    or row.get("promotion_allowed") is not False
                    or row.get("split") not in {"train", "val", "test"}
                ):
                    raise VisualPseudoOverlayError("heldout QA authority drifted")
    if _ordered_sha(pseudo_order) != manifest.get("output_sample_order_sha256"):
        raise VisualPseudoOverlayError("output pseudo order drifted")
    manifest_artifact = _mapping(artifacts.get(MANIFEST_FILE), "manifest artifact")
    if (
        manifest_artifact.get("file") != MANIFEST_FILE
        or manifest_artifact.get("sha256") != sha256_file(root / MANIFEST_FILE)
        or manifest_artifact.get("byte_size") != (root / MANIFEST_FILE).stat().st_size
    ):
        raise VisualPseudoOverlayError("manifest descriptor drifted")
    authority = _mapping(report.get("authority"), "report authority")
    if (
        authority.get("human_gold_promotions") != 0
        or authority.get("heldout_is_independent_gold") is not False
        or authority.get("label_authority") != AUTHORITY
        or authority.get("training_eligible") is not False
        or RETIRED_FONT_ID in candidate_ids
    ):
        raise VisualPseudoOverlayError("overlay safety boundary drifted")
    return {
        "heldout_visual_qa_rows": expected[HELDOUT_FILE],
        "output_dir": str(root),
        "pseudo_rows": expected[PSEUDO_FILE],
        "status": "validated_pseudo_visual_review_not_human_gold",
        "train_applied_rows": int(counts["train_applied_rows"]),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--pseudo-targets", type=Path, required=True)
    build.add_argument("--review-dir", type=Path, required=True)
    build.add_argument(
        "--decision-file",
        type=Path,
        action="append",
        default=[],
        help="repeat for correction, confirmed, and review-needed JSONL files",
    )
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--expected-row-count", type=int, default=EXPECTED_PSEUDO_ROWS)
    build.add_argument("--correction-mix", type=float, default=DEFAULT_CORRECTION_MIX)
    build.add_argument("--max-transfer", type=float, default=DEFAULT_MAX_TRANSFER)
    build.add_argument("--selected-share", type=float, default=DEFAULT_SELECTED_SHARE)
    build.add_argument(
        "--correction-weight-mix", type=float, default=DEFAULT_CORRECTION_WEIGHT_MIX
    )
    build.add_argument(
        "--correction-weight-max-delta",
        type=float,
        default=DEFAULT_CORRECTION_WEIGHT_MAX_DELTA,
    )
    build.add_argument(
        "--confirmed-weight-mix", type=float, default=DEFAULT_CONFIRMED_WEIGHT_MIX
    )
    build.add_argument(
        "--confirmed-weight-max-delta",
        type=float,
        default=DEFAULT_CONFIRMED_WEIGHT_MAX_DELTA,
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
            result = build_overlay(
                pseudo_targets=args.pseudo_targets,
                review_dir=args.review_dir,
                decision_paths=args.decision_file,
                output_dir=args.output_dir,
                expected_row_count=args.expected_row_count,
                parameters=Parameters(
                    correction_mix=args.correction_mix,
                    max_transfer=args.max_transfer,
                    selected_share=args.selected_share,
                    correction_weight_mix=args.correction_weight_mix,
                    correction_weight_max_delta=args.correction_weight_max_delta,
                    confirmed_weight_mix=args.confirmed_weight_mix,
                    confirmed_weight_max_delta=args.confirmed_weight_max_delta,
                ),
            )
    except (VisualPseudoOverlayError, OSError, KeyError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
