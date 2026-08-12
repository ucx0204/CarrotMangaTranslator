#!/usr/bin/env python3
"""Build a leakage-safe, blind-first high-value font supervision queue.

This queue is intentionally *not* a label artifact.  Model predictions are
used only to find informative ``train`` crops.  Every public row presents
seven opaque Korean render slots; candidate identities, probabilities and
selection reasons live in a separately sealed private binding.  Pending or
partially reviewed rows remain ineligible for training until a later explicit
human adjudication step searches the full production catalog.

The builder excludes prior human/agent-reviewed sample IDs, every non-train
master row, the adjudicated val33 set, independent blind calibration/eval
rows, and source pages used by library 40-page QA cohorts.  Selection then
balances works, chapters and pages while prioritising model disagreement,
low margins, diverse/rare raw top candidates, dialogue/emphasis boundaries,
SFX/shout/sign crops, and Single Day specialist positives/hard negatives.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - repository-root import
    from scripts import font_matching_catalog_assets as catalog_assets


SCHEMA_VERSION = "manga-font-v2-high-value-supervised-queue-v1"
DECISION_SCHEMA_VERSION = "manga-font-v2-high-value-supervised-decision-v1"
RECORD_TYPE = "manga_font_v2_high_value_blind_review_item"
PRIVATE_RECORD_TYPE = "manga_font_v2_high_value_private_binding"
REPORT_RECORD_TYPE = "manga_font_v2_high_value_queue_report"
OWNER = "carrot-manga-translator/manga-font-v2-high-value-supervised-queue-v1"
MARKER_FILE = ".manga-font-v2-high-value-supervised-queue-owned.json"
REPORT_FILE = "report.json"
QUEUE_FILE = "review-queue.jsonl"
PRIVATE_FILE = "private-bindings.jsonl"
DECISIONS_FILE = "decisions-template.jsonl"
SHEETS_DIR = "contact-sheets"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
PANEL_SIZE = 7
MIN_PRODUCTION_ROWS = 800
MAX_PRODUCTION_ROWS = 1200
SHA_RE = re.compile(r"^[0-9a-f]{64}$")

FONT_FAMILY_BY_ID: Mapping[str, str] = {
    "nanum-gothic": "body-sans",
    "nanum-barun-gothic": "body-sans",
    "seoul-namsan": "body-sans",
    "seoul-namsan-vertical": "body-sans",
    "nanum-myeongjo": "body-serif",
    "seoul-hangang": "body-serif",
    "ridi-batang": "body-serif",
    "dohyeon": "display",
    "jua": "display",
    "black-han-sans": "display",
    "gasoek-one": "display",
    "mongtori": "handwritten",
    "griun-pol-sensibility": "handwritten",
    "cafe24-gowoonbam": "handwritten",
    "start-over": "handwritten",
    "gaegu": "handwritten",
    "kirang-haerang": "handwritten",
    "single-day": "handwritten",
    "chosun-gungseo": "brush",
    "nanum-brush-script": "brush",
    "black-and-white-picture": "effect",
}
BODY_FAMILIES = frozenset({"body-sans", "body-serif"})
SPECIALIST_FAMILIES = frozenset({"display", "handwritten", "brush", "effect"})

# Quotas sum to 1.0.  A selected row may have several signals, but it receives
# one primary queue focus so reviewers do not repeatedly see the same crop.
FOCUS_WEIGHTS: Mapping[str, float] = {
    "single_day_ordinary_hard_negative": 0.14,
    "single_day_specialist_positive": 0.07,
    "dialogue_emphasis_boundary": 0.19,
    "shout_sign_sfx": 0.20,
    "model_disagreement": 0.16,
    "rare_diverse_raw_top3": 0.13,
    "low_margin": 0.11,
}

PROBE_BY_ROLE: Mapping[str, str] = {
    "dialogue": "dialogue-body",
    "narration": "narration",
    "thought": "thought-monologue",
    "aside_whisper": "aside-whisper",
    "emphasis": "emphasis-shout",
    "shout": "emphasis-shout",
    "sign": "narration",
    "sfx": "sfx-impact",
    "other": "emphasis-shout",
}


class HighValueQueueError(ValueError):
    """Raised when queue inputs, boundaries, or seals are unsafe."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> None:
    declared = record.get("record_sha256")
    if not isinstance(declared, str) or SHA_RE.fullmatch(declared) is None:
        raise HighValueQueueError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != declared:
        raise HighValueQueueError(f"{location}: record seal mismatch")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HighValueQueueError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise HighValueQueueError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise HighValueQueueError(f"{location}: expected text")
    return result


