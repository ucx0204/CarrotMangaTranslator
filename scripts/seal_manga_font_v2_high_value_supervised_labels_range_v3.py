#!/usr/bin/env python3
"""Range-gated 601..800 deblinding and sealed 001..800 accumulation.

This extends the audited range-v2 reader without changing it or any existing
001..600 artifact.  Only the requested private JSON line span is decoded; old
private bindings are never reopened during cumulative merging.
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
    from scripts import seal_manga_font_v2_high_value_supervised_labels_range_v2 as prior
except ImportError:  # pragma: no cover - direct script execution
    import seal_manga_font_v2_high_value_supervised_labels_range_v2 as prior


base = prior.base
BUILD_MODE_RANGE = "direct_range_deblind"
BUILD_MODE_MERGE = "sealed_shard_merge"
DIRECT_SPAN = [601, 800]
CUMULATIVE_SPAN = [1, 800]


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
                    base.MANIFEST_FILE: base.descriptor(
                        staging / base.MANIFEST_FILE
                    ),
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


def _read_labels(root: Path) -> list[dict[str, Any]]:
    return list(base.iter_jsonl(root / base.LABELS_FILE, "sealed training labels"))


def _merge_counts(
    manifests: Sequence[Mapping[str, Any]],
    labels: Sequence[Mapping[str, Any]],
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
    review_shards.sort(key=lambda row: int(row["row_span"][0]))
    shard_spans = [list(row["row_span"]) for row in review_shards]
    if shard_spans != [[1, 200], [201, 400], [401, 600], [601, 800]]:
        raise base.HighValueSupervisedLabelError("merged review shard spans drifted")
    if blind_rows != 800 or blind_rows - len(labels) != sum(exclusions.values()):
        raise base.HighValueSupervisedLabelError("merged eligibility accounting drifted")
    return {
        "blind_rows_consumed": blind_rows,
        "duplicate_counts": {
            "decision_queue_rows": 0,
            "decision_review_ids": 0,
            "decision_sample_ids": 0,
            "training_sample_ids": 0,
        },
        "excluded_rows": sum(exclusions.values()),
        "exclusions": dict(sorted(exclusions.items())),
        "expected_queue_row_span": CUMULATIVE_SPAN,
        "positive_candidate_counts": dict(sorted(positive_counts.items())),
        "preferred_candidate_counts": dict(sorted(preferred_counts.items())),
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
    new_shard_dir: Path,
    output_dir: Path,
) -> Mapping[str, Any]:
    roots = (
        old_cumulative_dir.expanduser().resolve(),
        new_shard_dir.expanduser().resolve(),
    )
    validations = [base.validate_output(root) for root in roots]
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
    if spans != [[1, 600], [601, 800]]:
        raise base.HighValueSupervisedLabelError("source shard spans drifted")
    candidate_ids = [tuple(row.get("candidate_ids", ())) for row in manifests]
    if not candidate_ids[0] or candidate_ids[0] != candidate_ids[1]:
        raise base.HighValueSupervisedLabelError("source candidate inventories drifted")
    overlaps = [
        dict(base.mapping(row.get("overlap"), "source overlap")) for row in manifests
    ]
    if (
        overlaps[0].keys() != overlaps[1].keys()
        or any(int(value) != 0 for overlap in overlaps for value in overlap.values())
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
    if (
        require_current_source
        and manifest.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise base.HighValueSupervisedLabelError("range sealer source drifted")
    counts = base.mapping(manifest.get("counts"), "range counts")
    span = list(counts.get("expected_queue_row_span", ()))
    labels = _read_labels(root)
    queue_rows = [int(row["queue_row"]) for row in labels]
    if span not in (DIRECT_SPAN, CUMULATIVE_SPAN):
        raise base.HighValueSupervisedLabelError("unsupported sealed range")
    if any(not span[0] <= row <= span[1] for row in queue_rows):
        raise base.HighValueSupervisedLabelError("training label escaped sealed range")
    if any(int(value) != 0 for value in manifest.get("overlap", {}).values()):
        raise base.HighValueSupervisedLabelError("heldout overlap is nonzero")
    return {
        **result,
        "expected_queue_row_span": span,
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
        default=Path("artifacts/manga-font-v2-high-value-supervised-queue-r1-800"),
    )
    build.add_argument("--review-dir", type=Path, required=True)
    build.add_argument("--start-row", type=int, required=True)
    build.add_argument("--end-row", type=int, required=True)
    build.add_argument(
        "--base-dataset-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout"),
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
            if [args.start_row, args.end_row] != DIRECT_SPAN:
                raise base.HighValueSupervisedLabelError(
                    "v3 direct build is restricted to rows 601..800"
                )
            prior._boundary_defaults(args)
            labels, summary = prior._build_range_labels(
                queue_dir=args.queue_dir,
                review_dir=args.review_dir,
                start_row=args.start_row,
                end_row=args.end_row,
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
        raise SystemExit(f"range-v3 high-value sealer error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
