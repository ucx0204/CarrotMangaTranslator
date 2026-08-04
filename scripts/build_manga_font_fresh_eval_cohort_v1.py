#!/usr/bin/env python3
"""Seal a fresh, label-blind MangaFont evaluation cohort.

The legacy review ledger contains labels for the old strict test30, so those
rows can no longer support an uncontaminated final claim.  This builder scans
test identities from the label-free master manifest without ``json.loads`` on
test rows, excludes every review-ledger, strict-export, and library QA page,
then deterministically selects one crop per source page across test works.

The output contains identities and hashes only.  It is not a training export
and must remain unopened for labels until model/configuration selection is
frozen.  Human labels produced later belong in a separately sealed evaluator.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import train_manga_font_student_v1 as base
except ImportError:  # pragma: no cover - direct execution from scripts/
    import train_manga_font_student_v1 as base


SCHEMA = "manga-font-fresh-evaluation-cohort-v1"
OWNER = "carrot-manga-translator/manga-font-fresh-evaluation-cohort-v1"
MARKER = ".manga-font-fresh-evaluation-cohort-v1-owned.json"
COHORT = "cohort.jsonl"
REPORT = "report.json"
FILES = frozenset({MARKER, COHORT, REPORT})

WORK_RE = re.compile(rb'"work":\{"id":"([0-9a-f-]{36})"')
CHAPTER_RE = re.compile(rb'"chapter":\{"id":"([0-9a-f-]{36})"')
PAGE_RE = re.compile(
    rb'"page":\{"id":"([0-9a-f-]{36})".*?'
    rb'"source_locator":\{"file_sha256":"([0-9a-f]{64})"'
)
TOP_LEVEL_SHA_RE = re.compile(
    rb'"source_page_sha256":"([0-9a-f]{64})"'
)


class FreshEvaluationCohortError(base.MangaFontStudentError):
    """Raised when a label-blind evaluation boundary drifts."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise FreshEvaluationCohortError(f"{location}: expected object")
    return value


def _raw_field(raw: bytes, name: str, *, location: str) -> str:
    try:
        return base.top_level_string_field_without_deserializing(raw, name)
    except base.MangaFontStudentError as error:
        raise FreshEvaluationCohortError(f"{location}: missing {name}") from error


def _match(pattern: re.Pattern[bytes], raw: bytes, *, location: str) -> re.Match[bytes]:
    match = pattern.search(raw)
    if match is None:
        raise FreshEvaluationCohortError(f"{location}: identity layout drifted")
    return match


def scan_review_ledger_identities(path: Path) -> dict[str, Any]:
    """Scan ledger identity fields without deserializing any label payload."""

    sample_ids: set[str] = set()
    source_shas: set[str] = set()
    work_ids: Counter[str] = Counter()
    with path.expanduser().resolve().open("rb") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            location = f"review final raw line {line_number}"
            sample_id = _raw_field(raw, "sample_id", location=location)
            work_id = _raw_field(raw, "work_id", location=location)
            source_sha = _raw_field(raw, "source_page_sha256", location=location)
            if sample_id in sample_ids:
                raise FreshEvaluationCohortError("duplicate review final sample id")
            sample_ids.add(sample_id)
            source_shas.add(source_sha)
            work_ids[work_id] += 1
    if not sample_ids:
        raise FreshEvaluationCohortError("review ledger is empty")
    return {
        "sample_ids": sample_ids,
        "source_shas": source_shas,
        "work_ids": work_ids,
    }


def scan_strict_export_identities(path: Path) -> dict[str, Any]:
    """Scan split/identity only; strict test label JSON is never deserialized."""

    ids_by_split: dict[str, set[str]] = defaultdict(set)
    with path.expanduser().resolve().open("rb") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            location = f"strict sample raw line {line_number}"
            split = _raw_field(raw, "split", location=location)
            sample_id = _raw_field(raw, "sample_id", location=location)
            if split not in {"train", "val", "test"}:
                raise FreshEvaluationCohortError("strict export split drifted")
            if sample_id in ids_by_split[split]:
                raise FreshEvaluationCohortError("duplicate strict sample id")
            ids_by_split[split].add(sample_id)
    return {key: set(ids_by_split[key]) for key in ("train", "val", "test")}


