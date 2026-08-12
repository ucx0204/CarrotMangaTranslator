#!/usr/bin/env python3
"""Build a new blind-first MangaFont v2 calibration/evaluation review pool.

The pool deliberately consumes only unlabelled master-v3 ``test`` pixels.  Rows
that appeared in prior human/agent label files are excluded by sample ID, and
pages used by the library full-pipeline QA cohorts are excluded by source-page
SHA.  The five test works are then frozen into work-disjoint calibration and
evaluation subsets.

Every row is reviewed in three seven-font panels.  Public sheets and decision
templates contain only row-local slot tokens; font names, model scores, and
model predictions are absent.  A separately sealed private binding maps slots
to the 21 production candidates, but no pending decision is promoted to a
training, calibration, or evaluation label by this tool.
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
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - repository-root import
    from scripts import font_matching_catalog_assets as catalog_assets


SCHEMA_VERSION = "manga-font-v2-blind-calibration-pool-v1"
RECORD_TYPE = "manga_font_v2_blind_calibration_review_item"
PRIVATE_RECORD_TYPE = "manga_font_v2_blind_candidate_binding"
REPORT_RECORD_TYPE = "manga_font_v2_blind_calibration_pool_report"
REVIEW_NEEDED_RECORD_TYPE = "manga_font_v2_initial_review_needed"
DECISION_SCHEMA_VERSION = "manga-font-v2-blind-calibration-decision-v1"
OWNER = "carrot-manga-translator/manga-font-v2-blind-calibration-pool-v1"
MARKER_FILE = ".manga-font-v2-blind-calibration-pool-owned.json"
REPORT_FILE = "report.json"
QUEUE_FILE = "review-queue.jsonl"
PRIVATE_FILE = "private-bindings.jsonl"
DECISIONS_FILE = "decisions-template.jsonl"
REVIEW_NEEDED_FILE = "initial-review-needed.jsonl"
SHEETS_DIR = "contact-sheets"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
PANEL_COUNT = 3
PANEL_SIZE = 7
EXPECTED_COUNT = 240
SHA_RE = re.compile(r"^[0-9a-f]{64}$")

# These are sampling buckets, never role-label authority.  The intentionally
# conservative confidences force ambiguous non-SFX rows into review-needed.
BUCKETS: Mapping[str, Mapping[str, Any]] = {
    "dialogue": {"probe": "dialogue-body", "confidence": 0.55},
    "narration": {"probe": "narration", "confidence": 0.42},
    "thought": {"probe": "thought-monologue", "confidence": 0.38},
    "aside_whisper": {"probe": "aside-whisper", "confidence": 0.62},
    "emphasis": {"probe": "emphasis-shout", "confidence": 0.58},
    "shout": {"probe": "emphasis-shout", "confidence": 0.62},
    "sign_title": {"probe": "narration", "confidence": 0.45},
    "sfx": {"probe": "sfx-impact", "confidence": 0.95},
}

# The two purpose partitions are work-disjoint.  The SFX counts reflect the
# actually unseen master-v3 test supply after the pinned prior-review exclusions.
PURPOSE_QUOTAS: Mapping[str, Mapping[str, int]] = {
    "calibration": {
        "dialogue": 24,
        "narration": 20,
        "thought": 20,
        "aside_whisper": 24,
        "emphasis": 24,
        "shout": 16,
        "sign_title": 15,
        "sfx": 17,
    },
    "evaluation": {
        "dialogue": 16,
        "narration": 10,
        "thought": 10,
        "aside_whisper": 12,
        "emphasis": 12,
        "shout": 8,
        "sign_title": 8,
        "sfx": 4,
    },
}
DISPLAY_CATEGORIES = frozenset(
    {"text_free", "ocr_hard", "ocr_anime_region", "font_signal_present"}
)


class BlindPoolError(ValueError):
    """Raised when the pool would be leaky, incomplete, or identity-revealing."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode(
            "utf-8"
        )
    return (canonical_json(value) + "\n").encode("utf-8")


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
        raise BlindPoolError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != declared:
        raise BlindPoolError(f"{location}: record seal mismatch")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise BlindPoolError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise BlindPoolError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise BlindPoolError(f"{location}: expected text")
    return result


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BlindPoolError(f"{location}: invalid JSON: {error}") from error
    return dict(_mapping(value, location))


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    if path.is_symlink() or not path.is_file():
        raise BlindPoolError(f"{location}: missing or linked JSONL")
    with path.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise BlindPoolError(f"{location}:{line_number}: invalid JSON") from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _safe_relative(value: Any, location: str) -> PurePosixPath:
    text = _text(value, location).replace("\\", "/")
    relative = PurePosixPath(text)
    if relative.is_absolute() or not relative.parts or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        raise BlindPoolError(f"{location}: unsafe relative path")
    return relative


def _inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    resolved_root = root.resolve()
    path = resolved_root.joinpath(*relative.parts).resolve()
    try:
        path.relative_to(resolved_root)
    except ValueError as error:
        raise BlindPoolError(f"{location}: path escapes root") from error
    return path


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes(
        "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")
    )


def _safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise BlindPoolError(f"unsafe output directory: {result}")
    return result


def _row_hash(row: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json(row).encode("utf-8"))


def _page_sha(row: Mapping[str, Any]) -> str:
    return _text(_mapping(row.get("page"), "page").get("source_page_sha256"), "page.sha")


def _work_id(row: Mapping[str, Any]) -> str:
    return _text(_mapping(row.get("work"), "work").get("id"), "work.id")


def _chapter_id(row: Mapping[str, Any]) -> str:
    return _text(_mapping(row.get("chapter"), "chapter").get("id"), "chapter.id")


def _category(row: Mapping[str, Any]) -> str:
    metadata = _mapping(row.get("metadata"), "metadata")
    value = metadata.get("candidate_primary_category")
    return value if isinstance(value, str) and value else "ordinary"