def _finite(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    if path.is_symlink() or not path.is_file():
        raise HighValueQueueError(f"{location}: missing or linked JSONL")
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise HighValueQueueError(f"{location}:{line_number}: invalid JSON") from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HighValueQueueError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes("".join(canonical_json(row) + "\n" for row in rows).encode("utf-8"))


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise HighValueQueueError(f"unsafe output directory: {result}")
    return result


def _safe_relative(value: Any, location: str) -> PurePosixPath:
    raw = _text(value, location).replace("\\", "/")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or not relative.parts or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        raise HighValueQueueError(f"{location}: unsafe relative path")
    return relative


def _inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    path = root.joinpath(*relative.parts).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise HighValueQueueError(f"{location}: path escapes artifact") from error
    return path


def _nested(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _sample_ids_recursive(value: Any) -> set[str]:
    result: set[str] = set()
    if isinstance(value, Mapping):
        for key, child in value.items():
            if key in {"sample_id", "id"} and isinstance(child, str) and child.startswith("fm_"):
                result.add(child)
            result.update(_sample_ids_recursive(child))
    elif isinstance(value, list):
        for child in value:
            result.update(_sample_ids_recursive(child))
    return result


@dataclass(frozen=True)
class ExclusionInventory:
    reviewed_ids: frozenset[str]
    val33_ids: frozenset[str]
    blind_pool_ids: frozenset[str]
    qa_page_sha256: frozenset[str]
    descriptors: tuple[Mapping[str, Any], ...]

    @property
    def all_sample_ids(self) -> frozenset[str]:
        return frozenset(set(self.reviewed_ids) | set(self.val33_ids) | set(self.blind_pool_ids))


def _curated_exclusion_files(artifacts_root: Path) -> dict[str, list[Path]]:
    """Discover only known review authorities, never generic pseudo outputs."""

    patterns: Mapping[str, Sequence[str]] = {
        "val33": (
            "manga-font-student-human-overlay-adjudicated-val33-v1/val-samples-adjudicated.jsonl",
        ),
        "blind_pool": (
            "manga-font-v2-independent-blind-calibration-eval-pool-*/review-queue.jsonl",
            "manga-font-v2-independent-blind-calibration-eval-pool-*/private-bindings.jsonl",
        ),
        "reviewed": (
            "manga-font-v7-active21-fast-review-*/human-gold-separated.jsonl",
            "manga-font-v7-review-agent-*-round2-v1/confirmed.jsonl",
            "manga-font-v7-review-agent-*-round2-v1/corrections.jsonl",
            "manga-font-v7-review-agent-*-round2-v1/review-needed.jsonl",
            "manga-font-v7-mass21-visual-pseudo-overlay-*/heldout-visual-decisions.jsonl",
            "manga-font-named-train-overlay-*/train-samples-named-overlay.jsonl",
            "manga-font-named-train-overlay-*/disagreement-low-confidence-review-queue.jsonl",
            "manga-font-named-train-judgments-*/**/*.jsonl",
        ),
    }
    result: dict[str, list[Path]] = {key: [] for key in patterns}
    for category, globs in patterns.items():
        seen: set[Path] = set()
        for pattern in globs:
            for path in artifacts_root.glob(pattern):
                resolved = path.resolve()
                if resolved.is_file() and resolved not in seen:
                    seen.add(resolved)
                    result[category].append(resolved)
        result[category].sort(key=lambda item: item.as_posix())
    return result


def load_exclusion_inventory(
    artifacts_root: Path,
    *,
    extra_exclusion_files: Sequence[Path] = (),
    qa_roots: Sequence[Path] = (),
) -> ExclusionInventory:
    root = artifacts_root.resolve()
    discovered = _curated_exclusion_files(root)
    discovered["reviewed"].extend(path.resolve() for path in extra_exclusion_files)
    ids_by_category: dict[str, set[str]] = {key: set() for key in discovered}
    descriptors: list[Mapping[str, Any]] = []
    visited: set[Path] = set()
    for category in ("reviewed", "val33", "blind_pool"):
        for path in sorted(set(discovered[category]), key=lambda item: item.as_posix()):
            if path in visited:
                continue
            visited.add(path)
            before = len(ids_by_category[category])
            row_count = 0
            for row in _iter_jsonl(path, f"exclusion[{path.name}]"):
                row_count += 1
                ids_by_category[category].update(_sample_ids_recursive(row))
            descriptors.append(
                {
                    "category": category,
                    "file": str(path),
                    "row_count": row_count,
                    "sample_ids_added": len(ids_by_category[category]) - before,
                    "sha256": sha256_file(path),
                }
            )

    qa_pages: set[str] = set()
    qa_candidates: set[Path] = set()
    roots = tuple(path.resolve() for path in qa_roots) or (root,)
    for qa_root in roots:
        if qa_root.is_file():
            qa_candidates.add(qa_root)
        elif qa_root.is_dir():
            qa_candidates.update(
                path.resolve()
                for path in qa_root.glob("library-full-pipeline-font-qa-v*/cohorts/*.jsonl")
                if path.is_file()
            )
            qa_candidates.update(
                path.resolve()
                for path in qa_root.glob("cohorts/*.jsonl")
                if path.is_file()
            )
    for path in sorted(qa_candidates, key=lambda item: item.as_posix()):
        row_count = 0
        before = len(qa_pages)
        for row in _iter_jsonl(path, f"qa cohort[{path.name}]"):
            row_count += 1
            page = row.get("page")
            if isinstance(page, Mapping):
                for key in ("imageSha256", "source_page_sha256", "sourcePageSha256"):
                    value = page.get(key)
                    if isinstance(value, str) and SHA_RE.fullmatch(value):
                        qa_pages.add(value)
        descriptors.append(
            {
                "category": "qa_page",
                "file": str(path),
                "row_count": row_count,
                "page_sha256_added": len(qa_pages) - before,
                "sha256": sha256_file(path),
            }
        )
    return ExclusionInventory(
        reviewed_ids=frozenset(ids_by_category["reviewed"]),
        val33_ids=frozenset(ids_by_category["val33"]),
        blind_pool_ids=frozenset(ids_by_category["blind_pool"]),
        qa_page_sha256=frozenset(qa_pages),
        descriptors=tuple(descriptors),
    )


def _active_candidates(path: Path) -> tuple[str, ...]:
    document = _read_json(path, "active candidate catalog")
    ids = tuple(str(value) for value in _sequence(document.get("candidate_ids"), "candidate_ids"))
    if len(ids) != 21 or len(set(ids)) != 21 or set(ids) != set(FONT_FAMILY_BY_ID):
        raise HighValueQueueError("active catalog must contain the exact 21 production fonts")
    expected = sha256_bytes(("\n".join(ids) + "\n").encode("utf-8"))
    if document.get("candidate_count") != 21 or document.get("candidate_order_sha256") != expected:
        raise HighValueQueueError("active catalog candidate binding drift")
    return ids


def _top_ids(candidate_ids: Sequence[str], probabilities: Sequence[float], count: int) -> list[str]:
    return [
        candidate_ids[index]
        for index in sorted(
            range(len(candidate_ids)),
            key=lambda index: (-float(probabilities[index]), candidate_ids[index]),
        )[:count]
    ]


def _normalized_entropy(probabilities: Sequence[float]) -> float:
    values = [max(0.0, float(value)) for value in probabilities]
    total = sum(values)
    if total <= 0.0 or len(values) <= 1:
        return 0.0
    values = [value / total for value in values]
    return -sum(value * math.log(value) for value in values if value > 0.0) / math.log(len(values))


def normalize_role(role_value: Any, source_category: str) -> str:
    value = str(role_value or "").strip().lower().replace("-", "_")
    if "sfx" in value or "sound" in value or source_category == "page_sound":
        return "sfx"
    if "shout" in value:
        return "shout"
    if "emphasis" in value:
        return "emphasis"
    if "sign" in value or "title" in value or "ui" in value:
        return "sign"
    if "aside" in value or "whisper" in value:
        return "aside_whisper"
    if "thought" in value or "monologue" in value:
        return "thought"
    if "narrat" in value:
        return "narration"
    if "dialog" in value:
        return "dialogue"
    if source_category == "bubble_edge":
        return "aside_whisper"
    if source_category == "ordinary":
        return "dialogue"
    return "other"


def _role_from_fast_review(row: Mapping[str, Any] | None, source_category: str) -> str:
    if row is not None:
        probe = row.get("role_probe")
        if isinstance(probe, Mapping) and probe.get("role"):
            return normalize_role(probe.get("role"), source_category)
        summaries = row.get("pass_summaries")
        if isinstance(summaries, list) and summaries:
            top3 = _nested(summaries[-1], "role", "top3")
            if isinstance(top3, list) and top3 and isinstance(top3[0], Mapping):
                return normalize_role(top3[0].get("role"), source_category)
    return normalize_role(None, source_category)


def _geometry_features(master: Mapping[str, Any]) -> tuple[float, float]:
    bbox = _nested(master, "geometry", "final_bbox_px")
    page = _nested(master, "geometry", "page_size_px")
    if not isinstance(bbox, list) or len(bbox) != 4 or not isinstance(page, list) or len(page) != 2:
        return 1.0, 0.0
    width = max(1.0, _finite(bbox[2]) - _finite(bbox[0]))
    height = max(1.0, _finite(bbox[3]) - _finite(bbox[1]))
    page_area = max(1.0, _finite(page[0], 1.0) * _finite(page[1], 1.0))
    return width / height, (width * height) / page_area


def sampling_role_hint(
    master: Mapping[str, Any], fast: Mapping[str, Any] | None, source_category: str
) -> str:
    """Return a navigation hint, never a supervised role label."""

    if source_category == "page_sound":
        return "sfx"
    aspect, area = _geometry_features(master)
    orientation = _orientation(master)
    outline = _finite(_nested(master, "metadata", "style_metrics", "outline_structure_ratio"))
    score = _finite(_nested(master, "metadata", "candidate_score"))
    if source_category in {
        "text_free",
        "ocr_hard",
        "ocr_anime_region",
        "font_signal_present",
    }:
        if orientation == "horizontal" or aspect >= 1.35:
            return "sign"
        if outline >= 0.16 or score >= 0.88:
            return "shout"
        return "emphasis"
    if source_category == "bubble_edge":
        if area <= 0.0045:
            return "aside_whisper"
        return "dialogue"
    if source_category == "ordinary":
        if orientation == "horizontal" and aspect >= 1.25:
            return "narration"
        return "dialogue"
    return _role_from_fast_review(fast, source_category)


def _raw_top_ids(fast: Mapping[str, Any] | None) -> list[str]:
    if fast is None or not isinstance(fast.get("candidates"), list):
        return []
    ranked: list[tuple[int, str]] = []
    for position, raw in enumerate(fast["candidates"]):
        if not isinstance(raw, Mapping):
            continue
        candidate = raw.get("candidate_id")
        if not isinstance(candidate, str) or candidate not in FONT_FAMILY_BY_ID:
            continue
        best_rank = _nested(raw, "aggregate", "best_rank")
        rank = int(best_rank) if isinstance(best_rank, int) else position + 1
        ranked.append((rank, candidate))
    return [candidate for _, candidate in sorted(ranked)]


def _summary_value(fast: Mapping[str, Any] | None, key: str) -> Any:
    summaries = fast.get("pass_summaries") if fast is not None else None
    if isinstance(summaries, list) and summaries and isinstance(summaries[-1], Mapping):
        return summaries[-1].get(key)
    return None


def _chapter_majority(fast: Mapping[str, Any] | None) -> str | None:
    value = _nested(fast, "chapter_consistency", "majority_font_id")
    return value if isinstance(value, str) and value in FONT_FAMILY_BY_ID else None


@dataclass
class FeatureRow:
    master: Mapping[str, Any]
    pseudo: Mapping[str, Any]
    fast: Mapping[str, Any] | None
    legacy_sheet: Mapping[str, Any] | None
    sample_id: str
    work_id: str
    chapter_id: str
    page_sha256: str
    source_category: str
    role: str
    orientation: str
    probabilities: tuple[float, ...]
    candidate_ids: tuple[str, ...]
    refined_top: tuple[str, ...]
    raw_top: tuple[str, ...]
    direct_top1: str | None
    raw_ranker_top1: str | None
    model_disagreement: bool
    view_disagreement: float
    top1_margin: float
    entropy: float
    rare_raw_top3: bool = False
    info_score: float = 0.0
    focus_flags: tuple[str, ...] = ()
    primary_focus: str | None = None


def _orientation(master: Mapping[str, Any]) -> str:
    return "vertical" if _nested(master, "metadata", "orientation") == "vertical" else "horizontal"


def _source_category(master: Mapping[str, Any], pseudo: Mapping[str, Any]) -> str:
    value = pseudo.get("source_category") or _nested(master, "metadata", "candidate_primary_category")
    return str(value) if isinstance(value, str) and value else "ordinary"


def build_feature(
    master: Mapping[str, Any],
    pseudo: Mapping[str, Any],
    fast: Mapping[str, Any] | None,
    legacy_sheet: Mapping[str, Any] | None,
) -> FeatureRow:
    sample_id = _text(master.get("id"), "master.id")
    master_core = {key: value for key, value in master.items() if key != "record_sha256"}
    actual_master_sha = sha256_bytes(canonical_json(master_core).encode("utf-8"))
    if pseudo.get("master_row_sha256") not in {None, actual_master_sha}:
        raise HighValueQueueError(f"{sample_id}: pseudo/master row binding drift")
    candidate_ids = tuple(str(value) for value in _sequence(pseudo.get("candidate_ids"), "pseudo.candidates"))
    probabilities = tuple(_finite(value) for value in _sequence(pseudo.get("probabilities"), "pseudo.probabilities"))
    if len(candidate_ids) != 21 or len(probabilities) != 21 or set(candidate_ids) != set(FONT_FAMILY_BY_ID):
        raise HighValueQueueError(f"{sample_id}: pseudo candidate contract drift")
    total = sum(probabilities)
    if total <= 0.0:
        raise HighValueQueueError(f"{sample_id}: empty probability distribution")
    probabilities = tuple(max(0.0, value) / total for value in probabilities)
    refined_top = tuple(_top_ids(candidate_ids, probabilities, 7))
    raw_top = tuple(_raw_top_ids(fast))
    summary_ranker = _summary_value(fast, "ranker_top1_font_id")
    raw_ranker = summary_ranker if isinstance(summary_ranker, str) else (raw_top[0] if raw_top else None)
    summary_direct = _summary_value(fast, "direct_top1_font_id")
    direct_top = summary_direct if isinstance(summary_direct, str) and summary_direct in FONT_FAMILY_BY_ID else None
    priority_signals = _nested(fast, "priority", "signals")
    view_disagreement = _finite(
        priority_signals.get("view_top1_disagreement") if isinstance(priority_signals, Mapping) else 0.0
    )
    top1_margin = max(0.0, probabilities[candidate_ids.index(refined_top[0])] - probabilities[candidate_ids.index(refined_top[1])])
    category = _source_category(master, pseudo)
    role = sampling_role_hint(master, fast, category)
    disagreement_values = {value for value in (refined_top[0], raw_ranker, direct_top) if value}
    model_disagreement = len(disagreement_values) > 1 or view_disagreement > 0.0
    page_sha = _text(_nested(master, "page", "source_page_sha256"), f"{sample_id}.page_sha")
    return FeatureRow(
        master=master,
        pseudo=pseudo,
        fast=fast,
        legacy_sheet=legacy_sheet,
        sample_id=sample_id,
        work_id=_text(_nested(master, "work", "id"), f"{sample_id}.work"),
        chapter_id=_text(_nested(master, "chapter", "id"), f"{sample_id}.chapter"),
        page_sha256=page_sha,
        source_category=category,
        role=role,
        orientation=_orientation(master),
        probabilities=probabilities,
        candidate_ids=candidate_ids,
        refined_top=refined_top,
        raw_top=raw_top,
        direct_top1=direct_top,
        raw_ranker_top1=raw_ranker,
        model_disagreement=model_disagreement,
        view_disagreement=view_disagreement,
        top1_margin=top1_margin,
        entropy=_normalized_entropy(probabilities),
    )


def annotate_information_features(rows: Sequence[FeatureRow]) -> None:
    raw_top1_counts = Counter(row.raw_top[0] if row.raw_top else row.refined_top[0] for row in rows)
    non_single_counts = sorted(
        count for candidate, count in raw_top1_counts.items() if candidate != "single-day"
    )
    rare_cutoff = non_single_counts[max(0, len(non_single_counts) // 3 - 1)] if non_single_counts else 0
    rare_fonts = {
        candidate for candidate, count in raw_top1_counts.items()
        if candidate != "single-day" and count <= rare_cutoff
    }
    for row in rows:
        raw3 = row.raw_top[:3] or row.refined_top[:3]
        raw5 = set(row.raw_top[:5] or row.refined_top[:5])
        families = {FONT_FAMILY_BY_ID[candidate] for candidate in raw3}
        row.rare_raw_top3 = any(candidate in rare_fonts for candidate in raw3)
        single_day_signal = "single-day" in raw5 or "single-day" in row.refined_top[:3]
        ordinary_role = row.role in {"dialogue", "narration", "thought"}
        specialist_role = row.role in {"aside_whisper", "emphasis", "shout", "sign", "sfx"}
        has_body = bool(families & BODY_FAMILIES)
        has_specialist = bool(families & SPECIALIST_FAMILIES)
        flags: list[str] = []
        if single_day_signal and ordinary_role and row.source_category in {"ordinary", "bubble_edge"}:
            flags.append("single_day_ordinary_hard_negative")
        if single_day_signal and specialist_role:
            flags.append("single_day_specialist_positive")
        if (ordinary_role and has_specialist) or (
            row.role in {"emphasis", "shout", "aside_whisper"} and has_body
        ):
            flags.append("dialogue_emphasis_boundary")
        if row.role in {"emphasis", "shout", "sign", "sfx"}:
            flags.append("shout_sign_sfx")
        if row.model_disagreement:
            flags.append("model_disagreement")
        if row.rare_raw_top3 and len(families) >= 2:
            flags.append("rare_diverse_raw_top3")
        if row.top1_margin <= 0.12 or row.entropy >= 0.72:
            flags.append("low_margin")
        if not flags:
            flags.append("low_margin")
        disagreement_score = (
            (0.55 if row.model_disagreement else 0.0)
            + min(0.25, row.view_disagreement * 0.375)
        )
        uncertainty = 1.0 - min(1.0, row.top1_margin)
        diversity = min(1.0, max(0, len(families) - 1) / 2.0)
        role_value = 1.0 if specialist_role else (0.65 if ordinary_role else 0.45)
        rare_value = 1.0 if row.rare_raw_top3 else 0.0
        single_day_value = 1.0 if single_day_signal else 0.0
        chapter_outlier = 1.0 if bool(_nested(row.fast, "chapter_consistency", "outlier")) else 0.0
        row.info_score = round(
            0.23 * uncertainty
            + 0.18 * row.entropy
            + 0.19 * min(1.0, disagreement_score)
            + 0.14 * diversity
            + 0.11 * role_value
            + 0.07 * rare_value
            + 0.05 * single_day_value
            + 0.03 * chapter_outlier,
            8,
        )
        row.focus_flags = tuple(flags)


def focus_quotas(count: int) -> dict[str, int]:
    raw = {focus: count * weight for focus, weight in FOCUS_WEIGHTS.items()}
    quotas = {focus: int(math.floor(value)) for focus, value in raw.items()}
    remainder = count - sum(quotas.values())
    order = sorted(raw, key=lambda focus: (-(raw[focus] - quotas[focus]), focus))
    for focus in order[:remainder]:
        quotas[focus] += 1
    return quotas


def _candidate_tie(row: FeatureRow, namespace: str) -> str:
    return sha256_bytes(f"{namespace}\0{row.sample_id}".encode("utf-8"))


def select_balanced_rows(rows: Sequence[FeatureRow], count: int) -> list[FeatureRow]:
    if len(rows) < count:
        raise HighValueQueueError(f"only {len(rows)} eligible pseudo rows remain for {count} slots")
    works = sorted({row.work_id for row in rows})
    chapters = {row.chapter_id for row in rows}
    max_work = max(
        1,
        math.ceil(count / max(1, len(works))) + max(1, math.ceil(count / 50)),
    )
    max_chapter = max(4, math.ceil(count / max(1, len(chapters))) + 5)
    max_page = 2
    quotas = focus_quotas(count)
    chosen: list[FeatureRow] = []
    chosen_ids: set[str] = set()
    work_counts: Counter[str] = Counter()
    chapter_counts: Counter[str] = Counter()
    page_counts: Counter[str] = Counter()

    def choose_for_focus(focus: str, needed: int) -> int:
        added = 0
        candidates = [row for row in rows if focus in row.focus_flags and row.sample_id not in chosen_ids]
        while added < needed:
            valid = [
                row for row in candidates
                if row.sample_id not in chosen_ids
                and work_counts[row.work_id] < max_work
                and chapter_counts[row.chapter_id] < max_chapter
                and page_counts[row.page_sha256] < max_page
            ]
            if not valid:
                break
            selected = min(
                valid,
                key=lambda row: (
                    work_counts[row.work_id] / max_work,
                    chapter_counts[row.chapter_id] / max_chapter,
                    page_counts[row.page_sha256] / max_page,
                    -row.info_score,
                    _candidate_tie(row, f"focus:{focus}"),
                ),
            )
            selected.primary_focus = focus
            chosen.append(selected)
            chosen_ids.add(selected.sample_id)
            work_counts[selected.work_id] += 1
            chapter_counts[selected.chapter_id] += 1
            page_counts[selected.page_sha256] += 1
            added += 1
        return added

    deficits = 0
    # Scarcer, user-critical Single Day strata are secured first.
    for focus in FOCUS_WEIGHTS:
        deficits += quotas[focus] - choose_for_focus(focus, quotas[focus])
    if deficits:
        fallback = sorted(
            (row for row in rows if row.sample_id not in chosen_ids),
            key=lambda row: (-row.info_score, _candidate_tie(row, "fallback")),
        )
        for row in fallback:
            if len(chosen) >= count:
                break
            if (
                work_counts[row.work_id] >= max_work
                or chapter_counts[row.chapter_id] >= max_chapter
                or page_counts[row.page_sha256] >= max_page
            ):
                continue
            row.primary_focus = max(
                row.focus_flags,
                key=lambda focus: (FOCUS_WEIGHTS.get(focus, 0.0), focus),
            )
            chosen.append(row)
            chosen_ids.add(row.sample_id)
            work_counts[row.work_id] += 1
            chapter_counts[row.chapter_id] += 1
            page_counts[row.page_sha256] += 1
    # Focus quotas can consume the per-work allowance asymmetrically even when
    # the corpus as a whole has enough balanced supply.  Fill any residual with
    # the smallest deterministic cap relaxation, always preferring the least
    # represented work/chapter/page.  The final report exposes the realised
    # maxima so this relaxation can never be silent.
    relaxed_work_cap = max_work
    relaxed_chapter_cap = max_chapter
    relaxed_page_cap = max_page
    while len(chosen) < count:
        valid = [
            row for row in rows
            if row.sample_id not in chosen_ids
            and work_counts[row.work_id] < relaxed_work_cap
            and chapter_counts[row.chapter_id] < relaxed_chapter_cap
            and page_counts[row.page_sha256] < relaxed_page_cap
        ]
        if not valid:
            relaxed_work_cap += max(1, math.ceil(count / 100))
            relaxed_chapter_cap += 1
            if relaxed_work_cap > count and relaxed_chapter_cap > count:
                relaxed_page_cap += 1
            if relaxed_page_cap > count:
                break
            continue
        row = min(
            valid,
            key=lambda item: (
                work_counts[item.work_id] / relaxed_work_cap,
                chapter_counts[item.chapter_id] / relaxed_chapter_cap,
                page_counts[item.page_sha256] / relaxed_page_cap,
                -item.info_score,
                _candidate_tie(item, "relaxed-fallback"),
            ),
        )
        row.primary_focus = max(
            row.focus_flags,
            key=lambda focus: (FOCUS_WEIGHTS.get(focus, 0.0), focus),
        )
        chosen.append(row)
        chosen_ids.add(row.sample_id)
        work_counts[row.work_id] += 1
        chapter_counts[row.chapter_id] += 1
        page_counts[row.page_sha256] += 1
    if len(chosen) != count:
        raise HighValueQueueError(
            f"balanced constraints selected {len(chosen)}/{count}; supply is insufficient"
        )
    chosen.sort(
        key=lambda row: (
            list(FOCUS_WEIGHTS).index(str(row.primary_focus)),
            sha256_bytes(f"work\0{row.work_id}".encode("utf-8")),
            sha256_bytes(f"chapter\0{row.chapter_id}".encode("utf-8")),
            -row.info_score,
            _candidate_tie(row, "review-order"),
        )
    )
    return chosen


def choose_seven_candidates(row: FeatureRow, active_candidates: Sequence[str]) -> tuple[str, ...]:
    """Build a diverse seven-font search panel and obscure its evidence order."""

    ranked = list(row.raw_top[:3]) + list(row.refined_top[:4])
    ranked.extend(value for value in (row.direct_top1, row.raw_ranker_top1, _chapter_majority(row.fast)) if value)
    if row.primary_focus in {
        "single_day_ordinary_hard_negative",
        "single_day_specialist_positive",
    }:
        ranked.insert(0, "single-day")
    probabilities = dict(zip(row.candidate_ids, row.probabilities, strict=True))
    probability_order = sorted(active_candidates, key=lambda candidate: (-probabilities[candidate], candidate))

    chosen: list[str] = []
    for candidate in ranked:
        if candidate in active_candidates and candidate not in chosen:
            chosen.append(candidate)
        if len(chosen) == PANEL_SIZE:
            break

    # Force body/specialist contrast because this queue exists to improve exact
    # visual matching, not merely confirm a collapsed top-k neighborhood.
    required_families = (
        ("body-sans", "body-serif", "display", "handwritten")
        if row.role in {"dialogue", "narration", "thought"}
        else ("display", "handwritten", "brush", "body-sans")
    )
    for family in required_families:
        if any(FONT_FAMILY_BY_ID[candidate] == family for candidate in chosen):
            continue
        replacement = next(
            (candidate for candidate in probability_order if FONT_FAMILY_BY_ID[candidate] == family and candidate not in chosen),
            None,
        )
        if replacement is None:
            continue
        if len(chosen) < PANEL_SIZE:
            chosen.append(replacement)
        else:
            replaceable = next(
                (
                    index for index in range(len(chosen) - 1, -1, -1)
                    if sum(FONT_FAMILY_BY_ID[item] == FONT_FAMILY_BY_ID[chosen[index]] for item in chosen) > 1
                    and chosen[index] not in {row.direct_top1, row.raw_ranker_top1, row.refined_top[0]}
                ),
                len(chosen) - 1,
            )
            chosen[replaceable] = replacement
    for candidate in probability_order:
        if candidate not in chosen:
            chosen.append(candidate)
        if len(chosen) == PANEL_SIZE:
            break
    if len(chosen) != PANEL_SIZE or len(set(chosen)) != PANEL_SIZE:
        raise HighValueQueueError(f"{row.sample_id}: could not construct seven unique candidates")
    return tuple(
        sorted(
            chosen,
            key=lambda candidate: sha256_bytes(
                f"opaque-seven-v1\0{row.sample_id}\0{candidate}".encode("utf-8")
            ),
        )
    )


def _render_index(
    snapshot: catalog_assets.RenderBankSnapshot,
) -> dict[tuple[str, str, str], Mapping[str, Any]]:
    result: dict[tuple[str, str, str], Mapping[str, Any]] = {}
    for evidence in snapshot.prototype_evidence:
        key = (
            str(evidence["font_id"]),
            str(evidence["probe_id"]),
            str(evidence["writing_mode"]),
        )
        if key in result:
            raise HighValueQueueError(f"duplicate render prototype: {key}")
        result[key] = evidence
    return result


def _choose_render(
    index: Mapping[tuple[str, str, str], Mapping[str, Any]],
    candidate_id: str,
    probe_id: str,
    orientation: str,
) -> Mapping[str, Any]:
    evidence = (
        index.get((candidate_id, probe_id, orientation))
        or index.get((candidate_id, probe_id, "horizontal"))
        or index.get((candidate_id, probe_id, "vertical"))
    )
    if evidence is None:
        raise HighValueQueueError(
            f"missing render prototype for {candidate_id}/{probe_id}/{orientation}"
        )
    return evidence


def _token(namespace: str, value: str) -> str:
    return sha256_bytes(f"{namespace}\0{value}".encode("utf-8"))[:16]


def prepare_records(
    rows: Sequence[FeatureRow],
    *,
    active_candidates: Sequence[str],
    render_index: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    public_rows: list[dict[str, Any]] = []
    private_rows: list[dict[str, Any]] = []
    for review_order, row in enumerate(rows, 1):
        candidate_ids = choose_seven_candidates(row, active_candidates)
        probe_id = PROBE_BY_ROLE.get(row.role, "emphasis-shout")
        review_id = f"hv-review-{sha256_bytes(f'hv-review-v1\0{row.sample_id}'.encode())[:24]}"
        binding_id = f"hv-bind-{sha256_bytes(f'hv-bind-v1\0{row.sample_id}'.encode())[:24]}"
        public_slots = [chr(ord("A") + index) for index in range(PANEL_SIZE)]
        private_slots: list[dict[str, Any]] = []
        probability_by_id = dict(zip(row.candidate_ids, row.probabilities, strict=True))
        for slot, candidate_id in zip(public_slots, candidate_ids, strict=True):
            render = _choose_render(render_index, candidate_id, probe_id, row.orientation)
            private_slots.append(
                {
                    "candidate_id": candidate_id,
                    "family": FONT_FAMILY_BY_ID[candidate_id],
                    "model_probability_for_sampling_audit_only": round(
                        probability_by_id[candidate_id], 10
                    ),
                    "render_artifact_sha256": render["artifact_sha256"],
                    "render_id": render["render_id"],
                    "slot": slot,
                    "source_font_sha256": render["source_font_sha256"],
                }
            )
        master_core = {
            key: value for key, value in row.master.items() if key != "record_sha256"
        }
        source_identity = {
            "master_row_sha256": sha256_bytes(canonical_json(master_core).encode("utf-8")),
            "sample_crop_sha256": row.master.get("sample_crop_sha256"),
            "sample_id": row.sample_id,
            "source_page_sha256": row.page_sha256,
        }
        public_rows.append(
            {
                "authority": {
                    "automatic_label_promotion_allowed": False,
                    "candidate_search_complete": False,
                    "label_authority": "none_pending_blind_review",
                    "model_scores_visible": False,
                    "training_eligible": False,
                },
                "binding_id": binding_id,
                "chapter_token": _token("chapter", row.chapter_id),
                "orientation": row.orientation,
                "page_token": _token("page", row.page_sha256),
                "record_type": RECORD_TYPE,
                "review_id": review_id,
                "review_order": review_order,
                "role_sampling_hint": {
                    "must_be_human_verified": True,
                    "role": row.role,
                    "source": "layout_probe_for_review_navigation_not_label_authority",
                },
                "sample_id": row.sample_id,
                "schema_version": SCHEMA_VERSION,
                "sheet": None,
                "slots": public_slots,
                "source": {
                    "geometry": copy.deepcopy(row.master.get("geometry")),
                    "views": copy.deepcopy(row.master.get("views")),
                },
                "source_identity_sha256": sha256_bytes(
                    canonical_json(source_identity).encode("utf-8")
                ),
                "split": "train",
                "work_token": _token("work", row.work_id),
            }
        )
        private_rows.append(
            seal_record(
                {
                    "authority": {
                        "automatic_label_promotion_allowed": False,
                        "candidate_search_complete": False,
                        "label_authority": "pseudo_sampling_evidence_not_gold",
                        "training_eligible": False,
                    },
                    "binding_id": binding_id,
                    "candidate_slots": private_slots,
                    "chapter": copy.deepcopy(row.master.get("chapter")),
                    "information_sampling": {
                        "all_focus_flags": list(row.focus_flags),
                        "direct_top1_font_id": row.direct_top1,
                        "entropy": round(row.entropy, 8),
                        "info_score": row.info_score,
                        "model_disagreement": row.model_disagreement,
                        "primary_focus": row.primary_focus,
                        "raw_ranker_top1_font_id": row.raw_ranker_top1,
                        "raw_top3_font_ids": list(row.raw_top[:3]),
                        "refined_top3_font_ids": list(row.refined_top[:3]),
                        "role_hint": row.role,
                        "source_category": row.source_category,
                        "top1_margin": round(row.top1_margin, 8),
                        "view_disagreement": round(row.view_disagreement, 8),
                    },
                    "legacy_contact_sheet_binding": copy.deepcopy(row.legacy_sheet),
                    "master_row_sha256": source_identity["master_row_sha256"],
                    "page": copy.deepcopy(row.master.get("page")),
                    "pseudo_record_sha256": row.pseudo.get("record_sha256"),
                    "record_type": PRIVATE_RECORD_TYPE,
                    "review_id": review_id,
                    "sample_id": row.sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "work": copy.deepcopy(row.master.get("work")),
                }
            )
        )
    return public_rows, private_rows


def validate_public_row(row: Mapping[str, Any], candidate_ids: Sequence[str]) -> None:
    validate_record_seal(row, location="public review row")
    if row.get("schema_version") != SCHEMA_VERSION or row.get("record_type") != RECORD_TYPE:
        raise HighValueQueueError("public review schema drift")
    if row.get("split") != "train":
        raise HighValueQueueError("public review split drift")
    authority = _mapping(row.get("authority"), "public authority")
    if authority != {
        "automatic_label_promotion_allowed": False,
        "candidate_search_complete": False,
        "label_authority": "none_pending_blind_review",
        "model_scores_visible": False,
        "training_eligible": False,
    }:
        raise HighValueQueueError("public row elevated pending authority")
    if list(_sequence(row.get("slots"), "public slots")) != list("ABCDEFG"):
        raise HighValueQueueError("public seven-slot contract drift")
    sheet = _mapping(row.get("sheet"), "public sheet")
    if set(sheet) != {"file", "row_index", "sha256"}:
        raise HighValueQueueError("public sheet binding drift")
    public_text = canonical_json(row).lower()
    forbidden_keys = {
        "candidate_id",
        "font_id",
        "font_name",
        "font_probability",
        "information_sampling",
        "model_probability",
        "prediction",
        "primary_focus",
        "raw_top",
        "refined_top",
        "top1_margin",
    }
    if any(f'"{key}"' in public_text for key in forbidden_keys):
        raise HighValueQueueError("public review row leaks model/candidate fields")
    if any(candidate.lower() in public_text for candidate in candidate_ids):
        raise HighValueQueueError("public review row leaks a candidate identity")


def _font(size: int, path: Path | None) -> ImageFont.ImageFont:
    if path is not None:
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            pass
    return ImageFont.load_default(size=max(10, size))


def _fit_paste(
    canvas: Image.Image, source: Image.Image, box: tuple[int, int, int, int]
) -> None:
    left, top, right, bottom = box
    fitted = ImageOps.contain(
        source.convert("RGB"),
        (max(1, right - left), max(1, bottom - top)),
        Image.Resampling.LANCZOS,
    )
    canvas.paste(
        fitted,
        (
            left + (right - left - fitted.width) // 2,
            top + (bottom - top - fitted.height) // 2,
        ),
    )
    fitted.close()


def render_contact_sheets(
    public_rows: list[dict[str, Any]],
    private_rows: Sequence[Mapping[str, Any]],
    *,
    output_dir: Path,
    resolver: catalog_assets.CatalogAssetResolver,
    render_snapshot: catalog_assets.RenderBankSnapshot,
    rows_per_sheet: int,
    annotation_font: Path | None,
) -> list[dict[str, Any]]:
    if not 1 <= rows_per_sheet <= 12:
        raise HighValueQueueError("rows_per_sheet must be inside [1,12]")
    private_by_sample = {str(row["sample_id"]): row for row in private_rows}
    render_cache: dict[str, Image.Image] = {}
    header_font = _font(25, annotation_font)
    body_font = _font(16, annotation_font)
    small_font = _font(14, annotation_font)
    source_width = 430
    candidate_width = 168
    row_height = 286
    header_height = 78
    width = source_width + candidate_width * PANEL_SIZE
    sheet_dir = output_dir / SHEETS_DIR
    sheet_dir.mkdir(parents=True)
    descriptors: list[dict[str, Any]] = []
    try:
        for sheet_number, start in enumerate(range(0, len(public_rows), rows_per_sheet), 1):
            chunk = public_rows[start : start + rows_per_sheet]
            height = header_height + row_height * len(chunk)
            canvas = Image.new("RGB", (width, height), (246, 247, 249))
            draw = ImageDraw.Draw(canvas)
            draw.text(
                (16, 10),
                "BLIND-FIRST HIGH-VALUE FONT REVIEW — 7 OPAQUE CANDIDATES",
                fill=(20, 24, 31),
                font=header_font,
            )
            draw.text(
                (16, 43),
                "Match Japanese glyph shape to Korean render. Candidate names, scores and rank are hidden.",
                fill=(155, 38, 38),
                font=body_font,
            )
            for local_index, row in enumerate(chunk):
                top = header_height + local_index * row_height
                bottom = top + row_height
                draw.rectangle((0, top, width - 1, bottom - 1), outline=(188, 192, 199), width=2)
                role = _nested(row, "role_sampling_hint", "role")
                draw.text(
                    (10, top + 7),
                    f"{start + local_index + 1:04d}  …{str(row['sample_id'])[-14:]}  role hint={role} (verify)",
                    fill=(25, 28, 34),
                    font=small_font,
                )
                views: dict[str, Image.Image] = {}
                for view_name in VIEW_NAMES:
                    with resolver.resolve_view_descriptor(
                        row["source"]["views"][view_name],
                        sample_id=str(row["sample_id"]),
                        view_name=view_name,
                        location=f"{row['sample_id']}.{view_name}",
                    ) as resolved:
                        views[view_name] = resolved.image.copy()
                _fit_paste(canvas, views["raw_224"], (10, top + 37, 216, bottom - 9))
                _fit_paste(canvas, views["context_224"], (224, top + 37, 420, top + 154))
                _fit_paste(canvas, views["glyph_224"], (224, top + 159, 420, bottom - 9))
                for image in views.values():
                    image.close()
                private = private_by_sample[str(row["sample_id"])]
                for candidate_index, raw_binding in enumerate(
                    _sequence(private.get("candidate_slots"), "private candidate slots")
                ):
                    binding = _mapping(raw_binding, "private candidate slot")
                    slot = str(binding["slot"])
                    render_id = str(binding["render_id"])
                    left = source_width + candidate_index * candidate_width
                    draw.rectangle(
                        (left + 4, top + 5, left + candidate_width - 5, bottom - 6),
                        fill=(255, 255, 255),
                        outline=(84, 101, 122),
                        width=2,
                    )
                    draw.text((left + 11, top + 13), slot, fill=(20, 23, 28), font=body_font)
                    render_image = render_cache.get(render_id)
                    if render_image is None:
                        with render_snapshot.resolve_prototype(render_id) as resolved:
                            render_image = resolved.image.copy()
                        render_cache[render_id] = render_image
                    _fit_paste(
                        canvas,
                        render_image,
                        (left + 9, top + 43, left + candidate_width - 10, bottom - 16),
                    )
            relative = f"{SHEETS_DIR}/sheet-{sheet_number:03d}.png"
            path = output_dir.joinpath(*PurePosixPath(relative).parts)
            canvas.save(path, format="PNG", optimize=False, compress_level=9)
            canvas.close()
            sheet_sha = sha256_file(path)
            descriptor = {
                "file": relative,
                "height": height,
                "row_count": len(chunk),
                "sha256": sheet_sha,
                "width": width,
            }
            descriptors.append(descriptor)
            for local_index, row in enumerate(chunk):
                row["sheet"] = {
                    "file": relative,
                    "row_index": local_index,
                    "sha256": sheet_sha,
                }
    finally:
        for image in render_cache.values():
            image.close()
    return descriptors


def _decision_template(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "authority": {
            "automatic_label_promotion_allowed": False,
            "candidate_search_complete": False,
            "training_eligible": False,
        },
        "acceptable_slots": [],
        "candidate_search_complete": False,
        "crop_quality": "pending",
        "decision_status": "pending",
        "font_match_confidence": None,
        "marginal_slots": [],
        "none_acceptable": None,
        "notes": "",
        "preferred_slots": [],
        "record_type": "manga_font_v2_high_value_blind_decision",
        "review_complete": False,
        "review_id": row["review_id"],
        "review_item_sha256": row["record_sha256"],
        "reviewed_at": None,
        "reviewer": None,
        "sample_id": row["sample_id"],
        "schema_version": DECISION_SCHEMA_VERSION,
        "unacceptable_slots": [],
        "unrenderable_slots": [],
        "verified_role": None,
    }


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _load_pseudo_index(path: Path) -> tuple[dict[str, Mapping[str, Any]], Mapping[str, Any]]:
    index: dict[str, Mapping[str, Any]] = {}
    row_count = 0
    for row in _iter_jsonl(path, "refined pseudo targets"):
        row_count += 1
        validate_record_seal(row, location=f"pseudo:{row_count}")
        sample_id = _text(row.get("sample_id"), f"pseudo:{row_count}.sample_id")
        if row.get("training_eligible") is not False or row.get("label_authority") not in {
            "pseudo_soft_not_gold",
            "pseudo_not_gold",
        }:
            raise HighValueQueueError(f"{sample_id}: pseudo authority drift")
        if sample_id in index:
            raise HighValueQueueError(f"duplicate refined pseudo sample: {sample_id}")
        index[sample_id] = row
    return index, {
        "file": str(path.resolve()),
        "row_count": row_count,
        "sha256": sha256_file(path),
    }


def _compact_fast_review(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "candidates": copy.deepcopy(row.get("candidates")),
        "chapter_consistency": copy.deepcopy(row.get("chapter_consistency")),
        "pass_summaries": copy.deepcopy(row.get("pass_summaries")),
        "priority": copy.deepcopy(row.get("priority")),
        "role_probe": copy.deepcopy(row.get("role_probe")),
        "sheet": copy.deepcopy(row.get("sheet")),
    }


def _load_fast_review_index(
    root: Path, allowed_ids: set[str]
) -> tuple[dict[str, Mapping[str, Any]], list[Mapping[str, Any]]]:
    files = sorted(root.resolve().glob("batches/*/review-items.jsonl"), key=lambda path: path.as_posix())
    if not files:
        raise HighValueQueueError(f"fast review root has no review-items.jsonl: {root}")
    index: dict[str, Mapping[str, Any]] = {}
    descriptors: list[Mapping[str, Any]] = []
    for path in files:
        rows = 0
        retained = 0
        for row in _iter_jsonl(path, f"fast review[{path.parent.name}]"):
            rows += 1
            sample_id = row.get("sample_id")
            if not isinstance(sample_id, str) or sample_id not in allowed_ids:
                continue
            if sample_id in index:
                raise HighValueQueueError(f"duplicate fast review sample: {sample_id}")
            index[sample_id] = _compact_fast_review(row)
            retained += 1
        descriptors.append(
            {
                "file": str(path),
                "retained_rows": retained,
                "row_count": rows,
                "sha256": sha256_file(path),
            }
        )
    return index, descriptors


def _load_legacy_sheet_index(
    path: Path, allowed_ids: set[str]
) -> tuple[dict[str, Mapping[str, Any]], Mapping[str, Any]]:
    index: dict[str, Mapping[str, Any]] = {}
    duplicate_rows = 0
    row_count = 0
    for row in _iter_jsonl(path, "legacy contact-sheet index"):
        row_count += 1
        sample_id = row.get("sample_id")
        if not isinstance(sample_id, str) or sample_id not in allowed_ids:
            continue
        binding = row.get("sheet")
        if not isinstance(binding, Mapping):
            continue
        if sample_id in index:
            duplicate_rows += 1
            continue
        index[sample_id] = {
            "cell": binding.get("cell"),
            "file": binding.get("file"),
            "index_artifact_root": str(path.resolve().parent),
            "index_record_sha256": row.get("record_sha256"),
        }
    return index, {
        "duplicate_rows_ignored": duplicate_rows,
        "file": str(path.resolve()),
        "retained_rows": len(index),
        "row_count": row_count,
        "sha256": sha256_file(path),
    }


def _master_is_labeled(row: Mapping[str, Any]) -> bool:
    status = row.get("label_status")
    return row.get("font_label") is not None or (
        isinstance(status, str) and status not in {"", "unlabeled", "none"}
    )


def load_feature_rows(
    *,
    master_manifest: Path,
    pseudo_targets: Path,
    fast_review_root: Path,
    legacy_contact_index: Path,
    inventory: ExclusionInventory,
) -> tuple[list[FeatureRow], Mapping[str, Any], Mapping[str, Any]]:
    pseudo_index, pseudo_descriptor = _load_pseudo_index(pseudo_targets.resolve())
    allowed_ids = set(pseudo_index)
    fast_index, fast_descriptors = _load_fast_review_index(fast_review_root, allowed_ids)
    legacy_index, legacy_descriptor = _load_legacy_sheet_index(
        legacy_contact_index.resolve(), allowed_ids
    )
    counts: Counter[str] = Counter()
    overlap_counts: Counter[str] = Counter()
    features: list[FeatureRow] = []
    master_ids: set[str] = set()
    for row_number, row in enumerate(_iter_jsonl(master_manifest.resolve(), "master manifest"), 1):
        counts["master_rows"] += 1
        sample_id = _text(row.get("id"), f"master:{row_number}.id")
        if sample_id in master_ids:
            raise HighValueQueueError(f"duplicate master sample: {sample_id}")
        master_ids.add(sample_id)
        page_sha = _text(_nested(row, "page", "source_page_sha256"), f"master:{row_number}.page_sha")
        if sample_id in inventory.reviewed_ids:
            overlap_counts["prior_human_or_agent_review"] += 1
        if sample_id in inventory.val33_ids:
            overlap_counts["adjudicated_val33"] += 1
        if sample_id in inventory.blind_pool_ids:
            overlap_counts["blind_calibration_eval_pool"] += 1
        if page_sha in inventory.qa_page_sha256:
            overlap_counts["library_qa_page"] += 1
        if row.get("split") != "train":
            counts["excluded_non_train"] += 1
            continue
        if _master_is_labeled(row):
            counts["excluded_master_labeled"] += 1
            continue
        if sample_id in inventory.all_sample_ids:
            counts["excluded_prior_review"] += 1
            continue
        if page_sha in inventory.qa_page_sha256:
            counts["excluded_library_qa_page"] += 1
            continue
        pseudo = pseudo_index.get(sample_id)
        if pseudo is None:
            counts["excluded_without_refined_pseudo"] += 1
            continue
        if pseudo.get("split") != "train":
            raise HighValueQueueError(f"{sample_id}: refined pseudo split is not train")
        feature = build_feature(
            row,
            pseudo,
            fast_index.get(sample_id),
            legacy_index.get(sample_id),
        )
        features.append(feature)
        counts["eligible_unseen_train_pseudo"] += 1
    unknown_pseudo = set(pseudo_index) - master_ids
    if unknown_pseudo:
        raise HighValueQueueError(f"{len(unknown_pseudo)} pseudo samples are absent from master")
    annotate_information_features(features)
    input_bindings = {
        "fast_review": fast_descriptors,
        "legacy_contact_index": legacy_descriptor,
        "master_manifest": {
            "file": str(master_manifest.resolve()),
            "row_count": counts["master_rows"],
            "sha256": sha256_file(master_manifest),
        },
        "refined_pseudo_targets": pseudo_descriptor,
    }
    audit = {
        "exclusion_overlap_in_master": dict(sorted(overlap_counts.items())),
        "filter_counts": dict(sorted(counts.items())),
        "fast_model_evidence_coverage": len(set(fast_index) & {row.sample_id for row in features}),
        "legacy_contact_sheet_coverage": len(set(legacy_index) & {row.sample_id for row in features}),
    }
    return features, input_bindings, audit


def _distribution(rows: Sequence[FeatureRow], *, selected: bool) -> Mapping[str, Any]:
    top1 = Counter(row.refined_top[0] for row in rows)
    roles = Counter(row.role for row in rows)
    categories = Counter(row.source_category for row in rows)
    focus_availability = Counter(
        focus for row in rows for focus in row.focus_flags
    )
    result: dict[str, Any] = {
        "chapters": len({row.chapter_id for row in rows}),
        "focus_signal_rows": dict(sorted(focus_availability.items())),
        "refined_top1_fonts": dict(sorted(top1.items())),
        "roles": dict(sorted(roles.items())),
        "rows": len(rows),
        "source_categories": dict(sorted(categories.items())),
        "works": len({row.work_id for row in rows}),
    }
    if selected:
        work_counts = Counter(row.work_id for row in rows)
        chapter_counts = Counter(row.chapter_id for row in rows)
        page_counts = Counter(row.page_sha256 for row in rows)
        result.update(
            {
                "legacy_contact_sheet_bindings_reused": sum(
                    row.legacy_sheet is not None for row in rows
                ),
                "max_rows_per_chapter": max(chapter_counts.values(), default=0),
                "max_rows_per_page": max(page_counts.values(), default=0),
                "max_rows_per_work": max(work_counts.values(), default=0),
                "min_rows_per_work": min(work_counts.values(), default=0),
                "model_disagreement_rows": sum(row.model_disagreement for row in rows),
                "primary_focus": dict(
                    sorted(Counter(str(row.primary_focus) for row in rows).items())
                ),
                "raw_top3_family_diverse_rows": sum(
                    len(
                        {
                            FONT_FAMILY_BY_ID[candidate]
                            for candidate in (row.raw_top[:3] or row.refined_top[:3])
                        }
                    )
                    >= 2
                    for row in rows
                ),
                "single_day_in_raw_or_refined_top5_rows": sum(
                    "single-day" in set(row.raw_top[:5] or row.refined_top[:5])
                    or "single-day" in row.refined_top[:5]
                    for row in rows
                ),
            }
        )
    return result


def validate_bundle(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    if not root.is_dir() or root.is_symlink():
        raise HighValueQueueError(f"queue directory is missing or linked: {root}")
    marker = _read_json(root / MARKER_FILE, "ownership marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise HighValueQueueError("ownership marker drift")
    report_path = root / REPORT_FILE
    if marker.get("report_sha256") != sha256_file(report_path):
        raise HighValueQueueError("ownership marker report hash drift")
    report = _read_json(report_path, "queue report")
    validate_record_seal(report, location="queue report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != REPORT_RECORD_TYPE
    ):
        raise HighValueQueueError("queue report schema drift")
    candidate_ids = tuple(
        str(value) for value in _sequence(report.get("candidate_ids"), "report candidates")
    )
    if len(candidate_ids) != 21 or set(candidate_ids) != set(FONT_FAMILY_BY_ID):
        raise HighValueQueueError("report active candidates drift")
    selected_count = int(_nested(report, "counts", "selected", "rows") or 0)
    if not MIN_PRODUCTION_ROWS <= selected_count <= MAX_PRODUCTION_ROWS:
        raise HighValueQueueError("production queue count is outside [800,1200]")
    artifacts = _mapping(report.get("artifacts"), "report artifacts")
    expected_files = {QUEUE_FILE, PRIVATE_FILE, DECISIONS_FILE}
    if set(artifacts) != expected_files:
        raise HighValueQueueError("report artifact inventory drift")
    loaded: dict[str, list[dict[str, Any]]] = {}
    for name in sorted(expected_files):
        descriptor = _mapping(artifacts[name], f"artifact[{name}]")
        if descriptor.get("file") != name:
            raise HighValueQueueError(f"artifact file drift: {name}")
        path = root / name
        if descriptor.get("sha256") != sha256_file(path) or descriptor.get("byte_size") != path.stat().st_size:
            raise HighValueQueueError(f"artifact hash/size drift: {name}")
        rows = list(_iter_jsonl(path, f"artifact[{name}]"))
        if descriptor.get("row_count") != len(rows) or len(rows) != selected_count:
            raise HighValueQueueError(f"artifact row count drift: {name}")
        loaded[name] = rows

    public_rows = loaded[QUEUE_FILE]
    private_rows = loaded[PRIVATE_FILE]
    decision_rows = loaded[DECISIONS_FILE]
    public_by_id: dict[str, Mapping[str, Any]] = {}
    private_by_id: dict[str, Mapping[str, Any]] = {}
    for row in public_rows:
        validate_public_row(row, candidate_ids)
        sample_id = _text(row.get("sample_id"), "public.sample_id")
        if sample_id in public_by_id:
            raise HighValueQueueError(f"duplicate public sample: {sample_id}")
        public_by_id[sample_id] = row
    for row in private_rows:
        validate_record_seal(row, location="private binding")
        if row.get("schema_version") != SCHEMA_VERSION or row.get("record_type") != PRIVATE_RECORD_TYPE:
            raise HighValueQueueError("private binding schema drift")
        authority = _mapping(row.get("authority"), "private authority")
        if authority != {
            "automatic_label_promotion_allowed": False,
            "candidate_search_complete": False,
            "label_authority": "pseudo_sampling_evidence_not_gold",
            "training_eligible": False,
        }:
            raise HighValueQueueError("private binding elevated pseudo authority")
        sample_id = _text(row.get("sample_id"), "private.sample_id")
        if sample_id in private_by_id:
            raise HighValueQueueError(f"duplicate private sample: {sample_id}")
        slots = [_mapping(value, "private slot") for value in _sequence(row.get("candidate_slots"), "candidate slots")]
        if (
            len(slots) != PANEL_SIZE
            or [slot.get("slot") for slot in slots] != list("ABCDEFG")
            or len({slot.get("candidate_id") for slot in slots}) != PANEL_SIZE
            or any(slot.get("candidate_id") not in candidate_ids for slot in slots)
        ):
            raise HighValueQueueError("private seven-candidate partition drift")
        if any(
            not isinstance(slot.get("render_artifact_sha256"), str)
            or SHA_RE.fullmatch(str(slot.get("render_artifact_sha256"))) is None
            for slot in slots
        ):
            raise HighValueQueueError("private render binding hash drift")
        private_by_id[sample_id] = row
    if set(public_by_id) != set(private_by_id):
        raise HighValueQueueError("public/private sample partition drift")
    for sample_id, public in public_by_id.items():
        private = private_by_id[sample_id]
        if (
            public.get("binding_id") != private.get("binding_id")
            or public.get("review_id") != private.get("review_id")
        ):
            raise HighValueQueueError(f"{sample_id}: public/private binding drift")

    decision_ids: set[str] = set()
    for row in decision_rows:
        if (
            row.get("schema_version") != DECISION_SCHEMA_VERSION
            or row.get("record_type") != "manga_font_v2_high_value_blind_decision"
            or row.get("decision_status") != "pending"
            or row.get("review_complete") is not False
            or row.get("candidate_search_complete") is not False
            or row.get("preferred_slots") != []
            or row.get("acceptable_slots") != []
            or row.get("marginal_slots") != []
            or row.get("unacceptable_slots") != []
        ):
            raise HighValueQueueError("decision template is not pristine/pending")
        authority = _mapping(row.get("authority"), "decision authority")
        if authority != {
            "automatic_label_promotion_allowed": False,
            "candidate_search_complete": False,
            "training_eligible": False,
        }:
            raise HighValueQueueError("decision template elevated authority")
        sample_id = _text(row.get("sample_id"), "decision.sample_id")
        public = public_by_id.get(sample_id)
        if public is None or row.get("review_item_sha256") != public.get("record_sha256"):
            raise HighValueQueueError("decision/public binding drift")
        decision_ids.add(sample_id)
    if decision_ids != set(public_by_id):
        raise HighValueQueueError("decision sample partition drift")

    sheets = _sequence(report.get("sheets"), "report sheets")
    bound_sheet_rows = 0
    for raw_sheet in sheets:
        sheet = _mapping(raw_sheet, "sheet")
        relative = _safe_relative(sheet.get("file"), "sheet.file")
        path = _inside(root, relative, "sheet.file")
        if not path.is_file() or path.is_symlink() or sheet.get("sha256") != sha256_file(path):
            raise HighValueQueueError("sheet file/hash drift")
        try:
            with Image.open(path) as image:
                image.load()
                if list(image.size) != [sheet.get("width"), sheet.get("height")]:
                    raise HighValueQueueError("sheet pixel dimension drift")
        except OSError as error:
            raise HighValueQueueError(f"sheet decode failed: {relative}") from error
        bound_sheet_rows += int(sheet.get("row_count", 0))
    if bound_sheet_rows != selected_count:
        raise HighValueQueueError("sheet row coverage drift")
    for row in public_rows:
        sheet = _mapping(row.get("sheet"), "public sheet")
        relative = _safe_relative(sheet.get("file"), "public sheet.file")
        path = _inside(root, relative, "public sheet.file")
        if sheet.get("sha256") != sha256_file(path):
            raise HighValueQueueError("public sheet binding hash drift")

    boundary = _mapping(report.get("boundary"), "report boundary")
    zero_fields = (
        "selected_adjudicated_val33_overlap",
        "selected_blind_calibration_eval_overlap",
        "selected_library_qa_page_overlap",
        "selected_prior_human_agent_review_overlap",
        "selected_non_train_rows",
        "automatic_label_promotions",
    )
    if any(boundary.get(field) != 0 for field in zero_fields):
        raise HighValueQueueError("selection boundary reports leakage/elevation")
    label_contract = _mapping(report.get("label_contract"), "label contract")
    if (
        label_contract.get("candidates_per_first_pass_panel") != PANEL_SIZE
        or label_contract.get("candidate_search_complete") is not False
        or label_contract.get("pending_rows_are_training_eligible") is not False
        or label_contract.get("human_adjudication_required") is not True
        or label_contract.get("model_labels_promoted_to_human") != 0
    ):
        raise HighValueQueueError("label contract drift")
    return {
        "output_dir": str(root),
        "record_count": selected_count,
        "sheet_count": len(sheets),
        "status": "ready_for_blind_first_pass_human_review_not_training",
    }


def build_bundle(
    *,
    master_manifest: Path,
    pseudo_targets: Path,
    fast_review_root: Path,
    legacy_contact_index: Path,
    artifacts_root: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    active_catalog: Path,
    output_dir: Path,
    project_root: Path,
    rows_per_sheet: int,
    count: int,
    extra_exclusion_files: Sequence[Path],
    qa_roots: Sequence[Path],
    replace_owned_output: bool,
) -> dict[str, Any]:
    if not MIN_PRODUCTION_ROWS <= count <= MAX_PRODUCTION_ROWS:
        raise HighValueQueueError("count must be inside [800,1200]")
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise HighValueQueueError("output exists; pass --replace-owned-output")
        validate_bundle(target)
    inventory = load_exclusion_inventory(
        artifacts_root,
        extra_exclusion_files=extra_exclusion_files,
        qa_roots=qa_roots,
    )
    features, input_bindings, audit = load_feature_rows(
        master_manifest=master_manifest,
        pseudo_targets=pseudo_targets,
        fast_review_root=fast_review_root,
        legacy_contact_index=legacy_contact_index,
        inventory=inventory,
    )
    selected = select_balanced_rows(features, count)
    active_candidates = _active_candidates(active_catalog.resolve())
    render_snapshot = catalog_assets.load_render_bank(render_bank_manifest.resolve())
    if set(active_candidates) != set(render_snapshot.candidate_ids):
        raise HighValueQueueError("active catalog/render-bank candidates differ")
    render_index = _render_index(render_snapshot)
    public_rows, private_rows = prepare_records(
        selected,
        active_candidates=active_candidates,
        render_index=render_index,
    )
    resolver = catalog_assets.CatalogAssetResolver(catalog_registry.resolve())
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    try:
        annotation_font = project_root / "src/renderer/src/assets/fonts/nanum-gothic-regular.ttf"
        sheets = render_contact_sheets(
            public_rows,
            private_rows,
            output_dir=staging,
            resolver=resolver,
            render_snapshot=render_snapshot,
            rows_per_sheet=rows_per_sheet,
            annotation_font=annotation_font if annotation_font.is_file() else None,
        )
        sealed_public = [seal_record(row) for row in public_rows]
        for row in sealed_public:
            validate_public_row(row, active_candidates)
        decisions = [_decision_template(row) for row in sealed_public]
        _write_jsonl(staging / QUEUE_FILE, sealed_public)
        _write_jsonl(staging / PRIVATE_FILE, private_rows)
        _write_jsonl(staging / DECISIONS_FILE, decisions)
        selected_ids = {row.sample_id for row in selected}
        selected_pages = {row.page_sha256 for row in selected}
        report = seal_record(
            {
                "artifacts": {
                    name: _descriptor(staging / name, row_count=count)
                    for name in (QUEUE_FILE, PRIVATE_FILE, DECISIONS_FILE)
                },
                "boundary": {
                    "automatic_label_promotions": 0,
                    "selected_adjudicated_val33_overlap": len(selected_ids & inventory.val33_ids),
                    "selected_blind_calibration_eval_overlap": len(selected_ids & inventory.blind_pool_ids),
                    "selected_library_qa_page_overlap": len(selected_pages & inventory.qa_page_sha256),
                    "selected_non_train_rows": sum(row.master.get("split") != "train" for row in selected),
                    "selected_prior_human_agent_review_overlap": len(selected_ids & inventory.reviewed_ids),
                },
                "candidate_ids": list(active_candidates),
                "candidate_order_sha256": sha256_bytes(
                    ("\n".join(active_candidates) + "\n").encode("utf-8")
                ),
                "counts": {
                    "available": _distribution(features, selected=False),
                    "selected": _distribution(selected, selected=True),
                },
                "exclusion_audit": audit,
                "inputs": {
                    **input_bindings,
                    "active_catalog_sha256": sha256_file(active_catalog),
                    "catalog_registry_sha256": sha256_file(catalog_registry),
                    "excluded_sample_id_set_sha256": sha256_bytes(
                        ("\n".join(sorted(inventory.all_sample_ids)) + "\n").encode("utf-8")
                    ),
                    "excluded_source_page_set_sha256": sha256_bytes(
                        ("\n".join(sorted(inventory.qa_page_sha256)) + "\n").encode("utf-8")
                    ),
                    "exclusions": list(inventory.descriptors),
                    "render_bank_manifest_sha256": render_snapshot.manifest_sha256,
                    "render_bank_specification_sha256": render_snapshot.specification_sha256,
                },
                "label_contract": {
                    "candidate_search_complete": False,
                    "candidates_per_first_pass_panel": PANEL_SIZE,
                    "existing_224px_crop_assets_reused": True,
                    "existing_candidate_render_bank_reused": True,
                    "human_adjudication_required": True,
                    "model_labels_promoted_to_human": 0,
                    "new_candidate_font_renders_generated": 0,
                    "pending_rows_are_training_eligible": False,
                    "private_candidate_bindings_hidden_from_public_queue": True,
                    "second_full_catalog_search_required_when_none_acceptable": True,
                },
                "record_type": REPORT_RECORD_TYPE,
                "schema_version": SCHEMA_VERSION,
                "selection": {
                    "algorithm": "information-score-balanced-work-chapter-page-v1",
                    "focus_quota_targets": focus_quotas(count),
                    "selected_sample_order_sha256": sha256_bytes(
                        ("\n".join(row.sample_id for row in selected) + "\n").encode("utf-8")
                    ),
                },
                "sheets": sheets,
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
        validate_bundle(staging)
        if target.exists():
            validate_bundle(target)
            shutil.rmtree(target)
        os.replace(staging, target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return validate_bundle(target)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="Build the sealed 800-1200 row queue")
    build.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
    build.add_argument(
        "--pseudo-targets",
        type=Path,
        default=Path("artifacts/manga-font-v2-pseudo-refinement-r1/refined-pseudo-targets.jsonl"),
    )
    build.add_argument(
        "--fast-review-root",
        type=Path,
        default=Path("artifacts/manga-font-v7-active21-fast-review-r2-full28k-v1"),
    )
    build.add_argument(
        "--legacy-contact-index",
        type=Path,
        default=Path("artifacts/manga-font-pseudolabel-contact-sheets-full28k-v1/correction-index.jsonl"),
    )
    build.add_argument("--artifacts-root", type=Path, default=Path("artifacts"))
    build.add_argument(
        "--catalog-registry",
        type=Path,
        default=Path("datasets/font-matching-catalog-registry-v3.json"),
    )
    build.add_argument(
        "--render-bank-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v2/manifest.json"),
    )
    build.add_argument(
        "--active-catalog",
        type=Path,
        default=Path("artifacts/font-matching-runtime-active21-r5-e1-release-v1/auto-match-active-catalog.json"),
    )
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--project-root", type=Path, default=Path("."))
    build.add_argument("--rows-per-sheet", type=int, default=10)
    build.add_argument("--count", type=int, default=800)
    build.add_argument("--extra-exclusion-jsonl", type=Path, action="append", default=[])
    build.add_argument("--qa-root", type=Path, action="append", default=[])
    build.add_argument("--replace-owned-output", action="store_true")
    validate = subparsers.add_parser("validate", help="Validate an existing queue")
    validate.add_argument("--queue", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build_bundle(
                master_manifest=args.master_manifest,
                pseudo_targets=args.pseudo_targets,
                fast_review_root=args.fast_review_root,
                legacy_contact_index=args.legacy_contact_index,
                artifacts_root=args.artifacts_root,
                catalog_registry=args.catalog_registry,
                render_bank_manifest=args.render_bank_manifest,
                active_catalog=args.active_catalog,
                output_dir=args.output,
                project_root=args.project_root.resolve(),
                rows_per_sheet=args.rows_per_sheet,
                count=args.count,
                extra_exclusion_files=args.extra_exclusion_jsonl,
                qa_roots=args.qa_root,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_bundle(args.queue)
    except (HighValueQueueError, catalog_assets.CatalogAssetError) as error:
        raise SystemExit(f"error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
