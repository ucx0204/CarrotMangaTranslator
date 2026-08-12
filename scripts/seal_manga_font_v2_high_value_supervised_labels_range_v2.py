#!/usr/bin/env python3
"""Range-gated deblinding and sealed-shard merge for high-value font labels.

The private queue is JSON-decoded only for the explicitly requested contiguous
line span.  Prefix bytes are scanned solely to reach that span, suffix bytes are
not read, and no private/model sampling fields are published.  Previously
sealed shards are merged without reopening their private bindings.
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
    from scripts import seal_manga_font_v2_high_value_supervised_labels as base
except ImportError:  # pragma: no cover - direct script execution
    import seal_manga_font_v2_high_value_supervised_labels as base


BUILD_MODE_RANGE = "direct_range_deblind"
BUILD_MODE_MERGE = "sealed_shard_merge"


def _range_digest(rows: Sequence[Mapping[str, Any]]) -> str:
    seals = [base.text(row.get("record_sha256"), "range record seal") for row in rows]
    return base.sha256_bytes(("\n".join(seals) + "\n").encode("ascii"))


def load_private_range(
    path: Path, *, start_row: int, end_row: int
) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    """Decode exactly start_row..end_row from a one-record-per-line private file."""

    source = path.expanduser().resolve()
    if (
        start_row < 1
        or end_row < start_row
        or source.is_symlink()
        or not source.is_file()
    ):
        raise base.HighValueSupervisedLabelError("invalid private binding range")
    rows: list[dict[str, Any]] = []
    with source.open("rb") as handle:
        for line_number in range(1, end_row + 1):
            raw = handle.readline()
            if not raw:
                raise base.HighValueSupervisedLabelError(
                    "private binding range exceeds file"
                )
            if line_number < start_row:
                continue
            try:
                value = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise base.HighValueSupervisedLabelError(
                    f"private binding range:{line_number}: invalid JSON"
                ) from error
            row = dict(base.mapping(value, f"private binding range:{line_number}"))
            base.validate_record_seal(row, f"private binding range:{line_number}")
            rows.append(row)
    expected = end_row - start_row + 1
    if len(rows) != expected:
        raise base.HighValueSupervisedLabelError("private range row count drifted")
    attestation = {
        "decoded_row_count": len(rows),
        "decoded_row_span": [start_row, end_row],
        "prefix_records_scanned_not_decoded": start_row - 1,
        "range_record_seals_sha256": _range_digest(rows),
        "source_file": str(source),
        "source_file_byte_size": source.stat().st_size,
        "suffix_records_read": 0,
    }
    return rows, attestation


def load_public_prefix(path: Path, *, end_row: int) -> list[dict[str, Any]]:
    source = path.expanduser().resolve()
    rows: list[dict[str, Any]] = []
    for line_number, row in enumerate(
        base.iter_jsonl(source, "public review queue"), 1
    ):
        if line_number > end_row:
            break
        base.validate_record_seal(row, f"public review queue:{line_number}")
        rows.append(row)
    if len(rows) != end_row:
        raise base.HighValueSupervisedLabelError("public queue prefix is incomplete")
    return rows


def _public_range_attestation(
    path: Path,
    rows: Sequence[Mapping[str, Any]],
    *,
    start_row: int,
    end_row: int,
) -> Mapping[str, Any]:
    selected = list(rows[start_row - 1 : end_row])
    if len(selected) != end_row - start_row + 1:
        raise base.HighValueSupervisedLabelError("public range attestation drifted")
    return {
        "decoded_row_count": len(selected),
        "decoded_row_span": [start_row, end_row],
        "range_record_seals_sha256": _range_digest(selected),
        "source_file": str(path.expanduser().resolve()),
    }


def _build_range_labels(
    *,
    queue_dir: Path,
    review_dir: Path,
    start_row: int,
    end_row: int,
    base_dataset_dir: Path,
    master_manifest: Path,
    val33_file: Path,
    blind_pool_files: Sequence[Path],
    qa_cohort_files: Sequence[Path],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    queue_root = queue_dir.expanduser().resolve()
    public_path = queue_root / "review-queue.jsonl"
    private_path = queue_root / "private-bindings.jsonl"
    public_rows = load_public_prefix(public_path, end_row=end_row)
    private_rows, private_attestation = load_private_range(
        private_path, start_row=start_row, end_row=end_row
    )
    public_selected = public_rows[start_row - 1 : end_row]
    if [
        base.text(row.get("review_id"), "public range review_id")
        for row in public_selected
    ] != [
        base.text(row.get("review_id"), "private range review_id")
        for row in private_rows
    ]:
        raise base.HighValueSupervisedLabelError(
            "public/private selected range binding drifted"
        )

    # The audited v1 builder requires equal public/private prefix inventories.
    # Synthetic prefix bindings carry only public identities, are never selected
    # by the 401..600 decisions, and avoid opening old private records.
    synthetic_prefix = [
        base.seal_record(
            {
                "review_id": base.text(row.get("review_id"), "public review_id"),
                "sample_id": base.text(row.get("sample_id"), "public sample_id"),
                "schema_version": "synthetic-unread-private-prefix-v1",
            }
        )
        for row in public_rows[: start_row - 1]
    ]

    with tempfile.TemporaryDirectory(prefix=".font-v2-private-range-") as temporary:
        temporary_root = Path(temporary)
        (temporary_root / "report.json").write_bytes(
            (queue_root / "report.json").read_bytes()
        )
        base.write_jsonl(temporary_root / "review-queue.jsonl", public_rows)
        base.write_jsonl(
            temporary_root / "private-bindings.jsonl",
            [*synthetic_prefix, *private_rows],
        )
        labels, raw_summary = base.build_labels(
            queue_dir=temporary_root,
            review_dirs=(review_dir,),
            expected_start_row=start_row,
            expected_end_row=end_row,
            base_dataset_dir=base_dataset_dir,
            master_manifest=master_manifest,
            val33_file=val33_file,
            blind_pool_files=blind_pool_files,
            qa_cohort_files=qa_cohort_files,
        )

    summary = copy.deepcopy(dict(raw_summary))
    lineage = dict(base.mapping(summary.get("lineage"), "range summary lineage"))
    lineage["private_bindings"] = {
        **dict(private_attestation),
        "access_policy": "json_decode_selected_range_only",
    }
    lineage["public_queue"] = dict(
        _public_range_attestation(
            public_path,
            public_rows,
            start_row=start_row,
            end_row=end_row,
        )
    )
    lineage["queue_report"] = base.source_descriptor(queue_root / "report.json")
    lineage["range_sealer"] = {
        "build_mode": BUILD_MODE_RANGE,
        "private_json_decoded_row_span": [start_row, end_row],
        "private_suffix_records_read": 0,
    }
    summary["lineage"] = lineage
    base.assert_no_private_model_fields(summary, "range summary")
    return labels, summary


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
        candidate_labels = base.mapping(row.get("candidate_labels"), "candidate labels")
        preferred_counts.update(
            str(value)
            for value in candidate_labels.get("preferred_candidate_ids", ())
        )
        positive_counts.update(
            str(value) for value in candidate_labels.get("positive_candidate_ids", ())
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
    if [row["row_span"] for row in review_shards] != [
        [1, 200],
        [201, 400],
        [401, 600],
    ]:
        raise base.HighValueSupervisedLabelError("merged review shard spans drifted")
    if blind_rows != 600 or blind_rows - len(labels) != sum(exclusions.values()):
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
        "expected_queue_row_span": [1, 600],
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
    expected_spans = ([1, 400], [401, 600])
    if [
        list(base.mapping(row.get("counts"), "source counts").get("expected_queue_row_span", ()))
        for row in manifests
    ] != list(expected_spans):
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
            "source_row_spans": list(expected_spans),
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
    if span not in ([401, 600], [1, 600]):
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


def _boundary_defaults(args: argparse.Namespace) -> None:
    if not args.blind_pool_file:
        args.blind_pool_file = [
            Path(
                "artifacts/manga-font-v2-independent-blind-calibration-eval-pool-r1/"
                "private-bindings.jsonl"
            ),
            Path(
                "artifacts/manga-font-v2-independent-blind-calibration-eval-pool-r2/"
                "private-bindings.jsonl"
            ),
        ]
    if not args.qa_cohort_file:
        args.qa_cohort_file = base.default_qa_cohorts()
    if not args.qa_cohort_file:
        raise base.HighValueSupervisedLabelError("no QA cohorts found")


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
            _boundary_defaults(args)
            labels, summary = _build_range_labels(
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
        raise SystemExit(f"range-gated high-value sealer error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