def scan_master_test_identities(path: Path) -> tuple[dict[str, str], ...]:
    """Read only raw test identity fields from the label-free master manifest."""

    output: list[dict[str, str]] = []
    seen: set[str] = set()
    with path.expanduser().resolve().open("rb") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            split = _raw_field(raw, "split", location=f"master raw line {line_number}")
            if split != "test":
                continue
            # The master test inventory is allowed only while it carries no
            # font label at all.  Do not parse the row to establish this.
            if b'"font_label":null' not in raw:
                raise FreshEvaluationCohortError(
                    "master test row unexpectedly contains a font label"
                )
            sample_id = _raw_field(
                raw, "id", location=f"master test raw line {line_number}"
            )
            work = _match(
                WORK_RE, raw, location=f"master test raw line {line_number}"
            ).group(1).decode("ascii")
            chapter = _match(
                CHAPTER_RE, raw, location=f"master test raw line {line_number}"
            ).group(1).decode("ascii")
            page_match = _match(
                PAGE_RE, raw, location=f"master test raw line {line_number}"
            )
            page = page_match.group(1).decode("ascii")
            source_sha = page_match.group(2).decode("ascii")
            crop_sha = _raw_field(
                raw,
                "sample_crop_sha256",
                location=f"master test raw line {line_number}",
            )
            if sample_id in seen:
                raise FreshEvaluationCohortError("duplicate master test sample id")
            seen.add(sample_id)
            output.append(
                {
                    "chapter_id": chapter,
                    "page_id": page,
                    "sample_crop_sha256": crop_sha,
                    "sample_id": sample_id,
                    "source_page_sha256": source_sha,
                    "work_id": work,
                }
            )
    if not output:
        raise FreshEvaluationCohortError("master test inventory is empty")
    return tuple(output)


def load_qa_page_shas(paths: Sequence[Path]) -> set[str]:
    """Load label-free library QA page manifests and return source byte hashes."""

    output: set[str] = set()
    for path in paths:
        resolved = path.expanduser().resolve()
        with resolved.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    row = _mapping(json.loads(line), f"QA row {line_number}")
                except json.JSONDecodeError as error:
                    raise FreshEvaluationCohortError("invalid QA cohort JSON") from error
                page = _mapping(row.get("page"), f"QA row {line_number}.page")
                sha = str(page.get("imageSha256", ""))
                if len(sha) != 64 or set(sha) - base.SHA_CHARS:
                    raise FreshEvaluationCohortError("QA page hash drifted")
                output.add(sha)
    return output


def select_fresh_cohort(
    rows: Sequence[Mapping[str, str]],
    *,
    excluded_sample_ids: set[str],
    excluded_source_shas: set[str],
    size: int,
    seed: str,
) -> tuple[dict[str, str], ...]:
    """Select unique pages in a deterministic work-balanced round robin."""

    if not 30 <= size <= 200 or not seed:
        raise FreshEvaluationCohortError("fresh cohort size/seed is invalid")
    by_work: dict[str, list[dict[str, str]]] = defaultdict(list)
    for source in rows:
        row = dict(source)
        if (
            row["sample_id"] in excluded_sample_ids
            or row["source_page_sha256"] in excluded_source_shas
        ):
            continue
        by_work[row["work_id"]].append(row)
    if len(by_work) < 2:
        raise FreshEvaluationCohortError("fresh cohort requires multiple test works")

    def key(row: Mapping[str, str]) -> str:
        return hashlib.sha256(
            f"{seed}\0{row['sample_id']}".encode("utf-8")
        ).hexdigest()

    queues: dict[str, list[dict[str, str]]] = {}
    for work_id, work_rows in by_work.items():
        chosen_by_page: dict[str, dict[str, str]] = {}
        for row in sorted(work_rows, key=key):
            chosen_by_page.setdefault(row["source_page_sha256"], row)
        queues[work_id] = sorted(chosen_by_page.values(), key=key)
    works = sorted(queues, key=lambda value: hashlib.sha256(f"{seed}\0{value}".encode()).hexdigest())
    selected: list[dict[str, str]] = []
    offsets: Counter[str] = Counter()
    while len(selected) < size:
        progressed = False
        for work_id in works:
            offset = offsets[work_id]
            if offset >= len(queues[work_id]):
                continue
            selected.append(queues[work_id][offset])
            offsets[work_id] += 1
            progressed = True
            if len(selected) == size:
                break
        if not progressed:
            break
    if len(selected) != size:
        raise FreshEvaluationCohortError("insufficient fresh unique source pages")
    return tuple(selected)


