#!/usr/bin/env python3
"""Build deterministic pilot and calibration review inventories.

The input is the zero-copy ``font-matching-master-v1`` JSONL manifest.  This
tool never creates or edits image assets and never changes a master split.  It
only emits references to reviewed real samples plus explicit cohort and batch
membership.

The pilot is deliberately enriched for horizontal writing and hard visual
cohorts while covering every work and chapter.  The calibration batch is the
union of every explicit hard-risk record and four to six deterministic
ordinary-dialogue *proxy* controls per chapter.  Proxy is intentional: roles
have not been annotated yet, so this inventory must not pretend that a source
heuristic is a font-matching label.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


TOOL_ID = "manga-translator-font-matching-pilot-builder"
ALGORITHM_VERSION = "font-matching-pilot-calibration-v1"
INVENTORY_SCHEMA_VERSION = 1
REPORT_SCHEMA_VERSION = 1
EXPECTED_MASTER_ROWS = 28_115
EXPECTED_WORKS = 24
EXPECTED_CHAPTERS = 214
EXPECTED_MANUAL_RECROPS = 39
NOMINAL_HARD_RISK_COUNT = 2_972
NOMINAL_CALIBRATION_SIZE = 4_000
DEFAULT_PILOT_SIZE = 1_200
MIN_PILOT_SIZE = 1_000
MAX_PILOT_SIZE = 1_200
DEFAULT_SEED = ALGORITHM_VERSION
BASE_CATALOG_ID = "fontclip-accepted-v1"
HARD_CATALOG_ID = "fontclip-hard-accepted-v2"
KNOWN_CATALOG_IDS = frozenset({BASE_CATALOG_ID, HARD_CATALOG_ID})
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")

HARD_CATEGORY_COHORTS = {
    "page_sound": "hard_page_sound",
    "ocr_hard": "hard_ocr_hard",
    "ocr_anime_region": "hard_ocr_anime_region",
    "text_free": "hard_text_free",
    "free_near_bubble": "hard_free_near_bubble",
}
HARD_RISK_CATEGORY_COHORTS = frozenset(
    {"hard_page_sound", "hard_ocr_hard", "hard_ocr_anime_region"}
)
HARD_RISK_SIGNAL_COHORTS = frozenset(
    {
        "hard_inverse_extreme",
        "hard_color_extreme",
        "hard_outline_extreme",
        "hard_quality_review",
        "manual_recrop",
    }
)
HARD_RISK_MEMBER_COHORTS = HARD_RISK_CATEGORY_COHORTS | HARD_RISK_SIGNAL_COHORTS

# Fractions are minimum pilot representation targets, not role labels.  They
# are deliberately well above source prevalence for horizontal writing and
# the rare/hard cohorts.  A multi-cohort greedy fill rewards overlap so the
# targets do not crowd out chapter coverage.
PILOT_QUOTA_RATES = {
    "horizontal": 0.25,
    "hard_page_sound": 0.03,
    "hard_ocr_hard": 0.03,
    "hard_ocr_anime_region": 0.03,
    "hard_text_free": 0.08,
    "hard_free_near_bubble": 0.04,
    "hard_inverse_extreme": 0.04,
    "hard_color_extreme": 0.04,
    "hard_outline_extreme": 0.06,
    "hard_quality_review": 0.04,
    "ordinary_dialogue_proxy_control": 0.15,
}


class PilotInventoryError(ValueError):
    """Raised when the master or generated inventory violates its contract."""


@dataclass(frozen=True)
class RiskThresholds:
    inverse_min: float = 0.40
    color_min: float = 0.30
    outline_low_max: float = 0.25
    outline_high_min: float = 0.75

    def as_dict(self) -> dict[str, float]:
        return {
            "color_min": self.color_min,
            "inverse_min": self.inverse_min,
            "outline_high_min": self.outline_high_min,
            "outline_low_max": self.outline_low_max,
        }


@dataclass(frozen=True)
class BuildConfig:
    pilot_size: int = DEFAULT_PILOT_SIZE
    seed: str = DEFAULT_SEED
    ordinary_min_per_chapter: int = 4
    ordinary_max_per_chapter: int = 6
    thresholds: RiskThresholds = field(default_factory=RiskThresholds)


@dataclass(frozen=True)
class Sample:
    line_number: int
    sample_id: str
    work_id: str
    chapter_id: str
    page_id: str
    split: str
    catalog_id: str
    orientation: str
    categories: frozenset[str]
    primary_category: str | None
    cohorts: frozenset[str]

    @property
    def chapter_key(self) -> tuple[str, str]:
        return self.work_id, self.chapter_id

    @property
    def page_key(self) -> tuple[str, str, str]:
        return self.work_id, self.chapter_id, self.page_id


@dataclass
class InventoryBundle:
    inventory_rows: list[dict[str, Any]]
    inventory_bytes: bytes
    report: dict[str, Any]
    report_bytes: bytes
    pilot_ids: list[str]
    calibration_ids: list[str]


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise PilotInventoryError(f"could not read {path}: {error}") from error
    with handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def nested(value: Mapping[str, Any], *parts: str) -> Any:
    current: Any = value
    for part in parts:
        if not isinstance(current, Mapping):
            return None
        current = current.get(part)
    return current


def required_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PilotInventoryError(f"{location}: expected an object")
    return value


def required_text(value: Any, *, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PilotInventoryError(f"{location}: expected a non-empty string")
    return value.strip()


def required_bool(value: Any, *, location: str) -> bool:
    if not isinstance(value, bool):
        raise PilotInventoryError(f"{location}: expected a boolean")
    return value


def required_ratio(value: Any, *, location: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or not 0.0 <= float(value) <= 1.0
    ):
        raise PilotInventoryError(f"{location}: expected a finite ratio in [0, 1]")
    return float(value)


def require_key(mapping: Mapping[str, Any], key: str, *, location: str) -> Any:
    if key not in mapping:
        raise PilotInventoryError(f"{location}.{key}: required field is missing")
    return mapping[key]


def stable_digest(seed: str, purpose: str, sample_id: str) -> str:
    payload = f"{seed}\0{purpose}\0{sample_id}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def stable_number(seed: str, purpose: str, value: str) -> int:
    return int(stable_digest(seed, purpose, value)[:16], 16)


def _hard_signal_values(
    metadata: Mapping[str, Any], *, location: str
) -> tuple[float, float, float, str, str, bool]:
    signals = required_mapping(
        require_key(metadata, "cohort_signals", location=location),
        location=f"{location}.cohort_signals",
    )
    for key in (
        "inverse_likelihood",
        "color_mask_overlap_ratio",
        "manual_recrop",
        "outline_metrics",
        "outline_signal_present",
        "quality_status",
        "review_status",
    ):
        require_key(signals, key, location=f"{location}.cohort_signals")
    inverse = required_ratio(
        signals["inverse_likelihood"],
        location=f"{location}.cohort_signals.inverse_likelihood",
    )
    color = required_ratio(
        signals["color_mask_overlap_ratio"],
        location=f"{location}.cohort_signals.color_mask_overlap_ratio",
    )
    outline_metrics = required_mapping(
        signals["outline_metrics"],
        location=f"{location}.cohort_signals.outline_metrics",
    )
    outline = required_ratio(
        require_key(
            outline_metrics,
            "outline_structure_ratio",
            location=f"{location}.cohort_signals.outline_metrics",
        ),
        location=(f"{location}.cohort_signals.outline_metrics.outline_structure_ratio"),
    )
    required_bool(
        signals["outline_signal_present"],
        location=f"{location}.cohort_signals.outline_signal_present",
    )
    quality = required_text(
        signals["quality_status"],
        location=f"{location}.cohort_signals.quality_status",
    )
    review = required_text(
        signals["review_status"],
        location=f"{location}.cohort_signals.review_status",
    )
    manual_recrop = required_bool(
        signals["manual_recrop"],
        location=f"{location}.cohort_signals.manual_recrop",
    )
    return inverse, color, outline, quality, review, manual_recrop


def classify_cohorts(
    row: Mapping[str, Any],
    *,
    line_number: int,
    thresholds: RiskThresholds,
) -> Sample:
    location = f"master:{line_number}"
    sample_id = required_text(row.get("id"), location=f"{location}.id")
    work = required_mapping(row.get("work"), location=f"{location}.work")
    chapter = required_mapping(row.get("chapter"), location=f"{location}.chapter")
    page = required_mapping(row.get("page"), location=f"{location}.page")
    provenance = required_mapping(
        row.get("provenance"), location=f"{location}.provenance"
    )
    metadata = required_mapping(row.get("metadata"), location=f"{location}.metadata")
    work_id = required_text(work.get("id"), location=f"{location}.work.id")
    chapter_id = required_text(chapter.get("id"), location=f"{location}.chapter.id")
    page_id = required_text(page.get("id"), location=f"{location}.page.id")
    split = required_text(row.get("split"), location=f"{location}.split")
    catalog_id = required_text(
        provenance.get("source_catalog_id"),
        location=f"{location}.provenance.source_catalog_id",
    )
    if catalog_id not in KNOWN_CATALOG_IDS:
        raise PilotInventoryError(
            f"{location}.provenance.source_catalog_id: unsupported catalog "
            f"{catalog_id!r}; source kind must not be inferred"
        )
    if (
        require_key(provenance, "synthetic", location=f"{location}.provenance")
        is not False
    ):
        raise PilotInventoryError(f"{location}: synthetic samples are forbidden")
    if (
        require_key(provenance, "qa_overlay", location=f"{location}.provenance")
        is not False
    ):
        raise PilotInventoryError(f"{location}: QA overlay samples are forbidden")
    crop_hash = required_text(
        row.get("sample_crop_sha256"),
        location=f"{location}.sample_crop_sha256",
    ).lower()
    if not HEX_SHA256.fullmatch(crop_hash):
        raise PilotInventoryError(
            f"{location}.sample_crop_sha256: expected lowercase SHA-256"
        )
    orientation = required_text(
        require_key(metadata, "orientation", location=f"{location}.metadata"),
        location=f"{location}.metadata.orientation",
    )
    if orientation not in {"horizontal", "vertical"}:
        raise PilotInventoryError(
            f"{location}.metadata.orientation: unsupported value {orientation!r}"
        )
    categories_value = require_key(
        metadata, "candidate_categories", location=f"{location}.metadata"
    )
    if not isinstance(categories_value, list) or not all(
        isinstance(value, str) and value for value in categories_value
    ):
        raise PilotInventoryError(
            f"{location}.metadata.candidate_categories: expected string list"
        )
    categories = frozenset(categories_value)
    primary_value = require_key(
        metadata, "candidate_primary_category", location=f"{location}.metadata"
    )
    if primary_value is not None and not (
        isinstance(primary_value, str) and primary_value
    ):
        raise PilotInventoryError(
            f"{location}.metadata.candidate_primary_category: expected string or null"
        )

    cohorts: set[str] = {orientation}
    if catalog_id == BASE_CATALOG_ID:
        # The base catalog has no hard-style metrics.  Requiring those values
        # here would manufacture missing evidence; the catalog itself is the
        # explicit proxy stratum used for ordinary controls.
        signals = required_mapping(
            require_key(metadata, "cohort_signals", location=f"{location}.metadata"),
            location=f"{location}.metadata.cohort_signals",
        )
        manual = require_key(
            signals, "manual_recrop", location=f"{location}.metadata.cohort_signals"
        )
        if manual is not False:
            raise PilotInventoryError(
                f"{location}: base manual_recrop must be explicitly false"
            )
        cohorts.add("ordinary_dialogue_proxy_control")
    else:
        if not categories:
            raise PilotInventoryError(
                f"{location}.metadata.candidate_categories: hard row has no category"
            )
        if primary_value is None:
            raise PilotInventoryError(
                f"{location}.metadata.candidate_primary_category: hard row is missing it"
            )
        inverse, color, outline, quality, review, manual_recrop = _hard_signal_values(
            metadata, location=f"{location}.metadata"
        )
        if quality not in {"pass", "review"}:
            raise PilotInventoryError(
                f"{location}.metadata.cohort_signals.quality_status: unsupported "
                f"value {quality!r}"
            )
        if review != "accepted":
            raise PilotInventoryError(
                f"{location}.metadata.cohort_signals.review_status: expected accepted"
            )
        for category, cohort in HARD_CATEGORY_COHORTS.items():
            if category in categories:
                cohorts.add(cohort)
        if inverse >= thresholds.inverse_min:
            cohorts.add("hard_inverse_extreme")
        if color >= thresholds.color_min:
            cohorts.add("hard_color_extreme")
        if (
            outline <= thresholds.outline_low_max
            or outline >= thresholds.outline_high_min
        ):
            cohorts.add("hard_outline_extreme")
        if quality == "review":
            cohorts.add("hard_quality_review")
        if manual_recrop:
            cohorts.add("manual_recrop")
        if cohorts & HARD_RISK_MEMBER_COHORTS:
            cohorts.add("hard_risk_union")
        # This is a sampling control candidate, never a ground-truth role.
        if (
            primary_value == "bubble_edge"
            and categories == {"bubble_edge"}
            and quality == "pass"
            and review == "accepted"
            and not manual_recrop
        ):
            cohorts.add("ordinary_dialogue_proxy_control")

    return Sample(
        line_number=line_number,
        sample_id=sample_id,
        work_id=work_id,
        chapter_id=chapter_id,
        page_id=page_id,
        split=split,
        catalog_id=catalog_id,
        orientation=orientation,
        categories=categories,
        primary_category=primary_value,
        cohorts=frozenset(cohorts),
    )


def read_master(path: Path, *, thresholds: RiskThresholds) -> tuple[list[Sample], str]:
    digest = hashlib.sha256()
    samples: list[Sample] = []
    seen_ids: set[str] = set()
    try:
        handle = path.open("rb")
    except OSError as error:
        raise PilotInventoryError(f"could not read {path}: {error}") from error
    with handle:
        for line_number, payload in enumerate(handle, start=1):
            digest.update(payload)
            if not payload.strip():
                continue
            try:
                row = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise PilotInventoryError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(row, Mapping):
                raise PilotInventoryError(f"{path}:{line_number}: expected object")
            sample = classify_cohorts(
                row,
                line_number=line_number,
                thresholds=thresholds,
            )
            if sample.sample_id in seen_ids:
                raise PilotInventoryError(
                    f"{path}:{line_number}: duplicate sample id {sample.sample_id}"
                )
            seen_ids.add(sample.sample_id)
            samples.append(sample)
    if not samples:
        raise PilotInventoryError(f"{path}: master manifest is empty")
    return samples, digest.hexdigest()


def validate_expected_coverage(
    samples: Sequence[Sample],
    *,
    expected_rows: int | None,
    expected_works: int | None,
    expected_chapters: int | None,
    expected_manual_recrops: int | None,
) -> None:
    works = {sample.work_id for sample in samples}
    chapters = {sample.chapter_key for sample in samples}
    manual_recrops = sum("manual_recrop" in sample.cohorts for sample in samples)
    checks = (
        ("master rows", len(samples), expected_rows),
        ("works", len(works), expected_works),
        ("chapters", len(chapters), expected_chapters),
        ("manual recrops", manual_recrops, expected_manual_recrops),
    )
    for label, observed, expected in checks:
        if expected is not None and observed != expected:
            raise PilotInventoryError(f"expected {expected} {label}, found {observed}")


def pilot_quotas(samples: Sequence[Sample], pilot_size: int) -> dict[str, int]:
    availability = Counter(cohort for sample in samples for cohort in sample.cohorts)
    return {
        cohort: min(availability.get(cohort, 0), math.ceil(pilot_size * rate))
        for cohort, rate in sorted(PILOT_QUOTA_RATES.items())
    }


def _balanced_pick_order(
    candidates: Sequence[Sample],
    *,
    count: int,
    seed: str,
    purpose: str,
    work_counts: Counter[str],
    chapter_counts: Counter[tuple[str, str]],
    page_counts: Counter[tuple[str, str, str]],
    priority_cohorts: frozenset[str] = frozenset(),
) -> list[Sample]:
    """Return a deterministic hierarchical work/chapter/page-balanced order."""

    pools: defaultdict[
        str,
        defaultdict[tuple[str, str], defaultdict[tuple[str, str, str], list[Sample]]],
    ] = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for sample in candidates:
        pools[sample.work_id][sample.chapter_key][sample.page_key].append(sample)
    for chapters in pools.values():
        for pages in chapters.values():
            for page_samples in pages.values():
                # Reverse sort lets list.pop() return the smallest key in O(1).
                page_samples.sort(
                    key=lambda item: (
                        -len(item.cohorts & priority_cohorts),
                        stable_digest(seed, f"{purpose}-row", item.sample_id),
                    ),
                    reverse=True,
                )
    work_ties = {
        work_id: stable_number(seed, f"{purpose}-work", work_id) for work_id in pools
    }
    chapter_ties = {
        chapter_key: stable_number(seed, f"{purpose}-chapter", "\0".join(chapter_key))
        for chapters in pools.values()
        for chapter_key in chapters
    }
    page_ties = {
        page_key: stable_number(seed, f"{purpose}-page", "\0".join(page_key))
        for chapters in pools.values()
        for pages in chapters.values()
        for page_key in pages
    }
    result: list[Sample] = []
    while pools and len(result) < count:
        work_id = min(
            pools,
            key=lambda value: (work_counts[value], work_ties[value], value),
        )
        chapters = pools[work_id]
        chapter_key = min(
            chapters,
            key=lambda value: (
                chapter_counts[value],
                chapter_ties[value],
                value,
            ),
        )
        pages = chapters[chapter_key]
        page_key = min(
            pages,
            key=lambda value: (page_counts[value], page_ties[value], value),
        )
        page_samples = pages[page_key]
        sample = page_samples.pop()
        result.append(sample)
        # Local counters mirror the caller's future add() operations so every
        # pick in this batch sees the updated balance.
        work_counts[sample.work_id] += 1
        chapter_counts[sample.chapter_key] += 1
        page_counts[sample.page_key] += 1
        if not page_samples:
            del pages[page_key]
        if not pages:
            del chapters[chapter_key]
        if not chapters:
            del pools[work_id]
    return result


def select_pilot(
    samples: Sequence[Sample], config: BuildConfig
) -> tuple[list[str], dict[str, list[str]], dict[str, Any]]:
    if config.pilot_size <= 0:
        raise PilotInventoryError("pilot_size must be positive")
    if config.pilot_size > len(samples):
        raise PilotInventoryError(
            f"pilot_size {config.pilot_size} exceeds {len(samples)} master rows"
        )
    samples_by_id = {sample.sample_id: sample for sample in samples}
    selected: set[str] = set()
    reasons: defaultdict[str, set[str]] = defaultdict(set)
    selection_order: list[str] = []
    quotas = pilot_quotas(samples, config.pilot_size)
    pilot_quota_cohorts = frozenset(PILOT_QUOTA_RATES)
    cohort_counts: Counter[str] = Counter()
    work_counts: Counter[str] = Counter()
    chapter_counts: Counter[tuple[str, str]] = Counter()
    page_counts: Counter[tuple[str, str, str]] = Counter()
    chapter_row_hashes = {
        sample.sample_id: stable_digest(
            config.seed, "pilot-chapter-row", sample.sample_id
        )
        for sample in samples
    }

    def add(sample: Sample, *why: str) -> None:
        if sample.sample_id in selected:
            reasons[sample.sample_id].update(why)
            return
        if len(selected) >= config.pilot_size:
            raise PilotInventoryError(
                "pilot capacity was exhausted before mandatory coverage completed"
            )
        selected.add(sample.sample_id)
        selection_order.append(sample.sample_id)
        reasons[sample.sample_id].update(why)
        cohort_counts.update(sample.cohorts)
        work_counts[sample.work_id] += 1
        chapter_counts[sample.chapter_key] += 1
        page_counts[sample.page_key] += 1

    def add_precounted(sample: Sample, *why: str) -> None:
        """Record a row whose balance counters were advanced by a pool."""

        if sample.sample_id in selected:
            reasons[sample.sample_id].update(why)
            return
        if len(selected) >= config.pilot_size:
            raise PilotInventoryError(
                "pilot capacity was exhausted before quota coverage completed"
            )
        selected.add(sample.sample_id)
        selection_order.append(sample.sample_id)
        reasons[sample.sample_id].update(why)
        cohort_counts.update(sample.cohorts)

    manual = sorted(
        (sample for sample in samples if "manual_recrop" in sample.cohorts),
        key=lambda sample: stable_digest(
            config.seed, "pilot-manual-recrop", sample.sample_id
        ),
    )
    if len(manual) > config.pilot_size:
        raise PilotInventoryError(
            f"{len(manual)} mandatory recrops exceed pilot capacity {config.pilot_size}"
        )
    for sample in manual:
        add(sample, "mandatory:manual_recrop")

    by_chapter: defaultdict[tuple[str, str], list[Sample]] = defaultdict(list)
    for sample in samples:
        by_chapter[sample.chapter_key].append(sample)
    chapter_order = sorted(
        by_chapter,
        key=lambda key: (
            stable_number(config.seed, "pilot-chapter", "\0".join(key)),
            key,
        ),
    )
    covered_chapters = {samples_by_id[sample_id].chapter_key for sample_id in selected}
    for chapter_key in chapter_order:
        if chapter_key in covered_chapters:
            continue
        candidates = [
            sample
            for sample in by_chapter[chapter_key]
            if sample.sample_id not in selected
        ]
        if not candidates:
            raise PilotInventoryError(
                f"chapter {chapter_key!r} has no selectable master row"
            )
        under_quota = {
            cohort for cohort, quota in quotas.items() if cohort_counts[cohort] < quota
        }
        sample = min(
            candidates,
            key=lambda item: (
                -len(item.cohorts & under_quota),
                chapter_row_hashes[item.sample_id],
            ),
        )
        add(sample, "coverage:chapter")
        covered_chapters.add(chapter_key)

    # Scarce cohorts go first.  Each cohort uses a hierarchical balanced pool;
    # samples rich in still-relevant cohorts are preferred within a page.
    availability = Counter(cohort for sample in samples for cohort in sample.cohorts)
    quota_order = sorted(
        quotas,
        key=lambda cohort: (
            availability[cohort] / max(1, quotas[cohort]),
            cohort,
        ),
    )
    for cohort in quota_order:
        deficit = quotas[cohort] - cohort_counts[cohort]
        if deficit <= 0:
            continue
        if len(selected) + deficit > config.pilot_size:
            break
        still_relevant = frozenset(
            name for name, quota in quotas.items() if cohort_counts[name] < quota
        )
        candidates = [
            sample
            for sample in samples
            if sample.sample_id not in selected and cohort in sample.cohorts
        ]
        # The pool advances the live balance counters; add_precounted records
        # membership without advancing those counters a second time.
        chosen = _balanced_pick_order(
            candidates,
            count=deficit,
            seed=config.seed,
            purpose=f"pilot-quota-{cohort}",
            work_counts=work_counts,
            chapter_counts=chapter_counts,
            page_counts=page_counts,
            priority_cohorts=still_relevant,
        )
        for sample in chosen:
            add_precounted(sample, f"quota:{cohort}")

    # Fill the exact requested size while keeping works, chapters, and pages as
    # even as the mandatory and cohort constraints allow.
    remaining = [sample for sample in samples if sample.sample_id not in selected]
    chosen = _balanced_pick_order(
        remaining,
        count=config.pilot_size - len(selected),
        seed=config.seed,
        purpose="pilot-balanced-fill",
        work_counts=work_counts,
        chapter_counts=chapter_counts,
        page_counts=page_counts,
        priority_cohorts=pilot_quota_cohorts,
    )
    for sample in chosen:
        add_precounted(sample, "fill:work_chapter_balance")
    if len(selected) != config.pilot_size:
        raise PilotInventoryError("master rows exhausted while filling pilot")

    final_deficits = {
        cohort: max(0, quota - cohort_counts[cohort])
        for cohort, quota in quotas.items()
    }
    pilot_samples = [samples_by_id[sample_id] for sample_id in selected]
    pilot_work_counts = Counter(sample.work_id for sample in pilot_samples)
    pilot_chapter_counts = Counter(sample.chapter_key for sample in pilot_samples)
    pilot_page_counts = Counter(sample.page_key for sample in pilot_samples)
    diagnostics = {
        "chapter_count": len(pilot_chapter_counts),
        "chapter_maximum": max(pilot_chapter_counts.values(), default=0),
        "chapter_minimum": min(pilot_chapter_counts.values(), default=0),
        "page_maximum": max(pilot_page_counts.values(), default=0),
        "quota_deficits": dict(sorted(final_deficits.items())),
        "quota_targets": dict(sorted(quotas.items())),
        "work_count": len(pilot_work_counts),
        "work_maximum": max(pilot_work_counts.values(), default=0),
        "work_minimum": min(pilot_work_counts.values(), default=0),
    }
    normalized_reasons = {
        sample_id: sorted(values) for sample_id, values in reasons.items()
    }
    return selection_order, normalized_reasons, diagnostics


def _ordinary_quota(config: BuildConfig, chapter_key: tuple[str, str]) -> int:
    span = config.ordinary_max_per_chapter - config.ordinary_min_per_chapter + 1
    if config.ordinary_min_per_chapter < 0 or span <= 0:
        raise PilotInventoryError("invalid ordinary per-chapter quota range")
    key = "\0".join(chapter_key)
    return config.ordinary_min_per_chapter + (
        stable_number(config.seed, "calibration-ordinary-quota", key) % span
    )


def _balanced_chapter_candidates(
    candidates: Sequence[Sample], *, quota: int, seed: str, chapter_key: tuple[str, str]
) -> list[Sample]:
    selected: list[Sample] = []
    remaining = list(candidates)
    page_counts: Counter[tuple[str, str, str]] = Counter()
    while remaining and len(selected) < quota:
        sample = min(
            remaining,
            key=lambda item: (
                page_counts[item.page_key],
                stable_digest(seed, "calibration-ordinary-row", item.sample_id),
            ),
        )
        selected.append(sample)
        page_counts[sample.page_key] += 1
        remaining.remove(sample)
    return selected


def select_calibration(
    samples: Sequence[Sample], config: BuildConfig
) -> tuple[list[str], dict[str, list[str]], dict[str, Any]]:
    samples_by_id = {sample.sample_id: sample for sample in samples}
    selected: set[str] = set()
    reasons: defaultdict[str, set[str]] = defaultdict(set)
    risk_samples = [sample for sample in samples if "hard_risk_union" in sample.cohorts]
    for sample in risk_samples:
        selected.add(sample.sample_id)
        reasons[sample.sample_id].add("mandatory:hard_risk_union")

    chapters = sorted({sample.chapter_key for sample in samples})
    by_chapter: defaultdict[tuple[str, str], list[Sample]] = defaultdict(list)
    for sample in samples:
        if "ordinary_dialogue_proxy_control" in sample.cohorts:
            by_chapter[sample.chapter_key].append(sample)

    ordinary_targets: dict[str, int] = {}
    ordinary_selected: dict[str, int] = {}
    shortfalls: list[dict[str, Any]] = []
    for chapter_key in chapters:
        quota = _ordinary_quota(config, chapter_key)
        candidates = by_chapter.get(chapter_key, [])
        chosen = _balanced_chapter_candidates(
            candidates,
            quota=quota,
            seed=config.seed,
            chapter_key=chapter_key,
        )
        encoded_key = f"{chapter_key[0]}::{chapter_key[1]}"
        ordinary_targets[encoded_key] = quota
        ordinary_selected[encoded_key] = len(chosen)
        if len(chosen) < quota:
            shortfalls.append(
                {
                    "available": len(candidates),
                    "chapter_id": chapter_key[1],
                    "missing": quota - len(chosen),
                    "target": quota,
                    "work_id": chapter_key[0],
                }
            )
        for sample in chosen:
            selected.add(sample.sample_id)
            reasons[sample.sample_id].add("control:ordinary_dialogue_proxy")

    ordered = sorted(
        selected,
        key=lambda sample_id: (
            samples_by_id[sample_id].work_id,
            samples_by_id[sample_id].chapter_id,
            samples_by_id[sample_id].page_id,
            stable_digest(config.seed, "calibration-review-order", sample_id),
        ),
    )
    diagnostics = {
        "nominal_size": NOMINAL_CALIBRATION_SIZE,
        "observed_size": len(ordered),
        "ordinary_chapter_shortfalls": shortfalls,
        "ordinary_requested": sum(ordinary_targets.values()),
        "ordinary_selected": sum(ordinary_selected.values()),
        "ordinary_target_by_chapter": dict(sorted(ordinary_targets.items())),
        "risk_count_delta_from_plan": len(risk_samples) - NOMINAL_HARD_RISK_COUNT,
        "risk_count_nominal": NOMINAL_HARD_RISK_COUNT,
        "risk_count_observed": len(risk_samples),
    }
    normalized_reasons = {
        sample_id: sorted(values) for sample_id, values in reasons.items()
    }
    return ordered, normalized_reasons, diagnostics


def _counter_dict(values: Iterable[str]) -> dict[str, int]:
    return dict(sorted(Counter(values).items()))


def _waterfill_targets(
    capacities: Mapping[str, int],
    total: int,
    *,
    seed: str,
    purpose: str,
) -> dict[str, int]:
    if total > sum(capacities.values()):
        raise PilotInventoryError(
            f"waterfill target {total} exceeds capacity {sum(capacities.values())}"
        )
    targets = {key: 0 for key in capacities}
    ties = {key: stable_number(seed, purpose, key) for key in capacities}
    for _ in range(total):
        eligible = [
            key for key, capacity in capacities.items() if targets[key] < capacity
        ]
        if not eligible:
            raise PilotInventoryError("waterfill capacity was exhausted")
        key = min(eligible, key=lambda value: (targets[value], ties[value], value))
        targets[key] += 1
    return targets


def pilot_balance_diagnostics(
    samples: Sequence[Sample], selected_ids: Sequence[str], *, seed: str
) -> dict[str, Any]:
    by_id = {sample.sample_id: sample for sample in samples}
    selected = [by_id[sample_id] for sample_id in selected_ids]
    work_available = Counter(sample.work_id for sample in samples)
    work_selected = Counter(sample.work_id for sample in selected)
    work_ideal = _waterfill_targets(
        work_available,
        len(selected),
        seed=seed,
        purpose="pilot-work-waterfill",
    )
    work_deviation = {
        work_id: work_selected[work_id] - work_ideal[work_id]
        for work_id in work_available
    }

    chapter_available: Counter[tuple[str, str]] = Counter(
        sample.chapter_key for sample in samples
    )
    chapter_selected: Counter[tuple[str, str]] = Counter(
        sample.chapter_key for sample in selected
    )
    chapter_ideal: dict[tuple[str, str], int] = {}
    for work_id in sorted(work_available):
        capacities = {
            chapter_id: count
            for (chapter_work, chapter_id), count in chapter_available.items()
            if chapter_work == work_id
        }
        targets = _waterfill_targets(
            capacities,
            work_selected[work_id],
            seed=seed,
            purpose=f"pilot-chapter-waterfill:{work_id}",
        )
        chapter_ideal.update(
            {(work_id, chapter_id): value for chapter_id, value in targets.items()}
        )
    chapter_deviations = [
        chapter_selected[key] - chapter_ideal[key] for key in chapter_available
    ]
    return {
        "chapter_available_maximum": max(chapter_available.values(), default=0),
        "chapter_available_minimum": min(chapter_available.values(), default=0),
        "chapter_full_saturation_count": sum(
            chapter_selected[key] == available
            for key, available in chapter_available.items()
        ),
        "chapter_selected_count_histogram": {
            str(count): frequency
            for count, frequency in sorted(Counter(chapter_selected.values()).items())
        },
        "chapter_waterfill_l1_deviation": sum(
            abs(value) for value in chapter_deviations
        ),
        "chapter_waterfill_max_abs_deviation": max(
            (abs(value) for value in chapter_deviations), default=0
        ),
        "work_available_by_id": dict(sorted(work_available.items())),
        "work_full_saturation_count": sum(
            work_selected[work_id] == available
            for work_id, available in work_available.items()
        ),
        "work_ideal_waterfill_by_id": dict(sorted(work_ideal.items())),
        "work_selected_by_id": dict(sorted(work_selected.items())),
        "work_waterfill_l1_deviation": sum(
            abs(value) for value in work_deviation.values()
        ),
        "work_waterfill_max_abs_deviation": max(
            (abs(value) for value in work_deviation.values()), default=0
        ),
    }


def summarize_selection(
    samples: Sequence[Sample], selected_ids: Sequence[str]
) -> dict[str, Any]:
    by_id = {sample.sample_id: sample for sample in samples}
    selected = [by_id[sample_id] for sample_id in selected_ids]
    cohort_counts = Counter(cohort for sample in selected for cohort in sample.cohorts)
    orientation_counts = Counter(sample.orientation for sample in selected)
    total = len(selected)
    return {
        "by_catalog": _counter_dict(sample.catalog_id for sample in selected),
        "by_cohort": dict(sorted(cohort_counts.items())),
        "by_orientation": dict(sorted(orientation_counts.items())),
        "by_split": _counter_dict(sample.split for sample in selected),
        "chapter_count": len({sample.chapter_key for sample in selected}),
        "horizontal_rate": round(orientation_counts["horizontal"] / total, 8)
        if total
        else 0.0,
        "record_count": total,
        "unique_page_count": len({sample.page_key for sample in selected}),
        "work_count": len({sample.work_id for sample in selected}),
    }


def _configuration_dict(config: BuildConfig) -> dict[str, Any]:
    return {
        "ordinary_max_per_chapter": config.ordinary_max_per_chapter,
        "ordinary_min_per_chapter": config.ordinary_min_per_chapter,
        "pilot_quota_rates": dict(sorted(PILOT_QUOTA_RATES.items())),
        "pilot_size": config.pilot_size,
        "risk_thresholds": config.thresholds.as_dict(),
        "seed": config.seed,
    }


def build_bundle(
    master_manifest: Path,
    *,
    config: BuildConfig = BuildConfig(),
    expected_rows: int | None = EXPECTED_MASTER_ROWS,
    expected_works: int | None = EXPECTED_WORKS,
    expected_chapters: int | None = EXPECTED_CHAPTERS,
    expected_manual_recrops: int | None = EXPECTED_MANUAL_RECROPS,
) -> InventoryBundle:
    samples, master_hash = read_master(master_manifest, thresholds=config.thresholds)
    validate_expected_coverage(
        samples,
        expected_rows=expected_rows,
        expected_works=expected_works,
        expected_chapters=expected_chapters,
        expected_manual_recrops=expected_manual_recrops,
    )
    pilot_ids, pilot_reasons, pilot_diagnostics = select_pilot(samples, config)
    calibration_ids, calibration_reasons, calibration_diagnostics = select_calibration(
        samples, config
    )
    pilot_ranks = {sample_id: rank for rank, sample_id in enumerate(pilot_ids, 1)}
    calibration_ranks = {
        sample_id: rank for rank, sample_id in enumerate(calibration_ids, 1)
    }
    by_id = {sample.sample_id: sample for sample in samples}
    inventory_rows: list[dict[str, Any]] = []
    for sample_id in sorted(set(pilot_ids) | set(calibration_ids)):
        sample = by_id[sample_id]
        batches: dict[str, Any] = {}
        if sample_id in pilot_ranks:
            batches["pilot"] = {
                "review_order": pilot_ranks[sample_id],
                "selection_reasons": pilot_reasons[sample_id],
            }
        if sample_id in calibration_ranks:
            batches["calibration"] = {
                "review_order": calibration_ranks[sample_id],
                "selection_reasons": calibration_reasons[sample_id],
            }
        inventory_rows.append(
            {
                "batches": batches,
                "chapter_id": sample.chapter_id,
                "cohorts": sorted(sample.cohorts),
                "master_line_number": sample.line_number,
                "master_manifest_sha256": master_hash,
                "orientation": sample.orientation,
                "page_id": sample.page_id,
                "provenance": {
                    "qa_overlay": False,
                    "source_catalog_id": sample.catalog_id,
                    "synthetic": False,
                },
                "sample_id": sample.sample_id,
                "schema_version": INVENTORY_SCHEMA_VERSION,
                "split": sample.split,
                "work_id": sample.work_id,
            }
        )
    inventory_payload = jsonl_bytes(inventory_rows)
    source_summary = summarize_selection(
        samples, [sample.sample_id for sample in samples]
    )
    pilot_summary = summarize_selection(samples, pilot_ids)
    calibration_summary = summarize_selection(samples, calibration_ids)
    pilot_diagnostics["balance"] = pilot_balance_diagnostics(
        samples, pilot_ids, seed=config.seed
    )
    horizontal_enrichment = (
        pilot_summary["horizontal_rate"] / source_summary["horizontal_rate"]
        if source_summary["horizontal_rate"]
        else None
    )
    coverage_status = "complete"
    coverage_flags: list[str] = []
    if any(pilot_diagnostics["quota_deficits"].values()):
        coverage_status = "coverage_gap"
        coverage_flags.append("pilot_quota_deficit")
    if calibration_diagnostics["ordinary_chapter_shortfalls"]:
        coverage_status = "coverage_gap"
        coverage_flags.append("ordinary_proxy_shortfall")
    if calibration_diagnostics["risk_count_delta_from_plan"] != 0:
        coverage_flags.append("hard_risk_count_differs_from_plan_nominal")
    report = {
        "algorithm_version": ALGORITHM_VERSION,
        "configuration": _configuration_dict(config),
        "coverage": {
            "flags": coverage_flags,
            "manual_recrops_in_pilot": pilot_summary["by_cohort"].get(
                "manual_recrop", 0
            ),
            "manual_recrops_in_source": source_summary["by_cohort"].get(
                "manual_recrop", 0
            ),
            "pilot_all_chapters_covered": (
                pilot_summary["chapter_count"] == source_summary["chapter_count"]
            ),
            "pilot_all_manual_recrops_included": (
                pilot_summary["by_cohort"].get("manual_recrop", 0)
                == source_summary["by_cohort"].get("manual_recrop", 0)
            ),
            "pilot_all_works_covered": (
                pilot_summary["work_count"] == source_summary["work_count"]
            ),
            "pilot_horizontal_enrichment_ratio": round(horizontal_enrichment, 8)
            if horizontal_enrichment is not None
            else None,
            "status": coverage_status,
        },
        "inputs": {
            "master_manifest_sha256": master_hash,
            "record_count": len(samples),
        },
        "outputs": {
            "calibration_order_sha256": sha256_bytes(
                ("\n".join(calibration_ids) + "\n").encode("utf-8")
            ),
            "inventory_record_count": len(inventory_rows),
            "inventory_sha256": sha256_bytes(inventory_payload),
            "pilot_order_sha256": sha256_bytes(
                ("\n".join(pilot_ids) + "\n").encode("utf-8")
            ),
        },
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "selection": {
            "calibration": {
                "diagnostics": calibration_diagnostics,
                "summary": calibration_summary,
            },
            "pilot": {
                "diagnostics": pilot_diagnostics,
                "summary": pilot_summary,
            },
            "source": source_summary,
        },
        "tool": TOOL_ID,
    }
    report_payload = json_bytes(report, pretty=True)
    return InventoryBundle(
        inventory_rows=inventory_rows,
        inventory_bytes=inventory_payload,
        report=report,
        report_bytes=report_payload,
        pilot_ids=pilot_ids,
        calibration_ids=calibration_ids,
    )


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False
    )
    temporary = Path(handle.name)
    try:
        with handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PilotInventoryError(f"could not read {path}: {error}") from error
    if not isinstance(value, dict):
        raise PilotInventoryError(f"{path}: expected JSON object")
    return value


def write_bundle(output_dir: Path, bundle: InventoryBundle) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    managed_names = {"inventory.jsonl", "report.json"}
    unknown = [path for path in output_dir.iterdir() if path.name not in managed_names]
    if unknown:
        raise PilotInventoryError(
            f"output directory contains unmanaged file: {unknown[0]}"
        )
    existing_report = output_dir / "report.json"
    if existing_report.exists():
        report = _read_json_object(existing_report)
        if report.get("tool") != TOOL_ID:
            raise PilotInventoryError(
                "refusing to overwrite output not owned by this tool"
            )
    _atomic_write(output_dir / "inventory.jsonl", bundle.inventory_bytes)
    _atomic_write(output_dir / "report.json", bundle.report_bytes)


def config_from_report(report: Mapping[str, Any]) -> BuildConfig:
    config = required_mapping(
        report.get("configuration"), location="report.configuration"
    )
    thresholds = required_mapping(
        config.get("risk_thresholds"),
        location="report.configuration.risk_thresholds",
    )
    if config.get("pilot_quota_rates") != dict(sorted(PILOT_QUOTA_RATES.items())):
        raise PilotInventoryError("report pilot quota policy differs from this tool")
    return BuildConfig(
        pilot_size=int(config.get("pilot_size")),
        seed=required_text(config.get("seed"), location="report.configuration.seed"),
        ordinary_min_per_chapter=int(config.get("ordinary_min_per_chapter")),
        ordinary_max_per_chapter=int(config.get("ordinary_max_per_chapter")),
        thresholds=RiskThresholds(
            inverse_min=float(thresholds.get("inverse_min")),
            color_min=float(thresholds.get("color_min")),
            outline_low_max=float(thresholds.get("outline_low_max")),
            outline_high_min=float(thresholds.get("outline_high_min")),
        ),
    )


def validate_bundle(
    output_dir: Path,
    master_manifest: Path,
    *,
    expected_rows: int | None = EXPECTED_MASTER_ROWS,
    expected_works: int | None = EXPECTED_WORKS,
    expected_chapters: int | None = EXPECTED_CHAPTERS,
    expected_manual_recrops: int | None = EXPECTED_MANUAL_RECROPS,
) -> dict[str, Any]:
    inventory_path = output_dir / "inventory.jsonl"
    report_path = output_dir / "report.json"
    report = _read_json_object(report_path)
    if report.get("tool") != TOOL_ID:
        raise PilotInventoryError("report tool/ownership marker is invalid")
    if report.get("algorithm_version") != ALGORITHM_VERSION:
        raise PilotInventoryError("report algorithm version is unsupported")
    if report.get("report_schema_version") != REPORT_SCHEMA_VERSION:
        raise PilotInventoryError("report schema version is unsupported")
    try:
        inventory_payload = inventory_path.read_bytes()
    except OSError as error:
        raise PilotInventoryError(
            f"could not read {inventory_path}: {error}"
        ) from error
    if nested(report, "outputs", "inventory_sha256") != sha256_bytes(inventory_payload):
        raise PilotInventoryError("inventory hash does not match report")
    config = config_from_report(report)
    rebuilt = build_bundle(
        master_manifest,
        config=config,
        expected_rows=expected_rows,
        expected_works=expected_works,
        expected_chapters=expected_chapters,
        expected_manual_recrops=expected_manual_recrops,
    )
    if rebuilt.inventory_bytes != inventory_payload:
        raise PilotInventoryError("inventory is not the deterministic rebuild")
    if rebuilt.report_bytes != report_path.read_bytes():
        raise PilotInventoryError("report is not the deterministic rebuild")
    return {
        "calibration_count": len(rebuilt.calibration_ids),
        "coverage_status": nested(rebuilt.report, "coverage", "status"),
        "inventory_sha256": sha256_bytes(inventory_payload),
        "pilot_count": len(rebuilt.pilot_ids),
        "status": "valid",
    }


def production_pilot_size(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected an integer") from error
    if not MIN_PILOT_SIZE <= parsed <= MAX_PILOT_SIZE:
        raise argparse.ArgumentTypeError(
            f"pilot size must be {MIN_PILOT_SIZE}..{MAX_PILOT_SIZE}"
        )
    return parsed


def non_negative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a non-negative integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("expected a non-negative integer")
    return parsed


def add_master_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v1/manifest.jsonl"),
    )
    parser.add_argument(
        "--expected-master-count", type=non_negative_int, default=EXPECTED_MASTER_ROWS
    )
    parser.add_argument(
        "--expected-work-count", type=non_negative_int, default=EXPECTED_WORKS
    )
    parser.add_argument(
        "--expected-chapter-count", type=non_negative_int, default=EXPECTED_CHAPTERS
    )
    parser.add_argument(
        "--expected-manual-recrop-count",
        type=non_negative_int,
        default=EXPECTED_MANUAL_RECROPS,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("build", "report"):
        sub = subparsers.add_parser(command)
        add_master_arguments(sub)
        sub.add_argument(
            "--pilot-size", type=production_pilot_size, default=DEFAULT_PILOT_SIZE
        )
        sub.add_argument("--seed", default=DEFAULT_SEED)
        if command == "build":
            sub.add_argument(
                "--output-dir",
                type=Path,
                default=Path("datasets/font-matching-review-inventory-v1"),
            )
            sub.add_argument("--dry-run", action="store_true")
    validate = subparsers.add_parser("validate")
    add_master_arguments(validate)
    validate.add_argument(
        "--output-dir",
        type=Path,
        default=Path("datasets/font-matching-review-inventory-v1"),
    )
    return parser


def _expected_kwargs(args: argparse.Namespace) -> dict[str, int]:
    return {
        "expected_rows": args.expected_master_count,
        "expected_works": args.expected_work_count,
        "expected_chapters": args.expected_chapter_count,
        "expected_manual_recrops": args.expected_manual_recrop_count,
    }


def _compact_summary(bundle: InventoryBundle) -> dict[str, Any]:
    return {
        "calibration_count": len(bundle.calibration_ids),
        "coverage_flags": nested(bundle.report, "coverage", "flags"),
        "coverage_status": nested(bundle.report, "coverage", "status"),
        "inventory_sha256": nested(bundle.report, "outputs", "inventory_sha256"),
        "pilot_count": len(bundle.pilot_ids),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command in {"build", "report"}:
            bundle = build_bundle(
                args.master_manifest.resolve(),
                config=BuildConfig(pilot_size=args.pilot_size, seed=args.seed),
                **_expected_kwargs(args),
            )
            if args.command == "report" or args.dry_run:
                print(bundle.report_bytes.decode("utf-8"), end="")
                return 0
            write_bundle(args.output_dir.resolve(), bundle)
            print(canonical_json(_compact_summary(bundle)))
            return 0
        result = validate_bundle(
            args.output_dir.resolve(),
            args.master_manifest.resolve(),
            **_expected_kwargs(args),
        )
        print(canonical_json(result))
        return 0
    except (OSError, PilotInventoryError, TypeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
