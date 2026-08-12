#!/usr/bin/env python3
"""Seal r2 rows 401..800 into immutable 1201..1600 training-only labels.

The two public reviewers saw only opaque A..G slots.  This sealer JSON-decodes
only one explicitly selected private local span (401..600 or 601..800) per
direct shard build.  Recrop/ruby/split rows are excluded from both positive and
negative supervision.  The merge preserves the existing 001..1200 label file
as an exact byte prefix and fails closed against adapter validation, master
validation/test, val33, independent blind calibration/evaluation, and every
available QA-page cohort.  It never trains, evaluates, or releases a model.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import seal_manga_font_v2_high_value_supervised_labels_range_v5 as v5
except ImportError:  # pragma: no cover - direct script execution
    import seal_manga_font_v2_high_value_supervised_labels_range_v5 as v5


prior = v5.prior
base = v5.base
BUILD_MODE_RANGE = "r2_local_range_deblind_global_remap_v6"
BUILD_MODE_MERGE = "sealed_two_shard_merge_byte_stable_prefix_v6"
CUMULATIVE_SPAN = [1, 1600]
GLOBAL_OFFSET = 800
EXPECTED_REVIEW_ROWS = 200
EXPECTED_PRIOR_LABEL_ROWS = 1036
EXPECTED_PRIOR_SPAN = [1, 1200]
EXPECTED_CUMULATIVE_BLIND_ROWS = 1600
EXPECTED_OVERLAP_KEYS = {
    "adapter_validation",
    "adapter_validation_work",
    "blind_calibration",
    "blind_evaluation",
    "master_test",
    "master_val",
    "qa_pages",
    "val33",
}
RANGE_SPECS: dict[str, dict[str, Any]] = {
    "1201-1400": {
        "local_span": [401, 600],
        "direct_span": [1201, 1400],
        "expected_recrop_rows": 28,
        "default_review_dir": Path(
            "artifacts/manga-font-v2-high-value-blind-review-agent-1201-1400-"
            "public-only-r1"
        ),
    },
    "1401-1600": {
        "local_span": [601, 800],
        "direct_span": [1401, 1600],
        "expected_recrop_rows": 20,
        "default_review_dir": Path(
            "artifacts/manga-font-v2-high-value-blind-review-agent-1401-1600-"
            "public-only-r1"
        ),
    },
}
EXPECTED_SHARDS = [
    [1, 200],
    [201, 400],
    [401, 600],
    [601, 800],
    [801, 1000],
    [1001, 1200],
    [1201, 1400],
    [1401, 1600],
]


def _read_labels(root: Path) -> list[dict[str, Any]]:
    return list(base.iter_jsonl(root / base.LABELS_FILE, "sealed training labels"))


def _empty_jsonl_descriptor(path: Path) -> Mapping[str, Any]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file() or source.stat().st_size != 0:
        raise base.HighValueSupervisedLabelError(
            "expected an immutable empty JSONL artifact"
        )
    return {
        "byte_size": 0,
        "file": str(source),
        "row_count": 0,
        "sha256": base.sha256_file(source),
    }


def _review_ids(rows: Sequence[Mapping[str, Any]]) -> set[str]:
    return {
        base.text(
            base.mapping(row.get("review_binding"), "review binding").get("review_id"),
            "review id",
        )
        for row in rows
    }


def _load_review_contract(
    review_dir: Path,
    *,
    range_id: str,
    local_span: Sequence[int],
    expected_recrop_rows: int,
) -> tuple[list[dict[str, Any]], set[str], Mapping[str, Any]]:
    root = review_dir.expanduser().resolve()
    decisions = list(
        base.iter_jsonl(root / "decisions-public-blind.jsonl", "blind decisions")
    )
    recrop = list(base.iter_jsonl(root / "recrop-review.jsonl", "recrop review"))
    secondary = list(
        base.iter_jsonl(
            root / "full21-secondary-search.jsonl", "full21 secondary search"
        )
    )
    report = base.read_json(root / "report.json", "blind review report")
    base.validate_record_seal(report, "blind review report")
    report_counts = base.mapping(report.get("counts"), "blind review report counts")
    if (
        len(decisions) != EXPECTED_REVIEW_ROWS
        or len(recrop) != expected_recrop_rows
        or secondary
        or int(report_counts.get("rows", -1)) != EXPECTED_REVIEW_ROWS
        or int(report_counts.get("recrop_review", -1)) != expected_recrop_rows
        or int(report_counts.get("full21_secondary_search", -1)) != 0
    ):
        raise base.HighValueSupervisedLabelError(
            f"{range_id} review/recrop/full21 count drifted"
        )
    queue_rows = [int(row.get("queue_row", -1)) for row in decisions]
    if queue_rows != list(range(int(local_span[0]), int(local_span[1]) + 1)):
        raise base.HighValueSupervisedLabelError(
            f"{range_id} blind decisions escaped local span {list(local_span)}"
        )
    for index, row in enumerate(decisions, 1):
        base.validate_record_seal(row, f"blind decision:{index}")
        blindness = base.mapping(row.get("blindness"), "blindness")
        authority = base.mapping(row.get("authority"), "decision authority")
        if (
            blindness.get("candidate_identifiers_visible") is not False
            or blindness.get("font_names_visible") is not False
            or blindness.get("model_predictions_visible") is not False
            or blindness.get("private_bindings_read") is not False
            or authority.get("training_eligible") is not False
            or authority.get("automatic_label_promotion_allowed") is not False
        ):
            raise base.HighValueSupervisedLabelError(
                "public reviewer blindness drifted"
            )
    for index, row in enumerate(recrop, 1):
        base.validate_record_seal(row, f"recrop review:{index}")
        authority = base.mapping(row.get("authority"), "recrop authority")
        reasons = {str(value) for value in row.get("reason_codes", ())}
        if (
            row.get("crop_quality") not in {"reject", "review_needed"}
            or "recrop_or_ruby_split_adjudication_required" not in reasons
            or authority.get("training_eligible") is not False
            or authority.get("automatic_label_promotion_allowed") is not False
        ):
            raise base.HighValueSupervisedLabelError(
                "recrop/ruby/split authority drifted"
            )

    recrop_ids = {base.text(row.get("sample_id"), "recrop sample_id") for row in recrop}
    ineligible_ids = {
        base.text(row.get("sample_id"), "decision sample_id")
        for row in decisions
        if (
            row.get("decision_status") != "completed"
            or row.get("crop_quality") != "pass"
            or row.get("candidate_search_complete") is not True
            or row.get("none_acceptable") is True
        )
    }
    if recrop_ids != ineligible_ids:
        raise base.HighValueSupervisedLabelError(
            "recrop/ruby/split rows do not exactly match ineligible decisions"
        )
    report_blindness = base.mapping(report.get("blindness"), "review report blindness")
    if report_blindness.get("private_bindings_read") is not False:
        raise base.HighValueSupervisedLabelError("public review report is not blind")
    return (
        decisions,
        recrop_ids,
        {
            "decisions": base.source_descriptor(
                root / "decisions-public-blind.jsonl", row_count=len(decisions)
            ),
            "recrop_review": base.source_descriptor(
                root / "recrop-review.jsonl", row_count=len(recrop)
            ),
            "full21_secondary_search": _empty_jsonl_descriptor(
                root / "full21-secondary-search.jsonl"
            ),
            "report": base.source_descriptor(root / "report.json"),
        },
    )


def _guard_prior_duplicates(
    *,
    old_cumulative_dir: Path,
    decisions: Sequence[Mapping[str, Any]],
    range_id: str,
) -> Mapping[str, Any]:
    root = old_cumulative_dir.expanduser().resolve()
    validation = base.validate_output(root)
    manifest = base.read_json(root / base.MANIFEST_FILE, "old cumulative manifest")
    counts = base.mapping(manifest.get("counts"), "old cumulative counts")
    old_labels = _read_labels(root)
    if (
        list(counts.get("expected_queue_row_span", ())) != EXPECTED_PRIOR_SPAN
        or len(old_labels) != EXPECTED_PRIOR_LABEL_ROWS
        or int(counts.get("training_label_rows", -1)) != EXPECTED_PRIOR_LABEL_ROWS
    ):
        raise base.HighValueSupervisedLabelError(
            "001..1200 cumulative boundary drifted"
        )
    old_samples = {
        base.text(row.get("sample_id"), "old sample_id") for row in old_labels
    }
    old_reviews = _review_ids(old_labels)
    new_samples = {
        base.text(row.get("sample_id"), "decision sample_id") for row in decisions
    }
    new_reviews = {
        base.text(row.get("review_id"), "decision review_id") for row in decisions
    }
    sample_overlap = old_samples & new_samples
    review_overlap = old_reviews & new_reviews
    if sample_overlap or review_overlap:
        raise base.HighValueSupervisedLabelError(
            f"{range_id} review repeats an existing 001..1200 sample/review identity"
        )
    return {
        "duplicate_guard": {
            "existing_review_id_overlap": 0,
            "existing_sample_id_overlap": 0,
            "fail_closed": True,
            "new_blind_rows_checked": len(decisions),
            "prior_training_rows_checked": len(old_labels),
        },
        "labels": base.source_descriptor(
            root / base.LABELS_FILE, row_count=len(old_labels)
        ),
        "manifest": base.source_descriptor(root / base.MANIFEST_FILE),
        "output_dir": str(root),
        "validation": dict(validation),
    }


def _remap_direct(
    labels: Sequence[Mapping[str, Any]],
    summary: Mapping[str, Any],
    *,
    range_id: str,
    local_span: Sequence[int],
    direct_span: Sequence[int],
    expected_recrop_rows: int,
    recrop_ids: set[str],
    review_sources: Mapping[str, Any],
    prior_guard: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    remapped: list[dict[str, Any]] = []
    for row in labels:
        value = copy.deepcopy(dict(row))
        value["queue_row"] = int(value["queue_row"]) + GLOBAL_OFFSET
        remapped.append(base.seal_record(value))
    label_ids = {base.text(row.get("sample_id"), "label sample_id") for row in remapped}
    if label_ids & recrop_ids:
        raise base.HighValueSupervisedLabelError(
            "recrop/ruby/split row was promoted into positive or negative supervision"
        )

    result = copy.deepcopy(dict(summary))
    counts = dict(base.mapping(result.get("counts"), "direct counts"))
    shards = copy.deepcopy(list(counts.get("review_shards", ())))
    if len(shards) != 1 or list(shards[0].get("row_span", ())) != list(local_span):
        raise base.HighValueSupervisedLabelError("local review shard span drifted")
    shards[0]["row_span"] = list(direct_span)
    counts["expected_queue_row_span"] = list(direct_span)
    counts["review_shards"] = shards
    counts["recrop_ruby_split_excluded_rows"] = len(recrop_ids)
    counts["recrop_ruby_split_positive_promotions"] = 0
    counts["recrop_ruby_split_negative_promotions"] = 0
    duplicate_counts = dict(
        base.mapping(counts.get("duplicate_counts"), "duplicate counts")
    )
    duplicate_counts.update(
        {"prior_cumulative_review_ids": 0, "prior_cumulative_sample_ids": 0}
    )
    counts["duplicate_counts"] = duplicate_counts
    exclusions = base.mapping(counts.get("exclusions"), "direct exclusions")
    if (
        int(counts.get("blind_rows_consumed", -1)) != EXPECTED_REVIEW_ROWS
        or int(counts.get("excluded_rows", -1))
        != expected_recrop_rows + int(exclusions.get("adapter_validation_work", 0))
        or int(exclusions.get("decision_not_completed", 0)) != expected_recrop_rows
        or int(counts.get("training_label_rows", -1)) != len(remapped)
    ):
        raise base.HighValueSupervisedLabelError(
            "direct eligibility accounting drifted"
        )

    lineage = dict(base.mapping(result.get("lineage"), "direct lineage"))
    blind_decisions = copy.deepcopy(list(lineage.get("blind_decisions", ())))
    if len(blind_decisions) != 1:
        raise base.HighValueSupervisedLabelError("blind decision lineage drifted")
    blind_decisions[0]["row_span"] = list(direct_span)
    lineage["blind_decisions"] = blind_decisions
    lineage["prior_cumulative_duplicate_guard"] = copy.deepcopy(prior_guard)
    lineage["review_exclusions"] = copy.deepcopy(review_sources)
    range_sealer = dict(base.mapping(lineage.get("range_sealer"), "range sealer"))
    range_sealer.update(
        {
            "build_mode": BUILD_MODE_RANGE,
            "range_id": range_id,
            "global_queue_row_offset": GLOBAL_OFFSET,
            "global_queue_row_span": list(direct_span),
            "private_json_decoded_local_row_span": list(local_span),
            "private_suffix_records_read": 0,
            "recrop_ruby_split_positive_promotions": 0,
            "recrop_ruby_split_negative_promotions": 0,
        }
    )
    lineage["range_sealer"] = range_sealer
    for name in ("private_bindings", "public_queue"):
        boundary = dict(base.mapping(lineage.get(name), name))
        boundary["global_queue_row_span"] = list(direct_span)
        lineage[name] = boundary
    result["counts"] = counts
    result["lineage"] = lineage
    base.assert_no_private_model_fields(result, "remapped direct summary")
    return remapped, result


def build_direct(
    *,
    range_id: str,
    queue_dir: Path,
    review_dir: Path,
    old_cumulative_dir: Path,
    base_dataset_dir: Path,
    master_manifest: Path,
    val33_file: Path,
    blind_pool_files: Sequence[Path],
    qa_cohort_files: Sequence[Path],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if range_id not in RANGE_SPECS:
        raise base.HighValueSupervisedLabelError("unsupported range id")
    spec = RANGE_SPECS[range_id]
    local_span = list(spec["local_span"])
    direct_span = list(spec["direct_span"])
    expected_recrop_rows = int(spec["expected_recrop_rows"])
    decisions, recrop_ids, review_sources = _load_review_contract(
        review_dir,
        range_id=range_id,
        local_span=local_span,
        expected_recrop_rows=expected_recrop_rows,
    )
    prior_guard = _guard_prior_duplicates(
        old_cumulative_dir=old_cumulative_dir,
        decisions=decisions,
        range_id=range_id,
    )
    labels, summary = prior._build_range_labels(
        queue_dir=queue_dir,
        review_dir=review_dir,
        start_row=local_span[0],
        end_row=local_span[1],
        base_dataset_dir=base_dataset_dir,
        master_manifest=master_manifest,
        val33_file=val33_file,
        blind_pool_files=blind_pool_files,
        qa_cohort_files=qa_cohort_files,
    )
    return _remap_direct(
        labels,
        summary,
        range_id=range_id,
        local_span=local_span,
        direct_span=direct_span,
        expected_recrop_rows=expected_recrop_rows,
        recrop_ids=recrop_ids,
        review_sources=review_sources,
        prior_guard=prior_guard,
    )


def _publish(
    output_dir: Path,
    *,
    labels: Sequence[Mapping[str, Any]],
    summary: Mapping[str, Any],
    byte_stable_prefix_path: Path | None = None,
    expected_prefix_rows: int | None = None,
) -> Mapping[str, Any]:
    output = base.safe_output(output_dir)
    if output.exists():
        raise base.HighValueSupervisedLabelError("output directory already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        base.write_jsonl(staging / base.LABELS_FILE, labels)
        published_summary = copy.deepcopy(dict(summary))
        if byte_stable_prefix_path is not None:
            prefix_path = byte_stable_prefix_path.expanduser().resolve()
            if prefix_path.is_symlink() or not prefix_path.is_file():
                raise base.HighValueSupervisedLabelError(
                    "byte-stable prefix source is invalid"
                )
            prefix_bytes = prefix_path.read_bytes()
            if not prefix_bytes.endswith(b"\n"):
                raise base.HighValueSupervisedLabelError(
                    "byte-stable prefix source lacks final newline"
                )
            actual_bytes = (staging / base.LABELS_FILE).read_bytes()
            if actual_bytes[: len(prefix_bytes)] != prefix_bytes:
                raise base.HighValueSupervisedLabelError(
                    "001..1200 label bytes are not an exact output prefix"
                )
            prefix_rows = len(prefix_bytes.splitlines())
            if expected_prefix_rows is None or prefix_rows != expected_prefix_rows:
                raise base.HighValueSupervisedLabelError(
                    "byte-stable prefix row count drifted"
                )
            lineage = dict(
                base.mapping(published_summary.get("lineage"), "publish lineage")
            )
            lineage["byte_stable_prefix"] = {
                "byte_size": len(prefix_bytes),
                "exact_prefix_verified": True,
                "row_count": prefix_rows,
                "sha256": base.sha256_bytes(prefix_bytes),
                "source_file": str(prefix_path),
            }
            published_summary["lineage"] = lineage
        manifest = base.seal_record(
            {
                "authority": {
                    "automatic_label_promotion_allowed": False,
                    "automatic_release_authority": False,
                    "calibration_eligible": False,
                    "evaluation_eligible": False,
                    "human_gold": False,
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "training_eligible": True,
                    "training_only": True,
                },
                "candidate_ids": list(published_summary["candidate_ids"]),
                "counts": copy.deepcopy(published_summary["counts"]),
                "labels": base.descriptor(
                    staging / base.LABELS_FILE, row_count=len(labels)
                ),
                "lineage": copy.deepcopy(published_summary["lineage"]),
                "overlap": copy.deepcopy(published_summary["overlap"]),
                "record_type": "manga_font_v2_high_value_supervised_labels_manifest",
                "schema_version": base.SCHEMA,
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
            }
        )
        base.assert_no_private_model_fields(manifest)
        (staging / base.MANIFEST_FILE).write_bytes(
            base.json_bytes(manifest, pretty=True)
        )
        report = base.seal_record(
            {
                "artifacts": {
                    base.LABELS_FILE: base.descriptor(
                        staging / base.LABELS_FILE, row_count=len(labels)
                    ),
                    base.MANIFEST_FILE: base.descriptor(staging / base.MANIFEST_FILE),
                },
                "counts": copy.deepcopy(published_summary["counts"]),
                "manifest_record_sha256": manifest["record_sha256"],
                "overlap": copy.deepcopy(published_summary["overlap"]),
                "record_type": "manga_font_v2_high_value_supervised_labels_report",
                "schema_version": base.SCHEMA,
            }
        )
        base.assert_no_private_model_fields(report)
        (staging / base.REPORT_FILE).write_bytes(base.json_bytes(report, pretty=True))
        marker = base.seal_record(
            {
                "artifacts": {
                    base.LABELS_FILE: base.sha256_file(staging / base.LABELS_FILE),
                    base.MANIFEST_FILE: base.sha256_file(staging / base.MANIFEST_FILE),
                    base.REPORT_FILE: base.sha256_file(staging / base.REPORT_FILE),
                },
                "owner": base.OWNER,
                "safe_replace": True,
                "schema_version": base.SCHEMA,
            }
        )
        (staging / base.MARKER_FILE).write_bytes(base.json_bytes(marker, pretty=True))
        validate_output(staging, require_current_source=True)
        os.replace(staging, output)
        published = True
        return validate_output(output, require_current_source=True)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def _merge_counts(
    manifests: Sequence[Mapping[str, Any]], labels: Sequence[Mapping[str, Any]]
) -> Mapping[str, Any]:
    queue_rows = [int(row["queue_row"]) for row in labels]
    sample_ids = [base.text(row.get("sample_id"), "label sample_id") for row in labels]
    review_ids = [
        base.text(
            base.mapping(row.get("review_binding"), "review binding").get("review_id"),
            "review id",
        )
        for row in labels
    ]
    if (
        len(queue_rows) != len(set(queue_rows))
        or len(sample_ids) != len(set(sample_ids))
        or len(review_ids) != len(set(review_ids))
    ):
        raise base.HighValueSupervisedLabelError("sealed shard merge has duplicates")
    role_counts: Counter[str] = Counter()
    preferred_counts: Counter[str] = Counter()
    positive_counts: Counter[str] = Counter()
    work_counts: Counter[str] = Counter()
    source_pages: set[str] = set()
    for row in labels:
        role_counts[base.text(row.get("role"), "label role")] += 1
        candidates = base.mapping(row.get("candidate_labels"), "candidate labels")
        preferred_counts.update(
            str(value) for value in candidates.get("preferred_candidate_ids", ())
        )
        positive_counts.update(
            str(value) for value in candidates.get("positive_candidate_ids", ())
        )
        identity = base.mapping(row.get("identity"), "label identity")
        work_counts[base.text(identity.get("work_id"), "label work_id")] += 1
        source_pages.add(
            base.text(identity.get("source_page_sha256"), "label source page")
        )

    exclusions: Counter[str] = Counter()
    review_shards: list[dict[str, Any]] = []
    blind_rows = 0
    recrop_rows = 0
    for manifest in manifests:
        counts = base.mapping(manifest.get("counts"), "source counts")
        blind_rows += int(counts.get("blind_rows_consumed", -1))
        exclusions.update(
            {
                str(key): int(value)
                for key, value in base.mapping(
                    counts.get("exclusions"), "source exclusions"
                ).items()
            }
        )
        review_shards.extend(copy.deepcopy(list(counts.get("review_shards", ()))))
        recrop_rows += int(
            counts.get(
                "recrop_ruby_split_excluded_rows",
                counts.get("r2_recrop_ruby_split_excluded_rows", 0),
            )
        )
    review_shards.sort(key=lambda row: int(row["row_span"][0]))
    if [list(row["row_span"]) for row in review_shards] != EXPECTED_SHARDS:
        raise base.HighValueSupervisedLabelError("merged review shard spans drifted")
    if (
        blind_rows != EXPECTED_CUMULATIVE_BLIND_ROWS
        or blind_rows - len(labels) != sum(exclusions.values())
    ):
        raise base.HighValueSupervisedLabelError(
            "merged eligibility accounting drifted"
        )
    return {
        "blind_rows_consumed": blind_rows,
        "duplicate_counts": {
            "decision_queue_rows": 0,
            "decision_review_ids": 0,
            "decision_sample_ids": 0,
            "prior_cumulative_review_ids": 0,
            "prior_cumulative_sample_ids": 0,
            "training_sample_ids": 0,
        },
        "excluded_rows": sum(exclusions.values()),
        "exclusions": dict(sorted(exclusions.items())),
        "expected_queue_row_span": CUMULATIVE_SPAN,
        "positive_candidate_counts": dict(sorted(positive_counts.items())),
        "preferred_candidate_counts": dict(sorted(preferred_counts.items())),
        "recrop_ruby_split_excluded_rows": recrop_rows,
        "recrop_ruby_split_positive_promotions": 0,
        "recrop_ruby_split_negative_promotions": 0,
        "review_shards": review_shards,
        "role_counts": dict(sorted(role_counts.items())),
        "source_page_count": len(source_pages),
        "training_label_rows": len(labels),
        "work_count": len(work_counts),
        "work_row_counts": dict(sorted(work_counts.items())),
    }


def merge_sealed_shards(
    *,
    old_cumulative_dir: Path,
    new_shard_1201_1400_dir: Path,
    new_shard_1401_1600_dir: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    roots = (
        old_cumulative_dir.expanduser().resolve(),
        new_shard_1201_1400_dir.expanduser().resolve(),
        new_shard_1401_1600_dir.expanduser().resolve(),
    )
    validations = [
        base.validate_output(roots[0]),
        validate_output(roots[1]),
        validate_output(roots[2]),
    ]
    manifests = [
        base.read_json(root / base.MANIFEST_FILE, "source manifest") for root in roots
    ]
    spans = [
        list(
            base.mapping(row.get("counts"), "source counts").get(
                "expected_queue_row_span", ()
            )
        )
        for row in manifests
    ]
    if spans != [EXPECTED_PRIOR_SPAN, [1201, 1400], [1401, 1600]]:
        raise base.HighValueSupervisedLabelError("source shard spans drifted")
    candidate_ids = [tuple(row.get("candidate_ids", ())) for row in manifests]
    if not candidate_ids[0] or any(
        candidate_id_inventory != candidate_ids[0]
        for candidate_id_inventory in candidate_ids[1:]
    ):
        raise base.HighValueSupervisedLabelError("source candidate inventories drifted")
    overlaps = [
        dict(base.mapping(row.get("overlap"), "source overlap")) for row in manifests
    ]
    if any(set(overlap) != EXPECTED_OVERLAP_KEYS for overlap in overlaps) or any(
        int(value) != 0 for overlap in overlaps for value in overlap.values()
    ):
        raise base.HighValueSupervisedLabelError("source heldout overlap is nonzero")
    old_labels = _read_labels(roots[0])
    if len(old_labels) != EXPECTED_PRIOR_LABEL_ROWS:
        raise base.HighValueSupervisedLabelError("001..1200 label prefix count drifted")
    new_labels = sorted(
        [row for root in roots[1:] for row in _read_labels(root)],
        key=lambda row: int(row["queue_row"]),
    )
    if [int(row["queue_row"]) for row in old_labels] != sorted(
        int(row["queue_row"]) for row in old_labels
    ) or any(int(row["queue_row"]) <= EXPECTED_PRIOR_SPAN[1] for row in new_labels):
        raise base.HighValueSupervisedLabelError(
            "byte-stable prefix ordering boundary drifted"
        )
    labels = [*old_labels, *new_labels]
    counts = _merge_counts(manifests, labels)
    lineage = {
        "range_sealer": {
            "build_mode": BUILD_MODE_MERGE,
            "private_bindings_reopened_for_old_shards": False,
            "r2_private_bindings_decoded_local_row_spans": [
                list(RANGE_SPECS["1201-1400"]["local_span"]),
                list(RANGE_SPECS["1401-1600"]["local_span"]),
            ],
            "r2_private_suffix_records_read": 0,
            "source_row_spans": spans,
        },
        "sealed_training_only_sources": [
            {
                "labels": base.source_descriptor(
                    root / base.LABELS_FILE,
                    row_count=int(validation["training_label_rows"]),
                ),
                "manifest": base.source_descriptor(root / base.MANIFEST_FILE),
                "output_dir": str(root),
                "report": base.source_descriptor(root / base.REPORT_FILE),
                "validation": dict(validation),
            }
            for root, validation in zip(roots, validations, strict=True)
        ],
        "source_boundary_lineage": [
            copy.deepcopy(row.get("lineage")) for row in manifests
        ],
    }
    summary = {
        "candidate_ids": candidate_ids[0],
        "counts": counts,
        "lineage": lineage,
        "overlap": overlaps[0],
    }
    base.assert_no_private_model_fields(summary, "merged summary")
    return _publish(
        output_dir,
        labels=labels,
        summary=summary,
        byte_stable_prefix_path=roots[0] / base.LABELS_FILE,
        expected_prefix_rows=EXPECTED_PRIOR_LABEL_ROWS,
    )


def validate_output(
    output_dir: Path, *, require_current_source: bool = False
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    result = dict(base.validate_output(root))
    manifest = base.read_json(root / base.MANIFEST_FILE, "range manifest")
    if require_current_source and manifest.get(
        "source_code_sha256"
    ) != base.sha256_file(Path(__file__).resolve()):
        raise base.HighValueSupervisedLabelError("range-v6 sealer source drifted")
    counts = base.mapping(manifest.get("counts"), "range counts")
    span = list(counts.get("expected_queue_row_span", ()))
    labels = _read_labels(root)
    queue_rows = [int(row["queue_row"]) for row in labels]
    direct_specs = {
        tuple(spec["direct_span"]): spec for spec in RANGE_SPECS.values()
    }
    if tuple(span) not in {*direct_specs, tuple(CUMULATIVE_SPAN)}:
        raise base.HighValueSupervisedLabelError("unsupported sealed range")
    if any(not span[0] <= row <= span[1] for row in queue_rows):
        raise base.HighValueSupervisedLabelError("training label escaped sealed range")
    overlap = base.mapping(manifest.get("overlap"), "range overlap")
    if set(overlap) != EXPECTED_OVERLAP_KEYS or any(
        int(value) != 0 for value in overlap.values()
    ):
        raise base.HighValueSupervisedLabelError(
            "protected heldout overlap is nonzero or incomplete"
        )
    for key in (
        "recrop_ruby_split_positive_promotions",
        "recrop_ruby_split_negative_promotions",
    ):
        if int(counts.get(key, -1)) != 0:
            raise base.HighValueSupervisedLabelError(f"{key} is nonzero")
    direct_spec = direct_specs.get(tuple(span))
    if direct_spec is not None and (
        int(counts.get("blind_rows_consumed", -1)) != EXPECTED_REVIEW_ROWS
        or int(counts.get("recrop_ruby_split_excluded_rows", -1))
        != int(direct_spec["expected_recrop_rows"])
    ):
        raise base.HighValueSupervisedLabelError("direct exclusion contract drifted")
    if span == CUMULATIVE_SPAN:
        if int(counts.get("blind_rows_consumed", -1)) != EXPECTED_CUMULATIVE_BLIND_ROWS:
            raise base.HighValueSupervisedLabelError(
                "cumulative row accounting drifted"
            )
        lineage = base.mapping(manifest.get("lineage"), "cumulative lineage")
        prefix = base.mapping(
            lineage.get("byte_stable_prefix"), "byte-stable prefix lineage"
        )
        byte_size = int(prefix.get("byte_size", -1))
        label_bytes = (root / base.LABELS_FILE).read_bytes()
        prefix_bytes = label_bytes[:byte_size]
        if (
            prefix.get("exact_prefix_verified") is not True
            or int(prefix.get("row_count", -1)) != EXPECTED_PRIOR_LABEL_ROWS
            or byte_size <= 0
            or len(prefix_bytes) != byte_size
            or len(prefix_bytes.splitlines()) != EXPECTED_PRIOR_LABEL_ROWS
            or not prefix_bytes.endswith(b"\n")
            or prefix.get("sha256") != base.sha256_bytes(prefix_bytes)
        ):
            raise base.HighValueSupervisedLabelError(
                "cumulative byte-stable prefix attestation drifted"
            )
    return {
        **result,
        "expected_queue_row_span": span,
        "recrop_ruby_split_positive_promotions": 0,
        "recrop_ruby_split_negative_promotions": 0,
        "byte_stable_prefix_rows": (
            EXPECTED_PRIOR_LABEL_ROWS if span == CUMULATIVE_SPAN else 0
        ),
        "source_code_sha256": manifest["source_code_sha256"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-range")
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--range-id", choices=tuple(RANGE_SPECS), required=True)
    build.add_argument(
        "--queue-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-v2-high-value-supervised-queue-r2-801-1600-"
            "training-only-r1"
        ),
    )
    build.add_argument(
        "--review-dir",
        type=Path,
    )
    build.add_argument(
        "--old-cumulative-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-1200-"
            "training-only-r1"
        ),
    )
    build.add_argument(
        "--base-dataset-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout"
        ),
    )
    build.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
    build.add_argument(
        "--val33-file",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-human-overlay-adjudicated-val33-v1/"
            "val-samples-adjudicated.jsonl"
        ),
    )
    build.add_argument("--blind-pool-file", action="append", type=Path, default=[])
    build.add_argument("--qa-cohort-file", action="append", type=Path, default=[])
    merge = commands.add_parser("merge")
    merge.add_argument("--old-cumulative-dir", type=Path, required=True)
    merge.add_argument("--new-shard-1201-1400-dir", type=Path, required=True)
    merge.add_argument("--new-shard-1401-1600-dir", type=Path, required=True)
    merge.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        if args.command == "build-range":
            prior._boundary_defaults(args)
            review_dir = args.review_dir or RANGE_SPECS[args.range_id][
                "default_review_dir"
            ]
            labels, summary = build_direct(
                range_id=args.range_id,
                queue_dir=args.queue_dir,
                review_dir=Path(review_dir),
                old_cumulative_dir=args.old_cumulative_dir,
                base_dataset_dir=args.base_dataset_dir,
                master_manifest=args.master_manifest,
                val33_file=args.val33_file,
                blind_pool_files=tuple(args.blind_pool_file),
                qa_cohort_files=tuple(args.qa_cohort_file),
            )
            result = _publish(args.output_dir, labels=labels, summary=summary)
        elif args.command == "merge":
            result = merge_sealed_shards(
                old_cumulative_dir=args.old_cumulative_dir,
                new_shard_1201_1400_dir=args.new_shard_1201_1400_dir,
                new_shard_1401_1600_dir=args.new_shard_1401_1600_dir,
                output_dir=args.output_dir,
            )
        else:
            result = validate_output(args.output_dir)
    except (base.HighValueSupervisedLabelError, OSError, KeyError, ValueError) as error:
        raise SystemExit(f"range-v6 high-value sealer error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
