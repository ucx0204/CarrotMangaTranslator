#!/usr/bin/env python3
"""Deblind r2 queue rows 201..400 as global rows 1001..1200.

The public reviewer saw only opaque A..G slots.  This sealer JSON-decodes
exactly private r2 bindings 201..400 after review, excludes every recrop/ruby/
split row from both positive and negative supervision, and fails closed against
the immutable 001..1000 labels plus every protected validation/evaluation/QA
boundary.  It publishes a training-only shard and an optional immutable
001..1200 cumulative artifact; it never trains a model.
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
    from scripts import seal_manga_font_v2_high_value_supervised_labels_range_v4 as v4
except ImportError:  # pragma: no cover - direct script execution
    import seal_manga_font_v2_high_value_supervised_labels_range_v4 as v4


prior = v4.prior
base = v4.base
BUILD_MODE_RANGE = "r2_local_range_deblind_global_remap_v5"
BUILD_MODE_MERGE = "sealed_shard_merge_v5"
LOCAL_SPAN = [201, 400]
DIRECT_SPAN = [1001, 1200]
CUMULATIVE_SPAN = [1, 1200]
GLOBAL_OFFSET = 800
EXPECTED_REVIEW_ROWS = 200
EXPECTED_RECROP_ROWS = 19
EXPECTED_PRIOR_LABEL_ROWS = 865
EXPECTED_SHARDS = [
    [1, 200],
    [201, 400],
    [401, 600],
    [601, 800],
    [801, 1000],
    DIRECT_SPAN,
]


def _read_labels(root: Path) -> list[dict[str, Any]]:
    return list(base.iter_jsonl(root / base.LABELS_FILE, "sealed training labels"))


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
) -> tuple[list[dict[str, Any]], set[str], Mapping[str, Any]]:
    root = review_dir.expanduser().resolve()
    decisions = list(
        base.iter_jsonl(root / "decisions-public-blind.jsonl", "blind decisions")
    )
    recrop = list(base.iter_jsonl(root / "recrop-review.jsonl", "recrop review"))
    report = base.read_json(root / "report.json", "blind review report")
    base.validate_record_seal(report, "blind review report")
    if len(decisions) != EXPECTED_REVIEW_ROWS or len(recrop) != EXPECTED_RECROP_ROWS:
        raise base.HighValueSupervisedLabelError(
            "1001..1200 review/recrop count drifted"
        )
    queue_rows = [int(row.get("queue_row", -1)) for row in decisions]
    if queue_rows != list(range(LOCAL_SPAN[0], LOCAL_SPAN[1] + 1)):
        raise base.HighValueSupervisedLabelError(
            "1001..1200 blind decisions are not local rows 201..400"
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
            "report": base.source_descriptor(root / "report.json"),
        },
    )


def _guard_prior_duplicates(
    *, old_cumulative_dir: Path, decisions: Sequence[Mapping[str, Any]]
) -> Mapping[str, Any]:
    root = old_cumulative_dir.expanduser().resolve()
    validation = base.validate_output(root)
    manifest = base.read_json(root / base.MANIFEST_FILE, "old cumulative manifest")
    counts = base.mapping(manifest.get("counts"), "old cumulative counts")
    old_labels = _read_labels(root)
    if (
        list(counts.get("expected_queue_row_span", ())) != [1, 1000]
        or len(old_labels) != EXPECTED_PRIOR_LABEL_ROWS
        or int(counts.get("training_label_rows", -1)) != EXPECTED_PRIOR_LABEL_ROWS
    ):
        raise base.HighValueSupervisedLabelError(
            "001..1000 cumulative boundary drifted"
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
            "1001..1200 review repeats an existing 001..1000 sample/review identity"
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
    if len(shards) != 1 or list(shards[0].get("row_span", ())) != LOCAL_SPAN:
        raise base.HighValueSupervisedLabelError("local review shard span drifted")
    shards[0]["row_span"] = DIRECT_SPAN
    counts["expected_queue_row_span"] = DIRECT_SPAN
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
        != EXPECTED_RECROP_ROWS + int(exclusions.get("adapter_validation_work", 0))
        or int(exclusions.get("decision_not_completed", 0)) != EXPECTED_RECROP_ROWS
        or int(counts.get("training_label_rows", -1)) != len(remapped)
    ):
        raise base.HighValueSupervisedLabelError(
            "direct eligibility accounting drifted"
        )

    lineage = dict(base.mapping(result.get("lineage"), "direct lineage"))
    blind_decisions = copy.deepcopy(list(lineage.get("blind_decisions", ())))
    if len(blind_decisions) != 1:
        raise base.HighValueSupervisedLabelError("blind decision lineage drifted")
    blind_decisions[0]["row_span"] = DIRECT_SPAN
    lineage["blind_decisions"] = blind_decisions
    lineage["prior_cumulative_duplicate_guard"] = copy.deepcopy(prior_guard)
    lineage["review_exclusions"] = copy.deepcopy(review_sources)
    range_sealer = dict(base.mapping(lineage.get("range_sealer"), "range sealer"))
    range_sealer.update(
        {
            "build_mode": BUILD_MODE_RANGE,
            "global_queue_row_offset": GLOBAL_OFFSET,
            "global_queue_row_span": DIRECT_SPAN,
            "private_json_decoded_local_row_span": LOCAL_SPAN,
            "private_suffix_records_read": 0,
            "recrop_ruby_split_positive_promotions": 0,
            "recrop_ruby_split_negative_promotions": 0,
        }
    )
    lineage["range_sealer"] = range_sealer
    for name in ("private_bindings", "public_queue"):
        boundary = dict(base.mapping(lineage.get(name), name))
        boundary["global_queue_row_span"] = DIRECT_SPAN
        lineage[name] = boundary
    result["counts"] = counts
    result["lineage"] = lineage
    base.assert_no_private_model_fields(result, "remapped direct summary")
    return remapped, result


def build_direct(
    *,
    queue_dir: Path,
    review_dir: Path,
    old_cumulative_dir: Path,
    base_dataset_dir: Path,
    master_manifest: Path,
    val33_file: Path,
    blind_pool_files: Sequence[Path],
    qa_cohort_files: Sequence[Path],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    decisions, recrop_ids, review_sources = _load_review_contract(review_dir)
    prior_guard = _guard_prior_duplicates(
        old_cumulative_dir=old_cumulative_dir, decisions=decisions
    )
    labels, summary = prior._build_range_labels(
        queue_dir=queue_dir,
        review_dir=review_dir,
        start_row=LOCAL_SPAN[0],
        end_row=LOCAL_SPAN[1],
        base_dataset_dir=base_dataset_dir,
        master_manifest=master_manifest,
        val33_file=val33_file,
        blind_pool_files=blind_pool_files,
        qa_cohort_files=qa_cohort_files,
    )
    return _remap_direct(
        labels,
        summary,
        recrop_ids=recrop_ids,
        review_sources=review_sources,
        prior_guard=prior_guard,
    )


def _publish(
    output_dir: Path,
    *,
    labels: Sequence[Mapping[str, Any]],
    summary: Mapping[str, Any],
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
                "candidate_ids": list(summary["candidate_ids"]),
                "counts": copy.deepcopy(summary["counts"]),
                "labels": base.descriptor(
                    staging / base.LABELS_FILE, row_count=len(labels)
                ),
                "lineage": copy.deepcopy(summary["lineage"]),
                "overlap": copy.deepcopy(summary["overlap"]),
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
                "counts": copy.deepcopy(summary["counts"]),
                "manifest_record_sha256": manifest["record_sha256"],
                "overlap": copy.deepcopy(summary["overlap"]),
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
    if blind_rows != 1200 or blind_rows - len(labels) != sum(exclusions.values()):
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
    *, old_cumulative_dir: Path, new_shard_dir: Path, output_dir: Path
) -> Mapping[str, Any]:
    roots = (
        old_cumulative_dir.expanduser().resolve(),
        new_shard_dir.expanduser().resolve(),
    )
    validations = [base.validate_output(roots[0]), validate_output(roots[1])]
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
    if spans != [[1, 1000], DIRECT_SPAN]:
        raise base.HighValueSupervisedLabelError("source shard spans drifted")
    candidate_ids = [tuple(row.get("candidate_ids", ())) for row in manifests]
    if not candidate_ids[0] or candidate_ids[0] != candidate_ids[1]:
        raise base.HighValueSupervisedLabelError("source candidate inventories drifted")
    overlaps = [
        dict(base.mapping(row.get("overlap"), "source overlap")) for row in manifests
    ]
    if overlaps[0].keys() != overlaps[1].keys() or any(
        int(value) != 0 for overlap in overlaps for value in overlap.values()
    ):
        raise base.HighValueSupervisedLabelError("source heldout overlap is nonzero")
    labels = sorted(
        [row for root in roots for row in _read_labels(root)],
        key=lambda row: int(row["queue_row"]),
    )
    counts = _merge_counts(manifests, labels)
    lineage = {
        "range_sealer": {
            "build_mode": BUILD_MODE_MERGE,
            "private_bindings_reopened_for_old_shards": False,
            "r2_private_bindings_decoded_local_row_span": LOCAL_SPAN,
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
    return _publish(output_dir, labels=labels, summary=summary)


def validate_output(
    output_dir: Path, *, require_current_source: bool = False
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    result = dict(base.validate_output(root))
    manifest = base.read_json(root / base.MANIFEST_FILE, "range manifest")
    if require_current_source and manifest.get(
        "source_code_sha256"
    ) != base.sha256_file(Path(__file__).resolve()):
        raise base.HighValueSupervisedLabelError("range-v5 sealer source drifted")
    counts = base.mapping(manifest.get("counts"), "range counts")
    span = list(counts.get("expected_queue_row_span", ()))
    labels = _read_labels(root)
    queue_rows = [int(row["queue_row"]) for row in labels]
    if span not in (DIRECT_SPAN, CUMULATIVE_SPAN):
        raise base.HighValueSupervisedLabelError("unsupported sealed range")
    if any(not span[0] <= row <= span[1] for row in queue_rows):
        raise base.HighValueSupervisedLabelError("training label escaped sealed range")
    overlap = base.mapping(manifest.get("overlap"), "range overlap")
    expected_overlap_keys = {
        "adapter_validation",
        "adapter_validation_work",
        "blind_calibration",
        "blind_evaluation",
        "master_test",
        "master_val",
        "qa_pages",
        "val33",
    }
    if set(overlap) != expected_overlap_keys or any(
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
    if span == DIRECT_SPAN and (
        int(counts.get("blind_rows_consumed", -1)) != EXPECTED_REVIEW_ROWS
        or int(counts.get("recrop_ruby_split_excluded_rows", -1))
        != EXPECTED_RECROP_ROWS
    ):
        raise base.HighValueSupervisedLabelError(
            "direct 1001..1200 exclusion contract drifted"
        )
    if span == CUMULATIVE_SPAN and int(counts.get("blind_rows_consumed", -1)) != 1200:
        raise base.HighValueSupervisedLabelError("cumulative row accounting drifted")
    return {
        **result,
        "expected_queue_row_span": span,
        "recrop_ruby_split_positive_promotions": 0,
        "recrop_ruby_split_negative_promotions": 0,
        "source_code_sha256": manifest["source_code_sha256"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-range")
    build.add_argument("--output-dir", type=Path, required=True)
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
        default=Path(
            "artifacts/manga-font-v2-high-value-blind-review-agent-1001-1200-"
            "public-only-r1"
        ),
    )
    build.add_argument(
        "--old-cumulative-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-1000-"
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
    merge.add_argument("--new-shard-dir", type=Path, required=True)
    merge.add_argument("--output-dir", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        if args.command == "build-range":
            prior._boundary_defaults(args)
            labels, summary = build_direct(
                queue_dir=args.queue_dir,
                review_dir=args.review_dir,
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
                new_shard_dir=args.new_shard_dir,
                output_dir=args.output_dir,
            )
        else:
            result = validate_output(args.output_dir)
    except (base.HighValueSupervisedLabelError, OSError, KeyError, ValueError) as error:
        raise SystemExit(f"range-v5 high-value sealer error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