def _orientation(row: Mapping[str, Any]) -> str:
    value = _mapping(row.get("metadata"), "metadata").get("orientation")
    return "vertical" if value == "vertical" else "horizontal"


def _geometry_features(row: Mapping[str, Any]) -> tuple[float, float]:
    geometry = _mapping(row.get("geometry"), "geometry")
    bbox = _sequence(geometry.get("final_bbox_px"), "geometry.final_bbox_px")
    page = _sequence(geometry.get("page_size_px"), "geometry.page_size_px")
    if len(bbox) != 4 or len(page) != 2:
        raise BlindPoolError("invalid geometry dimensions")
    width = max(1.0, float(bbox[2]) - float(bbox[0]))
    height = max(1.0, float(bbox[3]) - float(bbox[1]))
    page_area = max(1.0, float(page[0]) * float(page[1]))
    return width / height, (width * height) / page_area


def _outline_ratio(row: Mapping[str, Any]) -> float:
    metadata = _mapping(row.get("metadata"), "metadata")
    style = metadata.get("style_metrics")
    if not isinstance(style, Mapping):
        return 0.0
    value = style.get("outline_structure_ratio")
    return float(value) if isinstance(value, (int, float)) else 0.0


def _candidate_score(row: Mapping[str, Any]) -> float:
    value = _mapping(row.get("metadata"), "metadata").get("candidate_score")
    return float(value) if isinstance(value, (int, float)) else 0.0


def bucket_eligible(row: Mapping[str, Any], bucket: str) -> bool:
    """Return a broad sampling predicate; it is never a role label."""

    category = _category(row)
    aspect, _ = _geometry_features(row)
    orientation = _orientation(row)
    if bucket == "sfx":
        return category == "page_sound"
    if bucket == "sign_title":
        return category in DISPLAY_CATEGORIES and (
            orientation == "horizontal" or aspect >= 1.35
        )
    if bucket in {"shout", "emphasis"}:
        return category in DISPLAY_CATEGORIES
    if bucket in {"aside_whisper", "thought"}:
        return category == "bubble_edge"
    if bucket == "narration":
        # Horizontal/wide rows are preferred below, but do not make that weak
        # layout heuristic a hard gate.  A human still verifies narration.
        return category == "ordinary"
    if bucket == "dialogue":
        return category == "ordinary"
    raise BlindPoolError(f"unsupported sampling bucket {bucket!r}")


def _bucket_priority(row: Mapping[str, Any], bucket: str) -> tuple[Any, ...]:
    aspect, area = _geometry_features(row)
    outline = _outline_ratio(row)
    score = _candidate_score(row)
    orientation = _orientation(row)
    if bucket == "sign_title":
        style = (0 if orientation == "horizontal" else 1, -aspect, -area)
    elif bucket == "shout":
        style = (-outline, -score, -area)
    elif bucket == "emphasis":
        style = (-score, -outline, area)
    elif bucket == "aside_whisper":
        style = (area, score, outline)
    elif bucket == "thought":
        style = (-area, outline, score)
    elif bucket == "narration":
        style = (0 if orientation == "horizontal" else 1, -aspect, -area)
    elif bucket == "dialogue":
        style = (0 if orientation == "vertical" else 1, abs(aspect - 0.65), area)
    else:
        style = (-score, -outline, area)
    tie = sha256_bytes(f"blind-pool-style-v1\0{row['id']}".encode("utf-8"))
    return (*style, tie)