def _safe_output(path: Path) -> Path:
    return base._safe_output_path(path)  # noqa: SLF001


def build(args: argparse.Namespace) -> Mapping[str, Any]:
    output = _safe_output(args.output_dir)
    if output.exists():
        raise FreshEvaluationCohortError("fresh cohort output already exists")
    ledger = scan_review_ledger_identities(args.review_finals)
    strict = scan_strict_export_identities(args.strict_samples)
    master_rows = scan_master_test_identities(args.master_manifest)
    qa_shas = load_qa_page_shas(args.qa_cohort)
    burned_overlap = strict["test"] & ledger["sample_ids"]
    if burned_overlap != strict["test"] or not burned_overlap:
        raise FreshEvaluationCohortError(
            "expected strict test cohort is not fully present in reviewed ledger"
        )
    excluded_ids = set(ledger["sample_ids"]) | set().union(*strict.values())
    excluded_shas = set(ledger["source_shas"]) | qa_shas
    selected = select_fresh_cohort(
        master_rows,
        excluded_sample_ids=excluded_ids,
        excluded_source_shas=excluded_shas,
        size=args.size,
        seed=args.seed,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        with (staging / COHORT).open("wb") as handle:
            for index, identity in enumerate(selected):
                row = base.seal_record(
                    {
                        **identity,
                        "access_policy": "sealed_identity_only_until_model_selection_frozen",
                        "evaluation_index": index,
                        "record_type": "manga_font_fresh_evaluation_identity",
                        "schema_version": SCHEMA,
                    }
                )
                handle.write(base.json_bytes(row))
        work_counts = Counter(row["work_id"] for row in selected)
        report = base.seal_record(
            {
                "boundaries": {
                    "configuration_selection_allowed": False,
                    "human_labels_present": False,
                    "labels_deserialized": 0,
                    "pixels_opened": 0,
                    "training_allowed": False,
                    "use": "one_shot_final_evaluation_after_configuration_freeze",
                },
                "burned_prior_evaluation": {
                    "action": "retired_from_final_claims",
                    "reason": "strict test labels were deserialized from legacy review finals",
                    "strict_test_overlap_count": len(burned_overlap),
                    "strict_test_overlap_ids_sha256": base.sha256_bytes(
                        "\n".join(sorted(burned_overlap)).encode("utf-8")
                    ),
                },
                "cohort": {
                    "record_count": len(selected),
                    "sha256": base.sha256_file(staging / COHORT),
                    "source_page_unique_count": len(
                        {row["source_page_sha256"] for row in selected}
                    ),
                    "work_count": len(work_counts),
                    "work_record_counts": dict(sorted(work_counts.items())),
                },
                "exclusions": {
                    "qa_source_page_sha256_count": len(qa_shas),
                    "review_ledger_sample_count": len(ledger["sample_ids"]),
                    "review_ledger_source_page_sha256_count": len(
                        ledger["source_shas"]
                    ),
                    "selected_overlap_count": 0,
                    "strict_export_sample_count": sum(map(len, strict.values())),
                },
                "record_type": "manga_font_fresh_evaluation_report",
                "schema_version": SCHEMA,
                "seed": args.seed,
                "sources": {
                    "master_manifest_sha256": base.sha256_file(args.master_manifest),
                    "qa_cohort_sha256s": {
                        str(path.expanduser().resolve()): base.sha256_file(path)
                        for path in args.qa_cohort
                    },
                    "review_finals_sha256": base.sha256_file(args.review_finals),
                    "strict_samples_sha256": base.sha256_file(args.strict_samples),
                },
                "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
            }
        )
        (staging / REPORT).write_bytes(base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                COHORT: base.sha256_file(staging / COHORT),
                REPORT: base.sha256_file(staging / REPORT),
            },
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(base.json_bytes(marker, pretty=True))
        validate(staging)
        os.rename(staging, output)
        published = True
        return validate(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    base.assert_exact_root_inventory(root, FILES, location="fresh evaluation cohort")
    marker = base.read_json(root / MARKER, location="fresh evaluation marker")
    report = base.read_json(root / REPORT, location="fresh evaluation report")
    base.validate_record_seal(report, location="fresh evaluation report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != base.sha256_file(Path(__file__).resolve())
    ):
        raise FreshEvaluationCohortError("fresh evaluation metadata drifted")
    artifacts = _mapping(marker.get("artifacts"), "fresh evaluation artifacts")
    if any(artifacts.get(name) != base.sha256_file(root / name) for name in (COHORT, REPORT)):
        raise FreshEvaluationCohortError("fresh evaluation artifact hash drifted")
    boundary = _mapping(report.get("boundaries"), "fresh evaluation boundary")
    if (
        boundary.get("human_labels_present") is not False
        or boundary.get("labels_deserialized") != 0
        or boundary.get("pixels_opened") != 0
        or boundary.get("training_allowed") is not False
        or boundary.get("configuration_selection_allowed") is not False
    ):
        raise FreshEvaluationCohortError("fresh evaluation boundary is unsafe")
    cohort = _mapping(report.get("cohort"), "fresh evaluation cohort")
    seen_samples: set[str] = set()
    seen_pages: set[str] = set()
    count = 0
    with (root / COHORT).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = _mapping(json.loads(line), f"fresh cohort row {line_number}")
            base.validate_record_seal(row, location=f"fresh cohort row {line_number}")
            sample_id = str(row.get("sample_id"))
            source_sha = str(row.get("source_page_sha256"))
            if sample_id in seen_samples or source_sha in seen_pages:
                raise FreshEvaluationCohortError("fresh cohort identity duplicated")
            if row.get("access_policy") != "sealed_identity_only_until_model_selection_frozen":
                raise FreshEvaluationCohortError("fresh cohort access policy drifted")
            seen_samples.add(sample_id)
            seen_pages.add(source_sha)
            count += 1
    if (
        count != cohort.get("record_count")
        or len(seen_pages) != cohort.get("source_page_unique_count")
        or cohort.get("sha256") != base.sha256_file(root / COHORT)
    ):
        raise FreshEvaluationCohortError("fresh cohort report binding drifted")
    return {
        "burned_prior_test_count": _mapping(
            report.get("burned_prior_evaluation"), "burned evaluation"
        ).get("strict_test_overlap_count"),
        "fresh_record_count": count,
        "output_dir": str(root),
        "status": "sealed_unlabeled_final_evaluation_cohort",
        "work_count": cohort.get("work_count"),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("--master-manifest", type=Path, required=True)
    build_parser.add_argument("--review-finals", type=Path, required=True)
    build_parser.add_argument("--strict-samples", type=Path, required=True)
    build_parser.add_argument("--qa-cohort", type=Path, action="append", default=[])
    build_parser.add_argument("--output-dir", type=Path, required=True)
    build_parser.add_argument("--size", type=int, default=64)
    build_parser.add_argument("--seed", default="manga-font-fresh-eval-20260803-v1")
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build(args) if args.command == "build" else validate(args.output_dir)
    except (FreshEvaluationCohortError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"fresh-evaluation-cohort error: {error}") from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
