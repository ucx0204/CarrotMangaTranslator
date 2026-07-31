#!/usr/bin/env python3
"""Measure blind reviewer agreement for MangaFontMatcher label pilots.

The P1 gate is intentionally based on three different questions:

* did reviewers assign the same semantic role (macro F1)?
* did they preserve the same ordering between rendered candidates?
* did they agree on the set that is safe to use (acceptable-set Jaccard)?

Metrics are reported both over samples and as a macro average over works so a
large title cannot hide a weak title.  This tool consumes sealed review JSONL
records emitted under :mod:`font_matching_labels`; it never changes them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


RANKED_TIERS = ("preferred", "acceptable", "marginal", "unacceptable")
SKIPPED_TIERS = ("unrenderable", "not_reviewed")
ROLE_GATE = 0.85
PAIRWISE_GATE = 0.80
JACCARD_GATE = 0.70


class AgreementError(ValueError):
    """Raised when review input cannot support an independent agreement audit."""


@dataclass(frozen=True)
class SampleAgreement:
    sample_id: str
    work_id: str
    role_primary: str
    role_secondary: str
    pairwise_equal: int
    pairwise_total: int
    acceptable_jaccard: float
    none_agreement: bool

    @property
    def pairwise_agreement(self) -> float | None:
        if self.pairwise_total == 0:
            return None
        return self.pairwise_equal / self.pairwise_total


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise AgreementError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, dict):
                raise AgreementError(f"{path}:{line_number}: expected an object")
            rows.append(value)
    return rows


def _require_mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AgreementError(f"{path} must be an object")
    return value


def _require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        raise AgreementError(f"{path} must be a non-empty string")
    return value


def _string_set(value: Any, path: str) -> set[str]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise AgreementError(f"{path} must be an array of non-empty strings")
    if len(value) != len(set(value)):
        raise AgreementError(f"{path} contains duplicates")
    return set(value)


def _candidate_ranks(
    record: Mapping[str, Any], path: str
) -> tuple[dict[str, int], set[str]]:
    judgment = _require_mapping(record.get("font_judgment"), f"{path}.font_judgment")
    ranks: dict[str, int] = {}
    skipped: set[str] = set()
    for rank, tier in enumerate(reversed(RANKED_TIERS)):
        for candidate in _string_set(
            judgment.get(tier), f"{path}.font_judgment.{tier}"
        ):
            if candidate in ranks or candidate in skipped:
                raise AgreementError(
                    f"{path}: candidate {candidate!r} appears in multiple tiers"
                )
            ranks[candidate] = rank
    for tier in SKIPPED_TIERS:
        for candidate in _string_set(
            judgment.get(tier), f"{path}.font_judgment.{tier}"
        ):
            if candidate in ranks or candidate in skipped:
                raise AgreementError(
                    f"{path}: candidate {candidate!r} appears in multiple tiers"
                )
            skipped.add(candidate)
    return ranks, skipped


def _relation(left: int, right: int) -> int:
    return (left > right) - (left < right)


def _pairwise_counts(
    primary: Mapping[str, Any], secondary: Mapping[str, Any], sample_id: str
) -> tuple[int, int]:
    primary_ranks, primary_skipped = _candidate_ranks(primary, f"{sample_id}.primary")
    secondary_ranks, secondary_skipped = _candidate_ranks(
        secondary, f"{sample_id}.secondary"
    )
    primary_all = set(primary_ranks) | primary_skipped
    secondary_all = set(secondary_ranks) | secondary_skipped
    if primary_all != secondary_all:
        raise AgreementError(
            f"{sample_id}: reviewers did not judge the same candidate catalog"
        )
    comparable = sorted(set(primary_ranks) & set(secondary_ranks))
    equal = 0
    total = 0
    for left_index, left in enumerate(comparable):
        for right in comparable[left_index + 1 :]:
            total += 1
            if _relation(primary_ranks[left], primary_ranks[right]) == _relation(
                secondary_ranks[left], secondary_ranks[right]
            ):
                equal += 1
    return equal, total


def _acceptable_set(record: Mapping[str, Any], path: str) -> set[str]:
    judgment = _require_mapping(record.get("font_judgment"), f"{path}.font_judgment")
    return _string_set(
        judgment.get("preferred"), f"{path}.font_judgment.preferred"
    ) | _string_set(judgment.get("acceptable"), f"{path}.font_judgment.acceptable")


def _jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    return 1.0 if not union else len(left & right) / len(union)


def build_sample_agreements(
    reviews: Iterable[Mapping[str, Any]],
) -> tuple[SampleAgreement, ...]:
    by_sample: dict[str, dict[str, Mapping[str, Any]]] = defaultdict(dict)
    work_by_sample: dict[str, str] = {}
    reviewer_by_sample: dict[str, dict[str, str]] = defaultdict(dict)
    for index, record in enumerate(reviews):
        sample_id = _require_string(
            record.get("sample_id"), f"reviews[{index}].sample_id"
        )
        work_id = _require_string(record.get("work_id"), f"reviews[{index}].work_id")
        review = _require_mapping(record.get("review"), f"reviews[{index}].review")
        stage = _require_string(review.get("stage"), f"reviews[{index}].review.stage")
        if stage not in {"primary", "secondary"}:
            raise AgreementError(
                f"reviews[{index}].review.stage is unsupported: {stage}"
            )
        if stage in by_sample[sample_id]:
            raise AgreementError(f"{sample_id}: duplicate {stage} review")
        prior_work = work_by_sample.setdefault(sample_id, work_id)
        if prior_work != work_id:
            raise AgreementError(f"{sample_id}: work_id differs between reviews")
        reviewer_by_sample[sample_id][stage] = _require_string(
            review.get("reviewer"), f"reviews[{index}].review.reviewer"
        )
        by_sample[sample_id][stage] = record

    output: list[SampleAgreement] = []
    for sample_id in sorted(by_sample):
        stages = by_sample[sample_id]
        if "secondary" not in stages:
            continue
        if "primary" not in stages:
            raise AgreementError(f"{sample_id}: secondary review lacks a primary")
        if (
            reviewer_by_sample[sample_id]["primary"]
            == reviewer_by_sample[sample_id]["secondary"]
        ):
            raise AgreementError(
                f"{sample_id}: primary and secondary reviewer are not independent"
            )
        primary = stages["primary"]
        secondary = stages["secondary"]
        primary_role = _require_string(
            _require_mapping(primary.get("role"), f"{sample_id}.primary.role").get(
                "primary"
            ),
            f"{sample_id}.primary.role.primary",
        )
        secondary_role = _require_string(
            _require_mapping(secondary.get("role"), f"{sample_id}.secondary.role").get(
                "primary"
            ),
            f"{sample_id}.secondary.role.primary",
        )
        pairwise_equal, pairwise_total = _pairwise_counts(primary, secondary, sample_id)
        primary_acceptable = _acceptable_set(primary, f"{sample_id}.primary")
        secondary_acceptable = _acceptable_set(secondary, f"{sample_id}.secondary")
        primary_none = bool(
            _require_mapping(
                primary.get("font_judgment"), f"{sample_id}.primary.font_judgment"
            ).get("none_acceptable")
        )
        secondary_none = bool(
            _require_mapping(
                secondary.get("font_judgment"), f"{sample_id}.secondary.font_judgment"
            ).get("none_acceptable")
        )
        output.append(
            SampleAgreement(
                sample_id=sample_id,
                work_id=work_by_sample[sample_id],
                role_primary=primary_role,
                role_secondary=secondary_role,
                pairwise_equal=pairwise_equal,
                pairwise_total=pairwise_total,
                acceptable_jaccard=_jaccard(primary_acceptable, secondary_acceptable),
                none_agreement=primary_none == secondary_none,
            )
        )
    if not output:
        raise AgreementError("no independently double-reviewed samples were found")
    return tuple(output)


def _role_macro_f1(samples: Sequence[SampleAgreement]) -> float:
    labels = sorted(
        {sample.role_primary for sample in samples}
        | {sample.role_secondary for sample in samples}
    )
    per_label: list[float] = []
    for label in labels:
        true_positive = sum(
            sample.role_primary == label and sample.role_secondary == label
            for sample in samples
        )
        false_positive = sum(
            sample.role_primary != label and sample.role_secondary == label
            for sample in samples
        )
        false_negative = sum(
            sample.role_primary == label and sample.role_secondary != label
            for sample in samples
        )
        denominator = 2 * true_positive + false_positive + false_negative
        per_label.append(0.0 if denominator == 0 else 2 * true_positive / denominator)
    return sum(per_label) / len(per_label)


def _metric_block(samples: Sequence[SampleAgreement]) -> dict[str, Any]:
    pairwise_equal = sum(sample.pairwise_equal for sample in samples)
    pairwise_total = sum(sample.pairwise_total for sample in samples)
    sample_pairwise = [
        value for sample in samples if (value := sample.pairwise_agreement) is not None
    ]
    return {
        "sample_count": len(samples),
        "role_macro_f1": _role_macro_f1(samples),
        "tier_pairwise_agreement": (
            None if pairwise_total == 0 else pairwise_equal / pairwise_total
        ),
        "tier_pairwise_sample_macro": (
            None if not sample_pairwise else sum(sample_pairwise) / len(sample_pairwise)
        ),
        "tier_pair_count": pairwise_total,
        "acceptable_set_jaccard": sum(sample.acceptable_jaccard for sample in samples)
        / len(samples),
        "none_acceptable_agreement": sum(sample.none_agreement for sample in samples)
        / len(samples),
    }


def evaluate_agreement(reviews: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    samples = build_sample_agreements(reviews)
    overall = _metric_block(samples)
    by_work_samples: dict[str, list[SampleAgreement]] = defaultdict(list)
    for sample in samples:
        by_work_samples[sample.work_id].append(sample)
    by_work = {
        work_id: _metric_block(work_samples)
        for work_id, work_samples in sorted(by_work_samples.items())
    }

    def work_macro(key: str) -> float | None:
        values = [
            float(block[key]) for block in by_work.values() if block[key] is not None
        ]
        return None if not values else sum(values) / len(values)

    gate_values = {
        "role_macro_f1": overall["role_macro_f1"],
        "tier_pairwise_agreement": overall["tier_pairwise_agreement"],
        "acceptable_set_jaccard": overall["acceptable_set_jaccard"],
    }
    thresholds = {
        "role_macro_f1": ROLE_GATE,
        "tier_pairwise_agreement": PAIRWISE_GATE,
        "acceptable_set_jaccard": JACCARD_GATE,
    }
    gates = {
        key: value is not None and float(value) >= thresholds[key]
        for key, value in gate_values.items()
    }
    report = {
        "schema_version": "font-matching-review-agreement-v1",
        "double_review_sample_count": len(samples),
        "work_count": len(by_work),
        "overall": overall,
        "work_macro": {
            "role_macro_f1": work_macro("role_macro_f1"),
            "tier_pairwise_agreement": work_macro("tier_pairwise_agreement"),
            "acceptable_set_jaccard": work_macro("acceptable_set_jaccard"),
            "none_acceptable_agreement": work_macro("none_acceptable_agreement"),
        },
        "thresholds": thresholds,
        "gates": gates,
        "all_gates_pass": all(gates.values()),
        "by_work": by_work,
    }
    _assert_finite(report)
    return report


def _assert_finite(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise AgreementError("agreement report contains a non-finite value")
    if isinstance(value, Mapping):
        for child in value.values():
            _assert_finite(child)
    elif isinstance(value, list):
        for child in value:
            _assert_finite(child)


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate blind font-label agreement.")
    parser.add_argument("--reviews", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--require-gates",
        action="store_true",
        help="Exit non-zero unless all frozen P1 agreement gates pass.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        review_bytes = args.reviews.read_bytes()
        report = evaluate_agreement(read_jsonl(args.reviews))
        report["inputs"] = {
            "reviews": {
                "path": args.reviews.name,
                "sha256": hashlib.sha256(review_bytes).hexdigest(),
                "byte_size": len(review_bytes),
            }
        }
        payload = (
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        )
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload, encoding="utf-8")
        else:
            print(payload, end="")
        if args.require_gates and not report["all_gates_pass"]:
            return 2
        return 0
    except (AgreementError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