def read_master_test_rows(master_manifest: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    report_path = master_manifest.parent / "report.json"
    report = _read_json(report_path, "master report")
    expected_hash = (
        _mapping(report.get("outputs"), "master report outputs").get(
            "master_manifest_sha256"
        )
    )
    actual_hash = sha256_file(master_manifest)
    if expected_hash != actual_hash:
        raise BlindPoolError("master manifest/report hash mismatch")
    rows = list(_iter_jsonl(master_manifest, "master manifest"))
    statistics = _mapping(report.get("statistics"), "master statistics")
    if statistics.get("record_count") != len(rows):
        raise BlindPoolError("master report row count drift")
    work_splits: dict[str, set[str]] = defaultdict(set)
    group_splits: dict[tuple[str, str], set[str]] = defaultdict(set)
    seen_ids: set[str] = set()
    test_rows: list[dict[str, Any]] = []
    for row in rows:
        sample_id = _text(row.get("id"), "master.id")
        if sample_id in seen_ids:
            raise BlindPoolError(f"duplicate master sample {sample_id}")
        seen_ids.add(sample_id)
        split = _text(row.get("split"), f"{sample_id}.split")
        work_splits[_work_id(row)].add(split)
        groups = _mapping(row.get("groups"), f"{sample_id}.groups")
        for key in ("root", "variant", "normalized_glyph"):
            group_splits[(key, _text(groups.get(key), f"{sample_id}.{key}"))].add(split)
        provenance = _mapping(row.get("provenance"), f"{sample_id}.provenance")
        if provenance.get("synthetic") is not False or provenance.get("qa_overlay") is not False:
            raise BlindPoolError(f"{sample_id}: synthetic/overlay source forbidden")
        if split == "test":
            test_rows.append(row)
    if any(len(values) != 1 for values in work_splits.values()):
        raise BlindPoolError("master work split leakage")
    if any(len(values) != 1 for values in group_splits.values()):
        raise BlindPoolError("master group split leakage")
    expected_test = _mapping(statistics.get("by_split"), "master by_split").get("test")
    if expected_test != len(test_rows):
        raise BlindPoolError("master test count drift")
    split_works = {
        split: sorted(work for work, values in work_splits.items() if split in values)
        for split in ("train", "val", "test")
    }
    return test_rows, {
        "manifest_sha256": actual_hash,
        "report_sha256": sha256_file(report_path),
        "split_work_ids": split_works,
        "test_row_count": len(test_rows),
    }


def load_excluded_sample_ids(paths: Sequence[Path]) -> tuple[set[str], list[dict[str, Any]]]:
    sample_ids: set[str] = set()
    descriptors: list[dict[str, Any]] = []
    for path in paths:
        source = path.expanduser().resolve()
        before = len(sample_ids)
        rows = 0
        for row in _iter_jsonl(source, f"exclusion {source.name}"):
            rows += 1
            value = row.get("sample_id")
            if isinstance(value, str) and value:
                sample_ids.add(value)
        descriptors.append(
            {
                "file": str(source),
                "row_count": rows,
                "sample_id_count_added": len(sample_ids) - before,
                "sha256": sha256_file(source),
            }
        )
    return sample_ids, descriptors


def load_qa_boundary(qa_root: Path) -> tuple[set[str], set[str], list[dict[str, Any]]]:
    root = qa_root.expanduser().resolve()
    pages: set[str] = set()
    works: set[str] = set()
    descriptors: list[dict[str, Any]] = []
    paths = sorted(root.glob("library-full-pipeline-font-qa-v*/cohorts/*.jsonl"))
    for path in paths:
        before_pages = len(pages)
        rows = 0
        for row in _iter_jsonl(path, f"QA cohort {path.name}"):
            rows += 1
            page = row.get("page")
            work = row.get("work")
            if isinstance(page, Mapping):
                value = page.get("imageSha256")
                if isinstance(value, str) and SHA_RE.fullmatch(value):
                    pages.add(value)
            if isinstance(work, Mapping):
                value = work.get("id")
                if isinstance(value, str) and value:
                    works.add(value)
        descriptors.append(
            {
                "file": str(path),
                "row_count": rows,
                "new_page_sha_count": len(pages) - before_pages,
                "sha256": sha256_file(path),
            }
        )
    if not paths:
        raise BlindPoolError("no library QA cohort manifests found")
    return pages, works, descriptors


def assign_purpose_works(rows: Sequence[Mapping[str, Any]]) -> dict[str, tuple[str, ...]]:
    by_work: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        by_work[_work_id(row)].append(row)
    if len(by_work) != 5:
        raise BlindPoolError(f"expected exactly five master test works, found {len(by_work)}")
    sfx_counts = {
        work: sum(_category(row) == "page_sound" for row in work_rows)
        for work, work_rows in by_work.items()
    }
    sfx_works = sorted(sfx_counts, key=lambda work: (-sfx_counts[work], work))
    if len([work for work in sfx_works if sfx_counts[work] > 0]) < 2:
        raise BlindPoolError("need two SFX-bearing works for work-disjoint purposes")
    calibration_anchor = sfx_works[0]
    evaluation_anchor = sfx_works[1]
    remaining = [work for work in by_work if work not in {calibration_anchor, evaluation_anchor}]
    ordinary_counts = {
        work: sum(_category(row) == "ordinary" for row in by_work[work])
        for work in remaining
    }
    evaluation_support = min(
        remaining,
        key=lambda work: (-ordinary_counts[work], work),
    )
    calibration_works = tuple(
        sorted(
            {calibration_anchor, *[work for work in remaining if work != evaluation_support]}
        )
    )
    evaluation_works = tuple(sorted({evaluation_anchor, evaluation_support}))
    if len(calibration_works) != 3 or len(evaluation_works) != 2:
        raise BlindPoolError("purpose work allocation drift")
    return {"calibration": calibration_works, "evaluation": evaluation_works}


def select_balanced_rows(
    rows: Sequence[dict[str, Any]],
    *,
    purpose_works: Mapping[str, Sequence[str]],
    quotas: Mapping[str, Mapping[str, int]] = PURPOSE_QUOTAS,
    max_rows_per_page: int = 3,
) -> list[dict[str, Any]]:
    """Select exact purpose/bucket quotas with work and page balancing."""

    selected: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    page_counts: Counter[str] = Counter()
    work_counts: Counter[str] = Counter()
    bucket_order = (
        "sfx",
        "sign_title",
        "shout",
        "emphasis",
        "narration",
        "dialogue",
        "aside_whisper",
        "thought",
    )
    for purpose in ("calibration", "evaluation"):
        works = set(purpose_works[purpose])
        purpose_total = sum(quotas[purpose].values())
        max_per_work = math.ceil((purpose_total / len(works)) * 1.4)
        for bucket in bucket_order:
            quota = int(quotas[purpose][bucket])
            pool = [
                row
                for row in rows
                if row["id"] not in used_ids
                and _work_id(row) in works
                and bucket_eligible(row, bucket)
            ]
            chosen: list[dict[str, Any]] = []
            while len(chosen) < quota:
                candidates = [
                    row
                    for row in pool
                    if row["id"] not in used_ids
                    and page_counts[_page_sha(row)] < max_rows_per_page
                    and work_counts[_work_id(row)] < max_per_work
                ]
                if not candidates:
                    # Relax only the soft work cap; the page cap is an isolation contract.
                    candidates = [
                        row
                        for row in pool
                        if row["id"] not in used_ids
                        and page_counts[_page_sha(row)] < max_rows_per_page
                    ]
                if not candidates:
                    raise BlindPoolError(
                        f"insufficient rows for {purpose}/{bucket}: "
                        f"wanted {quota}, selected {len(chosen)}"
                    )
                row = min(
                    candidates,
                    key=lambda value: (
                        page_counts[_page_sha(value)],
                        work_counts[_work_id(value)],
                        _bucket_priority(value, bucket),
                    ),
                )
                item = copy.deepcopy(row)
                item["_purpose"] = purpose
                item["_bucket"] = bucket
                chosen.append(item)
                used_ids.add(str(row["id"]))
                page_counts[_page_sha(row)] += 1
                work_counts[_work_id(row)] += 1
            selected.extend(chosen)
    expected = sum(sum(values.values()) for values in quotas.values())
    if len(selected) != expected or len(used_ids) != expected:
        raise BlindPoolError("selected pool identity/count drift")
    selected.sort(
        key=lambda row: (
            0 if row["_purpose"] == "calibration" else 1,
            list(BUCKETS).index(str(row["_bucket"])),
            sha256_bytes(f"blind-pool-order-v1\0{row['id']}".encode("utf-8")),
        )
    )
    return selected


def deterministic_candidate_panels(
    sample_id: str, candidate_ids: Sequence[str]
) -> tuple[tuple[str, ...], ...]:
    if len(candidate_ids) != PANEL_COUNT * PANEL_SIZE or len(set(candidate_ids)) != len(
        candidate_ids
    ):
        raise BlindPoolError("candidate inventory must contain exactly 21 unique IDs")
    ordered = sorted(
        candidate_ids,
        key=lambda candidate: sha256_bytes(
            f"blind-panel-order-v1\0{sample_id}\0{candidate}".encode("utf-8")
        ),
    )
    return tuple(
        tuple(ordered[start : start + PANEL_SIZE])
        for start in range(0, len(ordered), PANEL_SIZE)
    )


def _load_active_candidates(path: Path) -> tuple[str, ...]:
    document = _read_json(path, "active catalog")
    candidates = tuple(
        _text(value, "active candidate")
        for value in _sequence(document.get("candidate_ids"), "active candidate_ids")
    )
    if document.get("candidate_count") != 21 or len(candidates) != 21 or len(set(candidates)) != 21:
        raise BlindPoolError("active catalog is not the 21-font production set")
    declared = document.get("candidate_order_sha256")
    actual = sha256_bytes(("\n".join(candidates) + "\n").encode("utf-8"))
    if declared != actual:
        raise BlindPoolError("active catalog candidate order hash mismatch")
    return candidates


def _render_index(
    snapshot: catalog_assets.RenderBankSnapshot,
) -> dict[tuple[str, str, str], Mapping[str, Any]]:
    result: dict[tuple[str, str, str], Mapping[str, Any]] = {}
    for row in snapshot.prototype_evidence:
        key = (str(row["font_id"]), str(row["probe_id"]), str(row["writing_mode"]))
        if key in result:
            raise BlindPoolError(f"duplicate render prototype {key}")
        result[key] = row
    return result


def _choose_render(
    index: Mapping[tuple[str, str, str], Mapping[str, Any]],
    candidate_id: str,
    probe: str,
    writing_mode: str,
) -> Mapping[str, Any]:
    render = (
        index.get((candidate_id, probe, writing_mode))
        or index.get((candidate_id, probe, "horizontal"))
        or index.get((candidate_id, probe, "vertical"))
    )
    if render is None:
        raise BlindPoolError(f"missing render for {candidate_id}/{probe}/{writing_mode}")
    return render


def prepare_records(
    rows: Sequence[Mapping[str, Any]],
    *,
    candidate_ids: Sequence[str],
    render_index: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    public_rows: list[dict[str, Any]] = []
    private_rows: list[dict[str, Any]] = []
    for row in rows:
        sample_id = _text(row.get("id"), "sample.id")
        purpose = _text(row.get("_purpose"), f"{sample_id}.purpose")
        bucket = _text(row.get("_bucket"), f"{sample_id}.bucket")
        orientation = _orientation(row)
        probe = str(BUCKETS[bucket]["probe"])
        panels = deterministic_candidate_panels(sample_id, candidate_ids)
        review_id = f"blind-review-{sha256_bytes(f'blind-review-v1\0{sample_id}'.encode())[:24]}"
        binding_id = f"blind-bind-{sha256_bytes(f'blind-bind-v1\0{sample_id}'.encode())[:24]}"
        public_panels: list[dict[str, Any]] = []
        private_panels: list[dict[str, Any]] = []
        for panel_number, candidates in enumerate(panels, 1):
            public_slots: list[str] = []
            private_slots: list[dict[str, Any]] = []
            for slot_index, candidate_id in enumerate(candidates):
                slot = f"P{panel_number}-{chr(ord('A') + slot_index)}"
                render = _choose_render(render_index, candidate_id, probe, orientation)
                public_slots.append(slot)
                private_slots.append(
                    {
                        "candidate_id": candidate_id,
                        "render_artifact_sha256": render["artifact_sha256"],
                        "render_id": render["render_id"],
                        "slot": slot,
                        "source_font_sha256": render["source_font_sha256"],
                    }
                )
            public_panels.append(
                {"panel_number": panel_number, "sheet": None, "slots": public_slots}
            )
            private_panels.append(
                {"panel_number": panel_number, "slots": private_slots}
            )
        page_sha = _page_sha(row)
        work_id = _work_id(row)
        chapter_id = _chapter_id(row)
        source_identity = {
            "master_row_sha256": _row_hash({key: value for key, value in row.items() if not key.startswith("_")}),
            "sample_crop_sha256": row.get("sample_crop_sha256"),
            "sample_id": sample_id,
            "source_page_sha256": page_sha,
        }
        public_rows.append(
            {
                "authority": {
                    "automatic_label_promotion_allowed": False,
                    "calibration_eligible": False,
                    "evaluation_eligible": False,
                    "label_authority": "none_pending_blind_review",
                    "model_scores_visible": False,
                    "training_eligible": False,
                },
                "binding_id": binding_id,
                "chapter_token": sha256_bytes(f"chapter\0{chapter_id}".encode())[:16],
                "orientation": orientation,
                "page_token": sha256_bytes(f"page\0{page_sha}".encode())[:16],
                "panels": public_panels,
                "record_type": RECORD_TYPE,
                "review_id": review_id,
                "role_sampling": {
                    "bucket": bucket,
                    "confidence": BUCKETS[bucket]["confidence"],
                    "must_be_human_verified": True,
                    "source": "layout_metadata_sampling_hint_not_label",
                },
                "sample_id": sample_id,
                "schema_version": SCHEMA_VERSION,
                "source": {
                    "geometry": copy.deepcopy(row.get("geometry")),
                    "views": copy.deepcopy(row.get("views")),
                },
                "source_identity_sha256": sha256_bytes(canonical_json(source_identity).encode()),
                "split": "test",
                "work_token": sha256_bytes(f"work\0{work_id}".encode())[:16],
            }
        )
        private_rows.append(
            seal_record(
                {
                    "binding_id": binding_id,
                    "candidate_panels": private_panels,
                    "chapter": copy.deepcopy(row.get("chapter")),
                    "master_row_sha256": source_identity["master_row_sha256"],
                    "page": copy.deepcopy(row.get("page")),
                    "purpose": purpose,
                    "record_type": PRIVATE_RECORD_TYPE,
                    "review_id": review_id,
                    "sample_id": sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "work": copy.deepcopy(row.get("work")),
                }
            )
        )
    return public_rows, private_rows


def validate_public_row(row: Mapping[str, Any]) -> None:
    validate_record_seal(row, location="public review row")
    if row.get("schema_version") != SCHEMA_VERSION or row.get("record_type") != RECORD_TYPE:
        raise BlindPoolError("public review schema drift")
    if row.get("split") != "test" or "purpose" in row:
        raise BlindPoolError("public review boundary drift")
    authority = _mapping(row.get("authority"), "public authority")
    if authority != {
        "automatic_label_promotion_allowed": False,
        "calibration_eligible": False,
        "evaluation_eligible": False,
        "label_authority": "none_pending_blind_review",
        "model_scores_visible": False,
        "training_eligible": False,
    }:
        raise BlindPoolError("public review authority elevated")
    forbidden = {
        "candidate_id",
        "font_id",
        "font_label",
        "font_name",
        "model_score",
        "probability",
        "prediction",
        "purpose",
        "top1",
    }
    public_text = canonical_json(row).lower()
    if any(f'"{key}"' in public_text for key in forbidden):
        raise BlindPoolError("public review row leaks identity/model fields")
    panels = _sequence(row.get("panels"), "public panels")
    if len(panels) != PANEL_COUNT:
        raise BlindPoolError("public panel count drift")
    slots: list[str] = []
    for number, panel in enumerate(panels, 1):
        panel_map = _mapping(panel, f"panel {number}")
        if panel_map.get("panel_number") != number:
            raise BlindPoolError("public panel number drift")
        panel_slots = list(_sequence(panel_map.get("slots"), "panel slots"))
        expected = [f"P{number}-{chr(ord('A') + index)}" for index in range(PANEL_SIZE)]
        if panel_slots != expected:
            raise BlindPoolError("public panel slot drift")
        sheet = _mapping(panel_map.get("sheet"), "panel sheet")
        if set(sheet) != {"file", "row_index", "sha256"}:
            raise BlindPoolError("public panel sheet binding drift")
        slots.extend(str(value) for value in panel_slots)
    if len(slots) != 21 or len(set(slots)) != 21:
        raise BlindPoolError("public slots are not a 21-item partition")


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
    x = left + (right - left - fitted.width) // 2
    y = top + (bottom - top - fitted.height) // 2
    canvas.paste(fitted, (x, y))
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
    if rows_per_sheet < 1 or rows_per_sheet > 12:
        raise BlindPoolError("rows_per_sheet must be inside [1,12]")
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
    descriptors: list[dict[str, Any]] = []
    try:
        for panel_number in range(1, PANEL_COUNT + 1):
            panel_dir = output_dir / SHEETS_DIR / f"panel-{panel_number}"
            panel_dir.mkdir(parents=True)
            for sheet_index, start in enumerate(range(0, len(public_rows), rows_per_sheet), 1):
                chunk = public_rows[start : start + rows_per_sheet]
                canvas = Image.new(
                    "RGB",
                    (width, header_height + row_height * len(chunk)),
                    (246, 247, 249),
                )
                draw = ImageDraw.Draw(canvas)
                draw.text(
                    (16, 10),
                    f"BLIND-FIRST FONT REVIEW — PANEL {panel_number}/3",
                    fill=(20, 24, 31),
                    font=header_font,
                )
                draw.text(
                    (16, 43),
                    "7 opaque slots only; font names and model predictions are hidden. Verify the role hint.",
                    fill=(155, 38, 38),
                    font=body_font,
                )
                for local_index, row in enumerate(chunk):
                    top = header_height + local_index * row_height
                    bottom = top + row_height
                    draw.rectangle((0, top, width - 1, bottom - 1), outline=(188, 192, 199), width=2)
                    sampling = _mapping(row["role_sampling"], "role sampling")
                    draw.text(
                        (10, top + 7),
                        f"{start + local_index + 1:03d}  …{str(row['sample_id'])[-14:]}  "
                        f"hint={sampling['bucket']} (verify)",
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
                    private_panel = _mapping(
                        _sequence(private["candidate_panels"], "private panels")[panel_number - 1],
                        "private panel",
                    )
                    for candidate_index, binding in enumerate(
                        _sequence(private_panel["slots"], "private slots")
                    ):
                        slot = str(_mapping(binding, "private slot")["slot"])
                        render_id = str(_mapping(binding, "private slot")["render_id"])
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
                relative = f"{SHEETS_DIR}/panel-{panel_number}/sheet-{sheet_index:03d}.png"
                path = output_dir.joinpath(*PurePosixPath(relative).parts)
                canvas.save(path, format="PNG", optimize=False, compress_level=9)
                canvas.close()
                sheet_sha = sha256_file(path)
                descriptor = {
                    "file": relative,
                    "height": header_height + row_height * len(chunk),
                    "panel_number": panel_number,
                    "row_count": len(chunk),
                    "sha256": sheet_sha,
                    "width": width,
                }
                descriptors.append(descriptor)
                for local_index, row in enumerate(chunk):
                    row["panels"][panel_number - 1]["sheet"] = {
                        "file": relative,
                        "row_index": local_index,
                        "sha256": sheet_sha,
                    }
    finally:
        for image in render_cache.values():
            image.close()
    return descriptors


def _decision_template(row: Mapping[str, Any]) -> dict[str, Any]:
    confidence = float(_mapping(row.get("role_sampling"), "role sampling")["confidence"])
    return {
        "candidate_search_complete": False,
        "crop_quality": "pending",
        "decision_status": "pending",
        "font_match_confidence": None,
        "notes": "",
        "panel_decisions": [
            {
                "acceptable_slots": [],
                "marginal_slots": [],
                "panel_none_acceptable": None,
                "panel_number": panel,
                "preferred_slots": [],
                "review_complete": False,
                "unacceptable_slots": [],
                "unrenderable_slots": [],
            }
            for panel in range(1, PANEL_COUNT + 1)
        ],
        "record_type": "manga_font_v2_blind_calibration_decision",
        "review_id": row["review_id"],
        "review_item_sha256": row["record_sha256"],
        "review_needed": confidence < 0.75,
        "review_needed_reason": (
            "sampling_role_is_uncertain_and_must_be_verified" if confidence < 0.75 else None
        ),
        "reviewed_at": None,
        "reviewer": None,
        "sample_id": row["sample_id"],
        "schema_version": DECISION_SCHEMA_VERSION,
        "verified_role": None,
        "verified_role_confidence": None,
    }


def _review_needed_row(row: Mapping[str, Any]) -> dict[str, Any] | None:
    sampling = _mapping(row.get("role_sampling"), "role sampling")
    if float(sampling["confidence"]) >= 0.75:
        return None
    return seal_record(
        {
            "reason": "sampling_role_is_uncertain_and_must_be_verified",
            "record_type": REVIEW_NEEDED_RECORD_TYPE,
            "review_id": row["review_id"],
            "review_item_sha256": row["record_sha256"],
            "sample_id": row["sample_id"],
            "schema_version": SCHEMA_VERSION,
        }
    )


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def validate_bundle(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = _read_json(root / REPORT_FILE, "pool report")
    validate_record_seal(report, location="pool report")
    if report.get("schema_version") != SCHEMA_VERSION or report.get("record_type") != REPORT_RECORD_TYPE:
        raise BlindPoolError("pool report schema drift")
    marker = _read_json(root / MARKER_FILE, "pool marker")
    if marker != {
        "owner": OWNER,
        "report_sha256": sha256_file(root / REPORT_FILE),
        "safe_replace": True,
        "schema_version": SCHEMA_VERSION,
    }:
        raise BlindPoolError("pool marker drift")
    boundary = _mapping(report.get("boundary"), "pool boundary")
    if (
        boundary.get("source_split") != "test"
        or boundary.get("model_predictions_read") != 0
        or boundary.get("automatic_label_promotions") != 0
        or boundary.get("selected_prior_review_sample_overlap") != 0
        or boundary.get("selected_qa_page_overlap") != 0
        or boundary.get("calibration_evaluation_work_overlap") != 0
        or boundary.get("train_val_work_overlap") != 0
    ):
        raise BlindPoolError("pool isolation boundary drift")
    artifacts = _mapping(report.get("artifacts"), "pool artifacts")
    expected_files = {REPORT_FILE, MARKER_FILE}
    for name in (QUEUE_FILE, PRIVATE_FILE, DECISIONS_FILE, REVIEW_NEEDED_FILE):
        descriptor = _mapping(artifacts.get(name), f"artifact {name}")
        path = root / name
        if descriptor.get("file") != name or descriptor.get("sha256") != sha256_file(path):
            raise BlindPoolError(f"artifact hash drift: {name}")
        expected_files.add(name)
    sheets = _sequence(report.get("sheets"), "sheets")
    for raw in sheets:
        sheet = _mapping(raw, "sheet")
        relative = _safe_relative(sheet.get("file"), "sheet file")
        path = _inside(root, relative, "sheet file")
        if sheet.get("sha256") != sha256_file(path):
            raise BlindPoolError("sheet hash drift")
        try:
            with Image.open(path) as opened:
                opened.load()
                if (
                    opened.mode != "RGB"
                    or list(opened.size)
                    != [int(sheet.get("width", 0)), int(sheet.get("height", 0))]
                ):
                    raise BlindPoolError("sheet pixel contract drift")
        except OSError as error:
            raise BlindPoolError(f"sheet decode failed: {relative}") from error
        expected_files.add(relative.as_posix())
    actual_files = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    if actual_files != expected_files:
        raise BlindPoolError("pool exact inventory drift")
    public_rows = list(_iter_jsonl(root / QUEUE_FILE, "review queue"))
    private_rows = list(_iter_jsonl(root / PRIVATE_FILE, "private bindings"))
    decisions = list(_iter_jsonl(root / DECISIONS_FILE, "decision templates"))
    review_needed = list(
        _iter_jsonl(root / REVIEW_NEEDED_FILE, "initial review-needed")
    )
    if len(public_rows) != boundary.get("selected_rows") or len(public_rows) != EXPECTED_COUNT:
        raise BlindPoolError("review queue count drift")
    if len(private_rows) != len(public_rows) or len(decisions) != len(public_rows):
        raise BlindPoolError("public/private/decision count mismatch")
    candidates = tuple(_sequence(report.get("candidate_ids"), "candidate_ids"))
    if len(candidates) != 21 or len(set(candidates)) != 21:
        raise BlindPoolError("report candidate inventory drift")
    public_by_sample: dict[str, Mapping[str, Any]] = {}
    for row in public_rows:
        validate_public_row(row)
        lowered_public = canonical_json(row).lower()
        if any(str(candidate).lower() in lowered_public for candidate in candidates):
            raise BlindPoolError("public review row leaks a candidate identity value")
        sample_id = str(row["sample_id"])
        if sample_id in public_by_sample:
            raise BlindPoolError("duplicate public sample")
        public_by_sample[sample_id] = row
    for row in private_rows:
        validate_record_seal(row, location="private binding")
        if row.get("record_type") != PRIVATE_RECORD_TYPE or row.get("schema_version") != SCHEMA_VERSION:
            raise BlindPoolError("private binding schema drift")
        if row.get("purpose") not in PURPOSE_QUOTAS:
            raise BlindPoolError("private purpose binding drift")
        sample_id = str(row.get("sample_id"))
        public = public_by_sample.get(sample_id)
        if public is None or row.get("review_id") != public.get("review_id") or row.get("binding_id") != public.get("binding_id"):
            raise BlindPoolError("private/public binding mismatch")
        bound_ids: list[str] = []
        for panel_number, raw_panel in enumerate(
            _sequence(row.get("candidate_panels"), "private panels"), 1
        ):
            panel = _mapping(raw_panel, "private panel")
            if panel.get("panel_number") != panel_number:
                raise BlindPoolError("private panel number drift")
            for binding in _sequence(panel.get("slots"), "private slots"):
                bound_ids.append(_text(_mapping(binding, "private slot").get("candidate_id"), "candidate id"))
        if len(bound_ids) != 21 or set(bound_ids) != set(candidates):
            raise BlindPoolError("private candidate partition drift")
    decisions_by_sample: dict[str, Mapping[str, Any]] = {}
    for row in decisions:
        sample_id = str(row.get("sample_id"))
        public = public_by_sample.get(sample_id)
        if (
            public is None
            or sample_id in decisions_by_sample
            or row.get("schema_version") != DECISION_SCHEMA_VERSION
            or row.get("decision_status") != "pending"
            or row.get("candidate_search_complete") is not False
            or row.get("review_id") != public.get("review_id")
            or row.get("review_item_sha256") != public.get("record_sha256")
        ):
            raise BlindPoolError("pending decision template drift")
        panel_decisions = _sequence(row.get("panel_decisions"), "panel decisions")
        if len(panel_decisions) != PANEL_COUNT or any(
            _mapping(panel, "panel decision").get("review_complete") is not False
            for panel in panel_decisions
        ):
            raise BlindPoolError("pending panel decision drift")
        decisions_by_sample[sample_id] = row
    needed_samples: set[str] = set()
    for row in review_needed:
        validate_record_seal(row, location="initial review-needed")
        sample_id = str(row.get("sample_id"))
        public = public_by_sample.get(sample_id)
        if (
            public is None
            or sample_id in needed_samples
            or row.get("record_type") != REVIEW_NEEDED_RECORD_TYPE
            or row.get("review_item_sha256") != public.get("record_sha256")
            or float(_mapping(public.get("role_sampling"), "role sampling")["confidence"])
            >= 0.75
        ):
            raise BlindPoolError("initial review-needed partition drift")
        needed_samples.add(sample_id)
    expected_needed = {
        sample_id
        for sample_id, row in public_by_sample.items()
        if float(_mapping(row.get("role_sampling"), "role sampling")["confidence"])
        < 0.75
    }
    if needed_samples != expected_needed or len(needed_samples) != boundary.get(
        "initial_review_needed_rows"
    ):
        raise BlindPoolError("initial review-needed coverage drift")
    calibration_works = set(_sequence(boundary.get("calibration_work_ids"), "calibration works"))
    evaluation_works = set(_sequence(boundary.get("evaluation_work_ids"), "evaluation works"))
    if calibration_works & evaluation_works:
        raise BlindPoolError("purpose work leakage")
    return {
        "candidate_count": len(candidates),
        "output_dir": str(root),
        "record_count": len(public_rows),
        "review_needed_count": int(boundary["initial_review_needed_rows"]),
        "status": "ready_for_blind_three_panel_review",
    }


def build_bundle(
    *,
    master_manifest: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    active_catalog: Path,
    qa_root: Path,
    exclusion_paths: Sequence[Path],
    output_dir: Path,
    project_root: Path,
    rows_per_sheet: int,
    replace_owned_output: bool,
) -> dict[str, Any]:
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise BlindPoolError("output exists; pass --replace-owned-output")
        validate_bundle(target)
    master_rows, master_binding = read_master_test_rows(master_manifest.resolve())
    excluded_ids, exclusion_descriptors = load_excluded_sample_ids(exclusion_paths)
    qa_pages, qa_works, qa_descriptors = load_qa_boundary(qa_root)
    eligible = [
        row
        for row in master_rows
        if row["id"] not in excluded_ids and _page_sha(row) not in qa_pages
    ]
    if len(eligible) < EXPECTED_COUNT:
        raise BlindPoolError(f"only {len(eligible)} unseen test rows remain")
    purpose_works = assign_purpose_works(eligible)
    selected = select_balanced_rows(eligible, purpose_works=purpose_works)
    candidate_ids = _load_active_candidates(active_catalog.resolve())
    snapshot = catalog_assets.load_render_bank(render_bank_manifest.resolve())
    if set(candidate_ids) != set(snapshot.candidate_ids):
        raise BlindPoolError("active catalog/render bank candidate mismatch")
    render_index = _render_index(snapshot)
    public_rows, private_rows = prepare_records(
        selected, candidate_ids=candidate_ids, render_index=render_index
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
            render_snapshot=snapshot,
            rows_per_sheet=rows_per_sheet,
            annotation_font=annotation_font if annotation_font.is_file() else None,
        )
        sealed_public = [seal_record(row) for row in public_rows]
        for row in sealed_public:
            validate_public_row(row)
        decisions = [_decision_template(row) for row in sealed_public]
        review_needed = [
            item
            for row in sealed_public
            if (item := _review_needed_row(row)) is not None
        ]
        _write_jsonl(staging / QUEUE_FILE, sealed_public)
        _write_jsonl(staging / PRIVATE_FILE, private_rows)
        _write_jsonl(staging / DECISIONS_FILE, decisions)
        _write_jsonl(staging / REVIEW_NEEDED_FILE, review_needed)
        selected_ids = {str(row["id"]) for row in selected}
        selected_pages = {_page_sha(row) for row in selected}
        selected_works = {_work_id(row) for row in selected}
        train_val_works = set(master_binding["split_work_ids"]["train"]) | set(
            master_binding["split_work_ids"]["val"]
        )
        purpose_counts = Counter(str(row["_purpose"]) for row in selected)
        bucket_counts = {
            purpose: dict(
                sorted(
                    Counter(
                        str(row["_bucket"])
                        for row in selected
                        if row["_purpose"] == purpose
                    ).items()
                )
            )
            for purpose in PURPOSE_QUOTAS
        }
        report = seal_record(
            {
                "artifacts": {
                    name: _descriptor(
                        staging / name,
                        row_count=(
                            len(sealed_public)
                            if name in {QUEUE_FILE, PRIVATE_FILE, DECISIONS_FILE}
                            else len(review_needed)
                        ),
                    )
                    for name in (QUEUE_FILE, PRIVATE_FILE, DECISIONS_FILE, REVIEW_NEEDED_FILE)
                },
                "boundary": {
                    "automatic_label_promotions": 0,
                    "calibration_evaluation_work_overlap": len(
                        set(purpose_works["calibration"]) & set(purpose_works["evaluation"])
                    ),
                    "calibration_work_ids": list(purpose_works["calibration"]),
                    "evaluation_work_ids": list(purpose_works["evaluation"]),
                    "font_names_visible_on_public_sheets": False,
                    "partition_purpose_visible_to_blind_reviewer": False,
                    "initial_review_needed_rows": len(review_needed),
                    "model_predictions_read": 0,
                    "prior_review_excluded_test_rows": len(
                        {row["id"] for row in master_rows} & excluded_ids
                    ),
                    "qa_work_overlap_documented_unavoidable": len(selected_works & qa_works),
                    "selected_prior_review_sample_overlap": len(selected_ids & excluded_ids),
                    "selected_qa_page_overlap": len(selected_pages & qa_pages),
                    "selected_rows": len(selected),
                    "source_split": "test",
                    "train_val_work_overlap": len(selected_works & train_val_works),
                },
                "candidate_count": len(candidate_ids),
                "candidate_ids": list(candidate_ids),
                "candidate_order_sha256": sha256_bytes(
                    ("\n".join(candidate_ids) + "\n").encode("utf-8")
                ),
                "counts": {
                    "bucket_by_purpose": bucket_counts,
                    "eligible_unseen_test_rows": len(eligible),
                    "purpose": dict(sorted(purpose_counts.items())),
                    "selected_chapters": len({_chapter_id(row) for row in selected}),
                    "selected_pages": len(selected_pages),
                    "selected_rows": len(selected),
                    "selected_works": len(selected_works),
                },
                "inputs": {
                    "active_catalog_sha256": sha256_file(active_catalog),
                    "catalog_registry_sha256": sha256_file(catalog_registry),
                    "exclusions": exclusion_descriptors,
                    "master": master_binding,
                    "qa_cohorts": qa_descriptors,
                    "render_bank_manifest_sha256": snapshot.manifest_sha256,
                    "render_bank_specification_sha256": snapshot.specification_sha256,
                },
                "label_contract": {
                    "blind_panels_per_row": PANEL_COUNT,
                    "candidates_per_panel": PANEL_SIZE,
                    "full_candidate_partition_required_before_use": True,
                    "human_or_agent_adjudication_required": True,
                    "pending_rows_are_calibration_eligible": False,
                    "pending_rows_are_evaluation_eligible": False,
                    "pending_rows_are_training_eligible": False,
                    "private_binding_must_remain_hidden_until_blind_decision": True,
                },
                "record_type": REPORT_RECORD_TYPE,
                "schema_version": SCHEMA_VERSION,
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
    build = subparsers.add_parser("build", help="Build the sealed blind review pool")
    build.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
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
        default=Path(
            "artifacts/font-matching-runtime-active21-r5-e1-release-v1/auto-match-active-catalog.json"
        ),
    )
    build.add_argument("--qa-root", type=Path, default=Path("artifacts"))
    build.add_argument("--exclude-jsonl", type=Path, action="append", required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--project-root", type=Path, default=Path("."))
    build.add_argument("--rows-per-sheet", type=int, default=8)
    build.add_argument("--replace-owned-output", action="store_true")
    validate = subparsers.add_parser("validate", help="Validate an existing pool")
    validate.add_argument("--pool", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build_bundle(
                master_manifest=args.master_manifest,
                catalog_registry=args.catalog_registry,
                render_bank_manifest=args.render_bank_manifest,
                active_catalog=args.active_catalog,
                qa_root=args.qa_root,
                exclusion_paths=args.exclude_jsonl,
                output_dir=args.output,
                project_root=args.project_root.resolve(),
                rows_per_sheet=args.rows_per_sheet,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_bundle(args.pool)
    except (BlindPoolError, catalog_assets.CatalogAssetError) as error:
        raise SystemExit(f"error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
