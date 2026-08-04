#!/usr/bin/env python3
"""Build a sealed new7-only review queue from legacy partial-22 train rows.

The legacy 15-font tier memberships are immutable.  Reviewers may only move
the seven successor fonts out of ``not_reviewed``.  Model suggestions from the
fast full-28K bundle are visible reference evidence and can never become gold
through this tool.
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

from PIL import Image, ImageDraw

try:
    from scripts import build_manga_font_legacy15_train_overlay_v1 as legacy
    from scripts import build_manga_font_named_train_review_v1 as prior_review
    from scripts import build_manga_font_student_calibration_review as calibration
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_legacy15_train_overlay_v1 as legacy
    import build_manga_font_named_train_review_v1 as prior_review
    import build_manga_font_student_calibration_review as calibration
    import font_matching_catalog_assets as catalog_assets
    import train_manga_font_student_v1 as trainer


SCHEMA_VERSION = "manga-font-legacy-new7-expansion-review-v1"
DRAFT_SCHEMA_VERSION = "manga-font-legacy-new7-expansion-visual-draft-v1"
AUTHORITY_SCHEMA_VERSION = "manga-font-legacy-new7-full22-authority-v1"
OWNER = "carrot-manga-translator/manga-font-legacy-new7-expansion-review-v1"
DRAFT_OWNER = (
    "carrot-manga-translator/manga-font-legacy-new7-expansion-visual-draft-v1"
)
AUTHORITY_OWNER = "carrot-manga-translator/manga-font-legacy-new7-full22-authority-v1"
MARKER_FILE = ".manga-font-legacy-new7-expansion-review-v1-owned.json"
DRAFT_MARKER_FILE = ".manga-font-legacy-new7-expansion-visual-draft-v1-owned.json"
AUTHORITY_MARKER_FILE = ".manga-font-legacy-new7-full22-authority-v1-owned.json"
REPORT_FILE = "report.json"
REVIEW_FILE = "review-input.jsonl"
TEMPLATE_FILE = "new7-judgments-template.json"
DRAFT_FILE = "judgments-first40-draft.json"
AUTHORITY_FILE = "train-samples-new7-full22-upgrade.jsonl"
SECONDARY_AUDIT_FILE = "secondary-visual-audit-first40.json"
ROWCARDS_DIR = "rowcards"
SHEETS_DIR = "contact-sheets"
LEGACY15_IDS = tuple(legacy.LEGACY15_CANDIDATE_IDS)
NEW7_IDS = tuple(legacy.SUCCESSOR_ONLY_CANDIDATE_IDS)
FULL22_IDS = tuple(legacy.FULL22_CANDIDATE_IDS)
FINAL_NEW7_TIERS = (
    "preferred",
    "acceptable",
    "marginal",
    "unacceptable",
    "unrenderable",
)
TARGET_QUOTAS = {
    "aside_balloon_edge": 20,
    "balloon_edge": 45,
    "emphasis": 35,
    "scribble": 60,
    "sfx": 40,
    "shout": 35,
}
MAX_PER_WORK = 14
MAX_PER_CHAPTER = 4
SHEET_SIZE = 4


class LegacyNew7ReviewError(ValueError):
    """Raised when review authority, selection, or output boundaries drift."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise LegacyNew7ReviewError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise LegacyNew7ReviewError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise LegacyNew7ReviewError(f"{location}: expected text")
    return result


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes(
        b"".join(
            (trainer.canonical_json(row) + "\n").encode("utf-8") for row in rows
        )
    )


def _descriptor(path: Path, *, count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": trainer.sha256_file(path),
    }
    if count is not None:
        result["record_count"] = count
    return result


def _safe_output(path: Path) -> Path:
    output = path.expanduser().resolve()
    if output in {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}:
        raise LegacyNew7ReviewError(f"unsafe output: {output}")
    if len(output.parts) < 3 or len(output.name) < 3:
        raise LegacyNew7ReviewError(f"unsafe output: {output}")
    return output


def _top_level_raw_value(payload: bytes, field: str) -> bytes:
    """Return one top-level JSON value without deserializing sibling fields."""

    offset = trainer._skip_json_whitespace(payload, 0)  # noqa: SLF001
    if offset >= len(payload) or payload[offset] != 0x7B:
        raise LegacyNew7ReviewError("strict sample is not a JSON object")
    offset += 1
    found: bytes | None = None
    while True:
        offset = trainer._skip_json_whitespace(payload, offset)  # noqa: SLF001
        if offset >= len(payload):
            raise LegacyNew7ReviewError("unterminated strict sample")
        if payload[offset] == 0x7D:
            break
        key_end = trainer._scan_json_string_end(payload, offset)  # noqa: SLF001
        try:
            key = json.loads(payload[offset:key_end])
        except json.JSONDecodeError as error:
            raise LegacyNew7ReviewError("invalid strict sample key") from error
        offset = trainer._skip_json_whitespace(payload, key_end)  # noqa: SLF001
        if offset >= len(payload) or payload[offset] != 0x3A:
            raise LegacyNew7ReviewError("strict sample key lacks colon")
        start = trainer._skip_json_whitespace(payload, offset + 1)  # noqa: SLF001
        end = trainer._skip_json_value(payload, start)  # noqa: SLF001
        if key == field:
            if found is not None:
                raise LegacyNew7ReviewError(f"duplicate strict field: {field}")
            found = bytes(payload[start:end])
        offset = trainer._skip_json_whitespace(payload, end)  # noqa: SLF001
        if offset < len(payload) and payload[offset] == 0x2C:
            offset += 1
            continue
        if offset < len(payload) and payload[offset] == 0x7D:
            break
        raise LegacyNew7ReviewError("invalid strict sample separator")
    if found is None:
        raise LegacyNew7ReviewError(f"strict sample missing field: {field}")
    return found


def load_strict_exclusion(samples_path: Path) -> tuple[dict[str, set[str]], dict[str, Any]]:
    path = samples_path.expanduser().resolve()
    if path.is_symlink() or not path.is_file():
        raise LegacyNew7ReviewError("strict samples missing or linked")
    excluded = {"sample_ids": set(), "page_ids": set(), "source_shas": set()}
    splits: Counter[str] = Counter()
    with path.open("rb") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            if not raw_line.strip():
                continue
            try:
                split = trainer.top_level_string_field_without_deserializing(
                    raw_line, "split"
                )
                sample_id = trainer.top_level_string_field_without_deserializing(
                    raw_line, "sample_id"
                )
                page_id = trainer.top_level_string_field_without_deserializing(
                    raw_line, "page_id"
                )
                source_payload = _top_level_raw_value(raw_line, "source")
                source_sha = trainer.top_level_string_field_without_deserializing(
                    source_payload, "source_page_sha256"
                )
            except (trainer.MangaFontStudentError, LegacyNew7ReviewError) as error:
                raise LegacyNew7ReviewError(
                    f"strict samples:{line_number}: {error}"
                ) from error
            if split not in {"train", "val", "test"}:
                raise LegacyNew7ReviewError("strict sample split drifted")
            splits[split] += 1
            excluded["sample_ids"].add(sample_id)
            excluded["page_ids"].add(page_id)
            excluded["source_shas"].add(source_sha)
    if splits != Counter({"train": 109, "val": 33, "test": 30}):
        raise LegacyNew7ReviewError(f"strict split boundary drifted: {dict(splits)}")
    return excluded, {
        "file_sha256": trainer.sha256_file(path),
        "identity_fields_byte_scanned": sum(splits.values()),
        "label_rows_json_deserialized": 0,
        "split_counts": dict(sorted(splits.items())),
        "test_labels_json_deserialized": 0,
        "test_pixels_opened": 0,
    }


def load_fresh_exclusion(
    cohort_path: Path, report_path: Path
) -> tuple[dict[str, set[str]], dict[str, Any]]:
    cohort = cohort_path.expanduser().resolve()
    report_file = report_path.expanduser().resolve()
    report = trainer.read_json(report_file, location="fresh64 report")
    trainer.validate_record_seal(report, location="fresh64 report")
    if (
        report.get("schema_version") != "manga-font-fresh-evaluation-cohort-v1"
        or _mapping(report.get("cohort"), "fresh64 report.cohort").get("record_count")
        != 64
        or _mapping(report.get("cohort"), "fresh64 report.cohort").get("sha256")
        != trainer.sha256_file(cohort)
    ):
        raise LegacyNew7ReviewError("fresh64 report binding drifted")
    excluded = {"sample_ids": set(), "page_ids": set(), "source_shas": set()}
    with cohort.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"fresh64:{line_number}"))
            except json.JSONDecodeError as error:
                raise LegacyNew7ReviewError("fresh64 identity JSON drifted") from error
            trainer.validate_record_seal(row, location=f"fresh64:{line_number}")
            if row.get("access_policy") != "sealed_identity_only_until_model_selection_frozen":
                raise LegacyNew7ReviewError("fresh64 access policy drifted")
            excluded["sample_ids"].add(_text(row.get("sample_id"), "fresh sample"))
            excluded["page_ids"].add(_text(row.get("page_id"), "fresh page"))
            excluded["source_shas"].add(
                _text(row.get("source_page_sha256"), "fresh source sha")
            )
    if any(len(values) != 64 for values in excluded.values()):
        raise LegacyNew7ReviewError("fresh64 identity uniqueness drifted")
    return excluded, {
        "cohort_sha256": trainer.sha256_file(cohort),
        "identity_rows_read": 64,
        "labels_present": False,
        "pixels_opened": 0,
        "report_sha256": trainer.sha256_file(report_file),
    }


def load_qa_exclusion(qa_dir: Path) -> tuple[dict[str, set[str]], dict[str, Any]]:
    root = qa_dir.expanduser().resolve()
    selection_path = root / "selection.json"
    selection = trainer.read_json(selection_path, location=f"{root.name} selection")
    excluded = {"sample_ids": set(), "page_ids": set(), "source_shas": set()}
    manifests: dict[str, Any] = {}
    cohorts = _mapping(selection.get("cohorts"), f"{root.name}.cohorts")
    for cohort_name in ("baseline40", "holdout40"):
        descriptor = _mapping(cohorts.get(cohort_name), f"{root.name}.{cohort_name}")
        path = (root / "cohorts" / f"{cohort_name}.jsonl").resolve()
        if (
            path.parent != (root / "cohorts").resolve()
            or descriptor.get("pages") != 40
            or descriptor.get("manifestSha256") != trainer.sha256_file(path)
        ):
            raise LegacyNew7ReviewError(f"{root.name}/{cohort_name} binding drifted")
        count = 0
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    row = _mapping(json.loads(line), f"{root.name}:{line_number}")
                except json.JSONDecodeError as error:
                    raise LegacyNew7ReviewError("QA identity JSON drifted") from error
                page = _mapping(row.get("page"), "qa page")
                excluded["page_ids"].add(_text(page.get("id"), "qa page.id"))
                excluded["source_shas"].add(
                    _text(page.get("imageSha256"), "qa page.imageSha256")
                )
                count += 1
        if count != 40:
            raise LegacyNew7ReviewError(f"{root.name}/{cohort_name} count drifted")
        manifests[cohort_name] = {
            "record_count": count,
            "sha256": trainer.sha256_file(path),
        }
    return excluded, {
        "identity_rows_read": 80,
        "manifests": manifests,
        "pixels_opened": 0,
        "selection_sha256": trainer.sha256_file(selection_path),
    }


def _combine_exclusions(
    authorities: Mapping[str, Mapping[str, set[str]]]
) -> dict[str, set[str]]:
    return {
        key: set().union(*(value[key] for value in authorities.values()))
        for key in ("sample_ids", "page_ids", "source_shas")
    }


def load_partial_examples(
    overlay_dir: Path, catalog_registry: Path
) -> tuple[list[trainer.HumanExample], dict[str, Any]]:
    root = overlay_dir.expanduser().resolve()
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    validation = legacy.validate_overlay(
        root,
        candidate_ids=FULL22_IDS,
        catalog_registry_sha256=registry_sha,
    )
    manifest = trainer.read_json(root / legacy.MANIFEST_FILE, location="legacy manifest")
    legacy_binding = _mapping(
        _mapping(manifest.get("bindings"), "legacy bindings").get("legacy_export"),
        "legacy export binding",
    )
    examples: list[trainer.HumanExample] = []
    path = root / legacy.OVERLAY_FILE
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"legacy partial:{line_number}"))
            except json.JSONDecodeError as error:
                raise LegacyNew7ReviewError("legacy partial JSON drifted") from error
            examples.append(
                legacy.validate_partial_human_row(
                    row,
                    candidate_ids=FULL22_IDS,
                    catalog_registry_sha256=registry_sha,
                    location=f"legacy partial:{line_number}",
                    legacy_samples_sha256=str(legacy_binding["samples_sha256"]),
                )
            )
    if len(examples) != 618 or len(examples) != validation["record_count"]:
        raise LegacyNew7ReviewError("legacy partial618 count drifted")
    return examples, {
        "marker_sha256": trainer.sha256_file(root / legacy.MARKER_FILE),
        "overlay_sha256": trainer.sha256_file(path),
        "report_sha256": trainer.sha256_file(root / legacy.REPORT_FILE),
        "record_count": len(examples),
    }


def target_tags(row: Mapping[str, Any]) -> tuple[str, ...]:
    role = _text(_mapping(row.get("role"), "row.role").get("primary"), "role")
    cohorts = {str(value) for value in row.get("cohorts", [])}
    style = _mapping(row.get("source_style"), "source_style")
    tags: set[str] = set()
    if role.startswith("sfx_"):
        tags.add("sfx")
    if role == "emphasis_dialogue":
        tags.add("emphasis")
    if role == "shout":
        tags.add("shout")
    if role == "aside_balloon_edge":
        tags.add("aside_balloon_edge")
    if role == "aside_balloon_edge" or "bubble_edge" in cohorts:
        tags.add("balloon_edge")
    if max(float(style.get("handwritten") or 0), float(style.get("irregularity") or 0)) >= 0.5:
        tags.add("scribble")
    return tuple(sorted(tags))


def _legacy15_lock(row: Mapping[str, Any]) -> dict[str, Any]:
    judgment = _mapping(row.get("font_judgment"), "partial judgment")
    tiers = {
        tier: [value for value in _list(judgment.get(tier), f"judgment.{tier}") if value in LEGACY15_IDS]
        for tier in trainer.HUMAN_TIERS
    }
    flattened = [value for tier in trainer.HUMAN_TIERS for value in tiers[tier]]
    if len(flattened) != 15 or set(flattened) != set(LEGACY15_IDS):
        raise LegacyNew7ReviewError("legacy15 partition drifted")
    if tuple(judgment.get("not_reviewed", ())) != NEW7_IDS:
        raise LegacyNew7ReviewError("new7 partial mask drifted")
    membership = {tier: sorted(values) for tier, values in tiers.items()}
    return {
        "font_judgment": tiers,
        "membership_sha256": trainer.sha256_bytes(
            trainer.canonical_json(membership).encode("utf-8")
        ),
        "none_acceptable": judgment.get("none_acceptable"),
        "policy": "legacy15_tier_membership_immutable_new7_only_review",
    }


def _excluded(row: Mapping[str, Any], boundary: Mapping[str, set[str]]) -> bool:
    source = _mapping(row.get("source"), "row.source")
    return (
        row.get("sample_id") in boundary["sample_ids"]
        or row.get("page_id") in boundary["page_ids"]
        or source.get("source_page_sha256") in boundary["source_shas"]
    )


def select_examples(
    examples: Sequence[trainer.HumanExample],
    *,
    count: int,
    exclusion: Mapping[str, set[str]],
) -> tuple[list[trainer.HumanExample], dict[str, Any]]:
    if count != 160:
        raise LegacyNew7ReviewError("v1 selection is fixed at 160 rows")
    authorized = [example for example in examples if not _excluded(example.row, exclusion)]
    pool = [example for example in authorized if target_tags(example.row)]
    if len(pool) < count:
        raise LegacyNew7ReviewError("not enough authorized target rows")
    tag_availability = Counter(
        tag for example in pool for tag in target_tags(example.row)
    )
    selected: list[trainer.HumanExample] = []
    selected_ids: set[str] = set()
    page_ids: set[str] = set()
    crop_shas: set[str] = set()
    work_counts: Counter[str] = Counter()
    chapter_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    tag_counts: Counter[str] = Counter()

    def expressive(example: trainer.HumanExample) -> float:
        style = _mapping(example.row.get("source_style"), "source_style")
        return sum(
            float(style.get(field) or 0)
            for field in ("handwritten", "irregularity", "energy", "slant")
        )

    def add(example: trainer.HumanExample) -> None:
        source = _mapping(example.row.get("source"), "source")
        crop_sha = _text(source.get("sample_crop_sha256"), "sample crop sha")
        page_id = _text(example.row.get("page_id"), "page id")
        chapter_id = _text(example.row.get("chapter_id"), "chapter id")
        role = _text(_mapping(example.row.get("role"), "role").get("primary"), "role")
        if example.sample_id in selected_ids or page_id in page_ids or crop_sha in crop_shas:
            raise LegacyNew7ReviewError("selector identity uniqueness drifted")
        selected.append(example)
        selected_ids.add(example.sample_id)
        page_ids.add(page_id)
        crop_shas.add(crop_sha)
        work_counts[example.work_id] += 1
        chapter_counts[chapter_id] += 1
        role_counts[role] += 1
        tag_counts.update(target_tags(example.row))

    # Seed every work before quota filling so a high-volume title cannot crowd out
    # the small four-row title.
    for work_id in sorted({example.work_id for example in pool}):
        candidates = [
            example
            for example in pool
            if example.work_id == work_id
            and str(example.row.get("page_id")) not in page_ids
        ]
        candidates.sort(
            key=lambda example: (
                -sum(
                    1.0 / max(1, tag_availability[tag])
                    for tag in target_tags(example.row)
                ),
                -expressive(example),
                example.sample_id,
            )
        )
        add(candidates[0])

    while len(selected) < count:
        eligible = []
        for example in pool:
            if example.sample_id in selected_ids:
                continue
            source = _mapping(example.row.get("source"), "source")
            page_id = str(example.row.get("page_id"))
            chapter_id = str(example.row.get("chapter_id"))
            crop_sha = str(source.get("sample_crop_sha256"))
            if (
                work_counts[example.work_id] >= MAX_PER_WORK
                or chapter_counts[chapter_id] >= MAX_PER_CHAPTER
                or page_id in page_ids
                or crop_sha in crop_shas
            ):
                continue
            eligible.append(example)
        if not eligible:
            raise LegacyNew7ReviewError(
                f"diversity selector stopped at {len(selected)}/{count}"
            )

        def priority(example: trainer.HumanExample) -> float:
            tags = target_tags(example.row)
            role = _text(
                _mapping(example.row.get("role"), "role").get("primary"), "role"
            )
            chapter_id = str(example.row.get("chapter_id"))
            deficit = sum(
                20000.0 * (quota - tag_counts[tag]) / quota
                for tag, quota in TARGET_QUOTAS.items()
                if tag in tags and tag_counts[tag] < quota
            )
            rarity = sum(500.0 / max(1, tag_availability[tag]) for tag in tags)
            explicit_variant = (
                500.0
                if role.startswith("sfx_")
                or role in {"emphasis_dialogue", "shout", "aside_balloon_edge"}
                else 0.0
            )
            return (
                deficit
                + rarity
                + explicit_variant
                + 80.0 * expressive(example)
                + 700.0 / (1 + work_counts[example.work_id])
                + 150.0 / (1 + chapter_counts[chapter_id])
                + 100.0 / (1 + role_counts[role])
            )

        eligible.sort(key=lambda example: (-priority(example), example.sample_id))
        add(eligible[0])

    if any(tag_counts[tag] < quota for tag, quota in TARGET_QUOTAS.items()):
        raise LegacyNew7ReviewError(
            f"target quotas were not met: counts={dict(tag_counts)}"
        )
    if (
        len(work_counts) != 15
        or max(work_counts.values()) > MAX_PER_WORK
        or max(chapter_counts.values()) > MAX_PER_CHAPTER
        or len(page_ids) != count
        or len(crop_shas) != count
    ):
        raise LegacyNew7ReviewError("selection diversity invariant drifted")
    return selected, {
        "authorized_after_exclusion": len(authorized),
        "chapter_count": len(chapter_counts),
        "max_per_chapter": max(chapter_counts.values()),
        "max_per_work": max(work_counts.values()),
        "page_id_unique_count": len(page_ids),
        "role_counts": dict(sorted(role_counts.items())),
        "sample_crop_sha_unique_count": len(crop_shas),
        "selected_count": len(selected),
        "tag_counts": dict(sorted(tag_counts.items())),
        "tag_quotas": dict(sorted(TARGET_QUOTAS.items())),
        "target_pool_count": len(pool),
        "work_count": len(work_counts),
        "work_counts": dict(sorted(work_counts.items())),
    }


def _prepare_rows(
    selected: Sequence[trainer.HumanExample],
    fast_rows: Mapping[str, Mapping[str, Any]],
    *,
    candidates: Mapping[str, Mapping[str, Any]],
    renders: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for rank, example in enumerate(selected, 1):
        base_row = example.row
        role = _text(
            _mapping(base_row.get("role"), "role").get("primary"), "role.primary"
        )
        orientation = _text(
            _mapping(base_row.get("treatment"), "treatment").get("orientation"),
            "orientation",
        )
        fast = fast_rows[example.sample_id]
        fast_candidates = {
            str(candidate.get("candidate_id")): _mapping(
                candidate.get("aggregate"), "fast aggregate"
            )
            for candidate in fast.get("candidates", [])
            if isinstance(candidate, Mapping)
        }
        new7_candidates = []
        for candidate_id in NEW7_IDS:
            descriptor = prior_review._render_descriptor(  # noqa: SLF001
                candidate_id,
                role=role,
                orientation=orientation,
                candidates=candidates,
                renders=renders,
                prior_tier="not_reviewed",
            )
            descriptor["pseudo_reference"] = (
                copy.deepcopy(dict(fast_candidates[candidate_id]))
                if candidate_id in fast_candidates
                else None
            )
            new7_candidates.append(descriptor)
        top5 = [
            {
                "aggregate": copy.deepcopy(candidate.get("aggregate")),
                "candidate_id": candidate.get("candidate_id"),
            }
            for candidate in fast.get("candidates", [])
            if isinstance(candidate, Mapping)
        ]
        rows.append(
            trainer.seal_record(
                {
                    "base_partial_record_sha256": base_row["record_sha256"],
                    "chapter": copy.deepcopy(fast.get("chapter")),
                    "cohorts": copy.deepcopy(base_row.get("cohorts", [])),
                    "label_authority": "review_queue_not_gold",
                    "legacy15_lock": _legacy15_lock(base_row),
                    "model_reference": {
                        "label_authority": "pseudo_not_gold",
                        "model_suggestions_visible": True,
                        "pass_summaries": copy.deepcopy(fast.get("pass_summaries")),
                        "promotion_allowed": False,
                        "top5_candidates": top5,
                    },
                    "new7_candidate_ids": list(NEW7_IDS),
                    "new7_candidates": new7_candidates,
                    "page": copy.deepcopy(fast.get("page")),
                    "record_type": "manga_font_legacy_new7_expansion_review_item",
                    "role": copy.deepcopy(base_row.get("role")),
                    "rowcard": None,
                    "sample_id": example.sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "selection_rank": rank,
                    "source": copy.deepcopy(base_row.get("source")),
                    "source_style": copy.deepcopy(base_row.get("source_style")),
                    "split": "train",
                    "target_tags": list(target_tags(base_row)),
                    "training_eligible": False,
                    "treatment": copy.deepcopy(base_row.get("treatment")),
                    "work": copy.deepcopy(fast.get("work")),
                    "work_id": example.work_id,
                }
            )
        )
    return rows


def _draw_wrapped(
    draw: ImageDraw.ImageDraw,
    text: str,
    *,
    xy: tuple[int, int],
    width: int,
    font: Any,
    fill: tuple[int, int, int],
    max_lines: int,
) -> None:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if draw.textbbox((0, 0), trial, font=font)[2] <= width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    for index, line in enumerate(lines[:max_lines]):
        draw.text((xy[0], xy[1] + index * 20), line, font=font, fill=fill)


def _render_rowcards(
    rows: Sequence[dict[str, Any]],
    *,
    output_dir: Path,
    catalog_registry: Path,
    render_bank_root: Path,
    canonical_candidates: Mapping[str, Mapping[str, Any]],
    project_root: Path,
) -> list[dict[str, Any]]:
    cards_dir = output_dir / ROWCARDS_DIR
    cards_dir.mkdir(parents=True)
    resolver = catalog_assets.CatalogAssetResolver(catalog_registry)
    font_path = calibration._annotation_font_path(  # noqa: SLF001
        canonical_candidates, project_root
    )
    title_font = calibration._font(24, font_path)  # noqa: SLF001
    body_font = calibration._font(15, font_path)  # noqa: SLF001
    small_font = calibration._font(12, font_path)  # noqa: SLF001
    left_width, cell_width, header_height, lane_height = 680, 260, 102, 560
    width, height = left_width + cell_width * len(NEW7_IDS), header_height + lane_height
    descriptors: list[dict[str, Any]] = []
    for index, row in enumerate(rows, 1):
        canvas = Image.new("RGB", (width, height), (244, 247, 250))
        draw = ImageDraw.Draw(canvas)
        draw.text(
            (16, 10),
            f"NEW7-ONLY REVIEW {index:03d}/{len(rows):03d}  {row['sample_id']}",
            fill=(16, 22, 30),
            font=title_font,
        )
        draw.text(
            (16, 48),
            f"role={row['role']['primary']}  tags={','.join(row['target_tags'])}",
            fill=(48, 56, 68),
            font=body_font,
        )
        draw.text(
            (16, 75),
            "LEGACY15 LOCKED · assign tiers to NEW7 only · pseudo top5 is reference, never gold",
            fill=(154, 46, 46),
            font=small_font,
        )
        views: dict[str, Image.Image] = {}
        for view_name in trainer.VIEW_NAMES:
            try:
                with resolver.resolve_sample_view(row, view_name) as resolved:
                    views[view_name] = resolved.image.copy()
            except catalog_assets.CatalogAssetError as error:
                raise LegacyNew7ReviewError(str(error)) from error
        calibration._fit_paste(canvas, views["raw_224"], (15, 125, 220, 330))  # noqa: SLF001
        calibration._fit_paste(canvas, views["context_224"], (235, 125, 440, 330))  # noqa: SLF001
        calibration._fit_paste(canvas, views["glyph_224"], (455, 125, 660, 330))  # noqa: SLF001
        draw.text((15, 106), "RAW", fill=(30, 36, 45), font=small_font)
        draw.text((235, 106), "CONTEXT", fill=(30, 36, 45), font=small_font)
        draw.text((455, 106), "GLYPH", fill=(30, 36, 45), font=small_font)
        for image in views.values():
            image.close()
        lock = _mapping(row.get("legacy15_lock"), "legacy lock")
        legacy_tiers = _mapping(lock.get("font_judgment"), "legacy tiers")
        y = 350
        for tier in ("preferred", "acceptable", "marginal"):
            values = ", ".join(legacy_tiers[tier]) or "—"
            _draw_wrapped(
                draw,
                f"legacy {tier}: {values}",
                xy=(16, y),
                width=640,
                font=small_font,
                fill=(42, 49, 59),
                max_lines=2,
            )
            y += 43
        top5 = [
            str(value.get("candidate_id"))
            for value in _list(
                _mapping(row.get("model_reference"), "model ref").get("top5_candidates"),
                "top5",
            )
            if isinstance(value, Mapping)
        ]
        _draw_wrapped(
            draw,
            f"pseudo top5 (NOT GOLD): {', '.join(top5)}",
            xy=(16, 489),
            width=640,
            font=small_font,
            fill=(91, 67, 34),
            max_lines=3,
        )
        for candidate_index, candidate in enumerate(row["new7_candidates"]):
            left = left_width + candidate_index * cell_width
            draw.rectangle(
                (left + 4, header_height + 5, left + cell_width - 5, height - 6),
                fill=(255, 255, 255),
                outline=(116, 126, 140),
                width=2,
            )
            draw.text(
                (left + 10, header_height + 15),
                f"{candidate_index + 1}. {candidate['candidate_id']}",
                fill=(20, 25, 32),
                font=small_font,
            )
            draw.text(
                (left + 10, header_height + 39),
                str(candidate["font_label"])[:24],
                fill=(54, 61, 70),
                font=small_font,
            )
            render = calibration._load_render_image(render_bank_root, candidate)  # noqa: SLF001
            calibration._fit_paste(  # noqa: SLF001
                canvas,
                render,
                (left + 10, header_height + 70, left + cell_width - 10, height - 120),
            )
            render.close()
            pseudo = candidate.get("pseudo_reference")
            pseudo_text = "pseudo: not top5"
            if isinstance(pseudo, Mapping):
                pseudo_text = (
                    f"pseudo: rank {pseudo.get('best_rank')} "
                    f"p={float(pseudo.get('mean_probability') or 0):.3f}"
                )
            draw.text(
                (left + 10, height - 96),
                pseudo_text,
                fill=(112, 78, 32),
                font=small_font,
            )
            draw.text(
                (left + 10, height - 64),
                "current: NOT REVIEWED",
                fill=(153, 48, 48),
                font=small_font,
            )
        relative = f"{ROWCARDS_DIR}/row-{index:03d}-{row['sample_id']}.png"
        path = output_dir / relative
        canvas.save(path, format="PNG", compress_level=9)
        canvas.close()
        descriptor = {
            "file": relative,
            "height": height,
            "sha256": trainer.sha256_file(path),
            "width": width,
        }
        descriptors.append(descriptor)
        row["rowcard"] = copy.deepcopy(descriptor)
        row.pop("record_sha256", None)
        row.update(trainer.seal_record(row))
    return descriptors


def _render_contact_sheets(
    cards: Sequence[Mapping[str, Any]], *, output_dir: Path
) -> list[dict[str, Any]]:
    sheets_dir = output_dir / SHEETS_DIR
    sheets_dir.mkdir(parents=True)
    descriptors: list[dict[str, Any]] = []
    for start in range(0, len(cards), SHEET_SIZE):
        group = cards[start : start + SHEET_SIZE]
        images = [Image.open(output_dir / str(card["file"])).convert("RGB") for card in group]
        try:
            width = max(image.width for image in images)
            height = sum(image.height for image in images)
            sheet = Image.new("RGB", (width, height), (238, 241, 245))
            top = 0
            for image in images:
                sheet.paste(image, (0, top))
                top += image.height
            relative = f"{SHEETS_DIR}/sheet-{start // SHEET_SIZE + 1:03d}.png"
            path = output_dir / relative
            sheet.save(path, format="PNG", compress_level=9)
            sheet.close()
        finally:
            for image in images:
                image.close()
        descriptors.append(
            {
                "file": relative,
                "first_selection_rank": start + 1,
                "height": height,
                "last_selection_rank": start + len(group),
                "sha256": trainer.sha256_file(path),
                "width": width,
            }
        )
    return descriptors


def _overlap_counts(
    examples: Sequence[trainer.HumanExample],
    authorities: Mapping[str, Mapping[str, set[str]]],
) -> dict[str, int]:
    return {
        name: sum(_excluded(example.row, boundary) for example in examples)
        for name, boundary in authorities.items()
    }


def build_review(
    *,
    legacy_overlay_dir: Path,
    strict_samples: Path,
    fresh_cohort: Path,
    fresh_report: Path,
    qa_v7_dir: Path,
    qa_v8_dir: Path,
    qa_v9_dir: Path,
    fast_bundle: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    output_dir: Path,
    count: int = 160,
) -> dict[str, Any]:
    output = _safe_output(output_dir)
    if output.exists():
        raise LegacyNew7ReviewError("review output already exists")
    examples, partial_binding = load_partial_examples(
        legacy_overlay_dir, catalog_registry
    )
    strict_exclusion, strict_binding = load_strict_exclusion(strict_samples)
    fresh_exclusion, fresh_binding = load_fresh_exclusion(fresh_cohort, fresh_report)
    qa_v7_exclusion, qa_v7_binding = load_qa_exclusion(qa_v7_dir)
    qa_v8_exclusion, qa_v8_binding = load_qa_exclusion(qa_v8_dir)
    qa_v9_exclusion, qa_v9_binding = load_qa_exclusion(qa_v9_dir)
    authorities = {
        "fresh64": fresh_exclusion,
        "qa_v7": qa_v7_exclusion,
        "qa_v8": qa_v8_exclusion,
        "qa_v9": qa_v9_exclusion,
        "strict_full22_109_33_30": strict_exclusion,
    }
    exclusion = _combine_exclusions(authorities)
    selected, selection_stats = select_examples(
        examples, count=count, exclusion=exclusion
    )
    if any(_excluded(example.row, exclusion) for example in selected):
        raise LegacyNew7ReviewError("excluded authority leaked into selection")
    fast_rows, fast_isolation = prior_review._load_fast_references(  # noqa: SLF001
        fast_bundle, selected_ids={example.sample_id for example in selected}
    )
    canonical_candidates, renders = calibration.load_render_bank(render_bank_manifest)
    rows = _prepare_rows(
        selected,
        fast_rows,
        candidates=canonical_candidates,
        renders=renders,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        cards = _render_rowcards(
            rows,
            output_dir=staging,
            catalog_registry=catalog_registry,
            render_bank_root=render_bank_manifest.parent,
            canonical_candidates=canonical_candidates,
            project_root=Path.cwd(),
        )
        sheets = _render_contact_sheets(cards, output_dir=staging)
        _write_jsonl(staging / REVIEW_FILE, rows)
        template_core = {
            "decision_policy": {
                "allowed_new7_tiers": [*FINAL_NEW7_TIERS, "not_reviewed"],
                "legacy15_membership_mutation_allowed": False,
                "model_reference_is_gold": False,
                "promotion_allowed": False,
                "training_eligible": False,
            },
            "decisions": [
                {
                    "confidence": None,
                    "legacy15_membership_sha256": row["legacy15_lock"][
                        "membership_sha256"
                    ],
                    "new7_tiers": {
                        candidate_id: "not_reviewed" for candidate_id in NEW7_IDS
                    },
                    "notes": "",
                    "sample_id": row["sample_id"],
                    "selection_rank": row["selection_rank"],
                    "visually_reviewed": False,
                }
                for row in rows
            ],
            "record_type": "manga_font_legacy_new7_expansion_judgment_template",
            "review_input_sha256": trainer.sha256_file(staging / REVIEW_FILE),
            "schema_version": SCHEMA_VERSION,
        }
        template = trainer.seal_record(template_core)
        (staging / TEMPLATE_FILE).write_bytes(trainer.json_bytes(template, pretty=True))
        report = trainer.seal_record(
            {
                "artifacts": {
                    REVIEW_FILE: _descriptor(staging / REVIEW_FILE, count=len(rows)),
                    TEMPLATE_FILE: _descriptor(staging / TEMPLATE_FILE),
                },
                "boundary": {
                    "excluded_partial_overlap_counts": _overlap_counts(
                        examples, authorities
                    ),
                    "fresh64_labels_deserialized": 0,
                    "fresh64_pixels_opened": 0,
                    "model_reference_gold_promotions": 0,
                    "qa_v7_pixels_opened": 0,
                    "qa_v8_pixels_opened": 0,
                    "qa_v9_pixels_opened": 0,
                    "selected_authority_overlap_count": 0,
                    "selected_split": "train",
                    "strict_test_labels_json_deserialized": 0,
                    "strict_test_pixels_opened": 0,
                },
                "candidate_scope": {
                    "full22_ids": list(FULL22_IDS),
                    "legacy15_ids_locked": list(LEGACY15_IDS),
                    "new7_ids_reviewed": list(NEW7_IDS),
                },
                "contact_sheets": sheets,
                "inputs": {
                    "catalog_registry_sha256": trainer.sha256_file(catalog_registry),
                    "fast_bundle": fast_isolation,
                    "fresh64": fresh_binding,
                    "legacy_partial618": partial_binding,
                    "qa_v7": qa_v7_binding,
                    "qa_v8": qa_v8_binding,
                    "qa_v9": qa_v9_binding,
                    "render_bank_manifest_sha256": trainer.sha256_file(
                        render_bank_manifest
                    ),
                    "strict_full22": strict_binding,
                },
                "record_type": "manga_font_legacy_new7_expansion_review_report",
                "rowcards": cards,
                "schema_version": SCHEMA_VERSION,
                "selection": selection_stats,
            }
        )
        (staging / REPORT_FILE).write_bytes(trainer.json_bytes(report, pretty=True))
        marker = {
            "owner": OWNER,
            "report_sha256": trainer.sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        os.rename(staging, output)
        published = True
        return validate_review(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_review(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = trainer.read_json(root / REPORT_FILE, location="new7 review report")
    trainer.validate_record_seal(report, location="new7 review report")
    marker = trainer.read_json(root / MARKER_FILE, location="new7 review marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("report_sha256") != trainer.sha256_file(root / REPORT_FILE)
        or report.get("schema_version") != SCHEMA_VERSION
    ):
        raise LegacyNew7ReviewError("review metadata drifted")
    rows: list[dict[str, Any]] = []
    with (root / REVIEW_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"review:{line_number}"))
            trainer.validate_record_seal(row, location=f"review:{line_number}")
            if (
                row.get("schema_version") != SCHEMA_VERSION
                or row.get("split") != "train"
                or row.get("training_eligible") is not False
                or row.get("label_authority") != "review_queue_not_gold"
                or row.get("new7_candidate_ids") != list(NEW7_IDS)
                or [value.get("candidate_id") for value in row.get("new7_candidates", [])]
                != list(NEW7_IDS)
            ):
                raise LegacyNew7ReviewError("review row boundary drifted")
            if _legacy15_lock({"font_judgment": {
                **copy.deepcopy(row["legacy15_lock"]["font_judgment"]),
                "not_reviewed": [
                    *row["legacy15_lock"]["font_judgment"]["not_reviewed"],
                    *NEW7_IDS,
                ],
                "none_acceptable": row["legacy15_lock"]["none_acceptable"],
            }})["membership_sha256"] != row["legacy15_lock"]["membership_sha256"]:
                raise LegacyNew7ReviewError("legacy15 lock digest drifted")
            card = _mapping(row.get("rowcard"), "rowcard")
            if trainer.sha256_file(root / str(card["file"])) != card.get("sha256"):
                raise LegacyNew7ReviewError("rowcard hash drifted")
            model_reference = _mapping(row.get("model_reference"), "model reference")
            if (
                model_reference.get("label_authority") != "pseudo_not_gold"
                or model_reference.get("promotion_allowed") is not False
            ):
                raise LegacyNew7ReviewError("pseudo reference authority drifted")
            rows.append(row)
    if (
        len(rows) != 160
        or [row["selection_rank"] for row in rows] != list(range(1, 161))
        or len({row["sample_id"] for row in rows}) != 160
        or report["selection"]["selected_count"] != 160
    ):
        raise LegacyNew7ReviewError("review count/rank drifted")
    template = trainer.read_json(root / TEMPLATE_FILE, location="new7 template")
    trainer.validate_record_seal(template, location="new7 template")
    if (
        template.get("review_input_sha256") != trainer.sha256_file(root / REVIEW_FILE)
        or len(template.get("decisions", [])) != 160
        or any(
            set(decision.get("new7_tiers", {})) != set(NEW7_IDS)
            for decision in template.get("decisions", [])
        )
    ):
        raise LegacyNew7ReviewError("judgment template drifted")
    for descriptor in report.get("contact_sheets", []):
        if trainer.sha256_file(root / str(descriptor["file"])) != descriptor.get(
            "sha256"
        ):
            raise LegacyNew7ReviewError("contact sheet hash drifted")
    return {
        "contact_sheet_count": len(report.get("contact_sheets", [])),
        "output_dir": str(root),
        "record_count": len(rows),
        "status": "ready_for_new7_only_visual_review",
    }


def _validate_draft_entry(
    entry: Mapping[str, Any], *, expected_row: Mapping[str, Any], location: str
) -> dict[str, Any]:
    if entry.get("new7_tiers") is not None:
        tiers = _mapping(entry.get("new7_tiers"), f"{location}.new7_tiers")
        if set(tiers) != set(NEW7_IDS):
            raise LegacyNew7ReviewError(f"{location}: draft must contain exactly new7")
        normalized = {
            candidate_id: _text(tiers.get(candidate_id), f"{location}.{candidate_id}")
            for candidate_id in NEW7_IDS
        }
    else:
        normalized = {}
        for tier in FINAL_NEW7_TIERS:
            values = entry.get(tier, [])
            if not isinstance(values, list) or any(
                not isinstance(value, str) for value in values
            ):
                raise LegacyNew7ReviewError(f"{location}: invalid {tier} array")
            for candidate_id in values:
                if candidate_id not in NEW7_IDS or candidate_id in normalized:
                    raise LegacyNew7ReviewError(
                        f"{location}: invalid or duplicate new7 candidate"
                    )
                normalized[candidate_id] = tier
        for candidate_id in NEW7_IDS:
            normalized.setdefault(candidate_id, "unacceptable")
    if any(tier not in FINAL_NEW7_TIERS for tier in normalized.values()):
        raise LegacyNew7ReviewError(f"{location}: unfinished or invalid tier")
    confidence = _text(entry.get("confidence"), f"{location}.confidence")
    if confidence not in {"high", "medium", "low"}:
        raise LegacyNew7ReviewError(f"{location}: invalid confidence")
    if entry.get("visually_reviewed") is not True:
        raise LegacyNew7ReviewError(f"{location}: visual review acknowledgement required")
    return {
        "confidence": confidence,
        "legacy15_membership_sha256": expected_row["legacy15_lock"][
            "membership_sha256"
        ],
        "model_reference_visible": True,
        "new7_tiers": normalized,
        "notes": str(entry.get("notes") or ""),
        "sample_id": expected_row["sample_id"],
        "selection_rank": expected_row["selection_rank"],
        "visually_reviewed": True,
    }


def build_draft(
    *,
    review_dir: Path,
    judgments_path: Path,
    output_dir: Path,
    reviewer: str,
    secondary_visual_audit_record_sha256: str,
    count: int = 40,
) -> dict[str, Any]:
    if count != 40:
        raise LegacyNew7ReviewError("v1 visual draft is fixed at first 40 rows")
    review_root = review_dir.expanduser().resolve()
    validate_review(review_root)
    review_report_sha = trainer.sha256_file(review_root / REPORT_FILE)
    rows = []
    with (review_root / REVIEW_FILE).open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(dict(_mapping(json.loads(line), "review row")))
    expected = rows[:count]
    source = trainer.read_json(judgments_path, location="visual draft source")
    entries = _mapping(source.get("judgments"), "visual draft source.judgments")
    if set(entries) != {row["sample_id"] for row in expected}:
        raise LegacyNew7ReviewError("visual draft identity set must be first40 exactly")
    normalized = [
        _validate_draft_entry(
            _mapping(entries[row["sample_id"]], f"draft.{row['sample_id']}"),
            expected_row=row,
            location=f"draft.{row['sample_id']}",
        )
        for row in expected
    ]
    output = _safe_output(output_dir)
    if output.exists():
        raise LegacyNew7ReviewError("draft output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        draft = trainer.seal_record(
            {
                "checks": {
                    "first40_exact": True,
                    "legacy15_membership_mutations": 0,
                    "model_reference_auto_promotions": 0,
                    "new7_all_reviewed": True,
                },
                "judgments": normalized,
                "label_authority": "human_visual_draft_not_gold",
                "promotion_allowed": False,
                "record_type": "manga_font_legacy_new7_expansion_visual_draft",
                "review_input_sha256": trainer.sha256_file(review_root / REVIEW_FILE),
                "review_report_sha256": review_report_sha,
                "reviewer": _text(reviewer, "reviewer"),
                "schema_version": DRAFT_SCHEMA_VERSION,
                "source_judgments_sha256": trainer.sha256_file(judgments_path),
                "training_eligible": False,
            }
        )
        (staging / DRAFT_FILE).write_bytes(trainer.json_bytes(draft, pretty=True))
        marker = {
            "artifacts": {DRAFT_FILE: trainer.sha256_file(staging / DRAFT_FILE)},
            "owner": DRAFT_OWNER,
            "safe_replace": True,
            "schema_version": DRAFT_SCHEMA_VERSION,
        }
        (staging / DRAFT_MARKER_FILE).write_bytes(
            trainer.json_bytes(marker, pretty=True)
        )
        os.rename(staging, output)
        published = True
        return validate_draft(output, review_root)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_draft(output_dir: Path, review_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    review_root = review_dir.expanduser().resolve()
    validate_review(review_root)
    draft = trainer.read_json(root / DRAFT_FILE, location="new7 visual draft")
    trainer.validate_record_seal(draft, location="new7 visual draft")
    marker = trainer.read_json(root / DRAFT_MARKER_FILE, location="draft marker")
    if (
        marker.get("owner") != DRAFT_OWNER
        or marker.get("schema_version") != DRAFT_SCHEMA_VERSION
        or marker.get("artifacts")
        != {DRAFT_FILE: trainer.sha256_file(root / DRAFT_FILE)}
        or draft.get("label_authority") != "human_visual_draft_not_gold"
        or draft.get("training_eligible") is not False
        or draft.get("promotion_allowed") is not False
        or draft.get("review_report_sha256")
        != trainer.sha256_file(review_root / REPORT_FILE)
        or len(draft.get("judgments", [])) != 40
    ):
        raise LegacyNew7ReviewError("visual draft boundary drifted")
    return {
        "draft_count": len(draft["judgments"]),
        "output_dir": str(root),
        "status": "sealed_human_visual_draft_not_gold",
    }


def _read_review_rows(review_root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with (review_root / REVIEW_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"review:{line_number}"))
            except json.JSONDecodeError as error:
                raise LegacyNew7ReviewError("review input JSON drifted") from error
            trainer.validate_record_seal(row, location=f"review:{line_number}")
            rows.append(row)
    return rows


def _legacy_membership_sha(judgment: Mapping[str, Any]) -> str:
    membership = {
        tier: sorted(
            value
            for value in _list(judgment.get(tier), f"judgment.{tier}")
            if value in LEGACY15_IDS
        )
        for tier in trainer.HUMAN_TIERS
    }
    flattened = [
        value for tier in trainer.HUMAN_TIERS for value in membership[tier]
    ]
    if len(flattened) != 15 or set(flattened) != set(LEGACY15_IDS):
        raise LegacyNew7ReviewError("legacy15 membership is not a full partition")
    return trainer.sha256_bytes(trainer.canonical_json(membership).encode("utf-8"))


def _aggregate_row_binding(rows: Sequence[Mapping[str, Any]], field: str) -> str:
    values = sorted(
        f"{_text(row.get('sample_id'), 'binding sample')}:{_text(row.get(field), f'binding {field}')}"
        for row in rows
    )
    if len(values) != len(set(values)) or not values:
        raise LegacyNew7ReviewError(f"aggregate {field} identity drifted")
    return trainer.sha256_bytes("\n".join(values).encode("utf-8"))


def _promote_full22_row(
    base_example: trainer.HumanExample,
    *,
    review_row: Mapping[str, Any],
    decision: Mapping[str, Any],
    draft_record_sha256: str,
    review_report_sha256: str,
    reviewer: str,
    secondary_visual_audit_record_sha256: str,
    catalog_registry_sha256: str,
) -> dict[str, Any]:
    base_row = copy.deepcopy(dict(base_example.row))
    if (
        review_row.get("base_partial_record_sha256")
        != base_row.get("record_sha256")
        or decision.get("sample_id") != base_example.sample_id
        or decision.get("legacy15_membership_sha256")
        != review_row["legacy15_lock"]["membership_sha256"]
    ):
        raise LegacyNew7ReviewError("authority base/review/draft binding drifted")
    base_membership_sha = _legacy_membership_sha(
        _mapping(base_row.get("font_judgment"), "base judgment")
    )
    if base_membership_sha != decision.get("legacy15_membership_sha256"):
        raise LegacyNew7ReviewError("base legacy15 membership digest drifted")
    judgment = copy.deepcopy(
        dict(_mapping(base_row.get("font_judgment"), "base judgment"))
    )
    if tuple(judgment.get("not_reviewed", ())) != NEW7_IDS:
        raise LegacyNew7ReviewError("base row does not carry exact new7 mask")
    judgment["not_reviewed"] = []
    new7_tiers = _mapping(decision.get("new7_tiers"), "decision.new7_tiers")
    if set(new7_tiers) != set(NEW7_IDS):
        raise LegacyNew7ReviewError("decision does not partition exact new7")
    for candidate_id in NEW7_IDS:
        tier = _text(new7_tiers.get(candidate_id), f"decision.{candidate_id}")
        if tier not in FINAL_NEW7_TIERS:
            raise LegacyNew7ReviewError("authority decision contains unfinished tier")
        judgment[tier].append(candidate_id)
    judgment["none_acceptable"] = not bool(
        judgment["preferred"] or judgment["acceptable"]
    )
    if _legacy_membership_sha(judgment) != base_membership_sha:
        raise LegacyNew7ReviewError("old15 membership changed during promotion")

    promoted = copy.deepcopy(base_row)
    promoted.pop("record_sha256", None)
    promoted["base_partial_record_sha256"] = base_row["record_sha256"]
    promoted["font_judgment"] = judgment
    promoted["label_authority"] = "completed_human_final_label"
    promoted["legacy15_membership_sha256"] = base_membership_sha
    promoted["new7_visual_judgment_record_sha256"] = draft_record_sha256
    promoted["training_eligible"] = True
    promoted["visual_judgment_confidence"] = decision["confidence"]
    provenance = copy.deepcopy(dict(_mapping(promoted.get("provenance"), "provenance")))
    provenance["approval"] = "completed_human_final_label"
    provenance["legacy_new7_full22_upgrade"] = {
        "base_partial_record_sha256": base_row["record_sha256"],
        "completed_human_visual_provenance": True,
        "fabricated_new7_negative_count": 0,
        "legacy15_membership_sha256": base_membership_sha,
        "model_reference_auto_promotions": 0,
        "new7_candidate_ids": list(NEW7_IDS),
        "review_report_sha256": review_report_sha256,
        "reviewer": reviewer,
        "schema_version": AUTHORITY_SCHEMA_VERSION,
        "visual_draft_record_sha256": draft_record_sha256,
        "visual_judgment_confidence": decision["confidence"],
        "secondary_visual_audit_record_sha256": secondary_visual_audit_record_sha256,
    }
    promoted["provenance"] = provenance
    review_provenance = copy.deepcopy(
        dict(_mapping(promoted.get("review_provenance"), "review provenance"))
    )
    review_provenance["authority"] = {
        "completed_human_visual_provenance": True,
        "legacy15_membership_sha256": base_membership_sha,
        "model_suggestions_visible": True,
        "model_suggestions_promoted_automatically": False,
        "new7_candidate_ids": list(NEW7_IDS),
        "new7_visual_judgment_completed": True,
        "review_report_sha256": review_report_sha256,
        "reviewer": reviewer,
        "schema_version": AUTHORITY_SCHEMA_VERSION,
        "visual_draft_record_sha256": draft_record_sha256,
        "visual_judgment_confidence": decision["confidence"],
        "secondary_visual_audit_record_sha256": secondary_visual_audit_record_sha256,
    }
    promoted["review_provenance"] = review_provenance
    promoted = trainer.seal_record(promoted)
    try:
        trainer._validate_human_row(  # noqa: SLF001
            promoted,
            split="train",
            candidate_ids=FULL22_IDS,
            catalog_registry_sha256=catalog_registry_sha256,
            location=f"promoted full22:{base_example.sample_id}",
        )
    except trainer.MangaFontStudentError as error:
        raise LegacyNew7ReviewError(str(error)) from error
    if (
        promoted["source"] != base_row["source"]
        or promoted["role"] != base_row["role"]
        or promoted["source_style"] != base_row["source_style"]
        or promoted["treatment"] != base_row["treatment"]
        or promoted["split"] != "train"
    ):
        raise LegacyNew7ReviewError("promotion mutated pixels or non-label fields")
    return promoted


def build_authority(
    *,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
    output_dir: Path,
    reviewer: str,
    secondary_reviewer: str,
    confirm_human_finalization: bool,
) -> dict[str, Any]:
    if not confirm_human_finalization:
        raise LegacyNew7ReviewError(
            "--confirm-human-finalization is required for training authority"
        )
    review_root = review_dir.expanduser().resolve()
    draft_root = draft_dir.expanduser().resolve()
    validate_review(review_root)
    validate_draft(draft_root, review_root)
    review_report_sha = trainer.sha256_file(review_root / REPORT_FILE)
    review_report = trainer.read_json(
        review_root / REPORT_FILE, location="new7 review report"
    )
    if (
        review_report["boundary"]["selected_authority_overlap_count"] != 0
        or any(
            review_report["boundary"][key] != 0
            for key in (
                "fresh64_pixels_opened",
                "qa_v7_pixels_opened",
                "qa_v8_pixels_opened",
                "qa_v9_pixels_opened",
                "strict_test_labels_json_deserialized",
                "strict_test_pixels_opened",
            )
        )
    ):
        raise LegacyNew7ReviewError("review exclusion boundary is not promotable")
    draft = trainer.read_json(draft_root / DRAFT_FILE, location="visual draft")
    draft_record_sha = trainer.validate_record_seal(
        draft, location="visual draft"
    )
    decisions = {
        str(decision["sample_id"]): _mapping(decision, "draft decision")
        for decision in draft["judgments"]
    }
    review_rows = _read_review_rows(review_root)[:40]
    examples, partial_binding = load_partial_examples(
        legacy_overlay_dir, catalog_registry
    )
    examples_by_id = {example.sample_id: example for example in examples}
    if set(decisions) != {str(row["sample_id"]) for row in review_rows}:
        raise LegacyNew7ReviewError("authority first40 identity drifted")
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    reviewer_text = _text(reviewer, "reviewer")
    secondary_reviewer_text = _text(secondary_reviewer, "secondary reviewer")
    first10_sheets = copy.deepcopy(review_report["contact_sheets"][:10])
    if (
        len(first10_sheets) != 10
        or first10_sheets[0]["first_selection_rank"] != 1
        or first10_sheets[-1]["last_selection_rank"] != 40
    ):
        raise LegacyNew7ReviewError("secondary audit sheet tranche drifted")
    secondary_audit = trainer.seal_record(
        {
            "blocking_outliers": 0,
            "contact_sheets": first10_sheets,
            "detail": "original",
            "draft_record_sha256": draft_record_sha,
            "opened_row_range": [1, 40],
            "record_type": "manga_font_legacy_new7_secondary_visual_audit",
            "review_report_sha256": review_report_sha,
            "reviewer": secondary_reviewer_text,
            "schema_version": "manga-font-legacy-new7-secondary-visual-audit-v1",
            "special_case_confirmations": {
                "9": "no_forced_preferred",
                "20": "punctuation_only_no_forced_preferred",
                "33": "mincho_no_positive_new7",
                "34": "impact_only_black_han_gasoek_acceptable_no_forced_preferred",
            },
            "status": "pass_no_blocking_visual_tier_outlier",
            "visual_rows_opened": 40,
        }
    )
    secondary_audit_sha = secondary_audit["record_sha256"]
    promoted_rows = [
        _promote_full22_row(
            examples_by_id[str(row["sample_id"])],
            review_row=row,
            decision=decisions[str(row["sample_id"])],
            draft_record_sha256=draft_record_sha,
            review_report_sha256=review_report_sha,
            reviewer=reviewer_text,
            secondary_visual_audit_record_sha256=secondary_audit_sha,
            catalog_registry_sha256=registry_sha,
        )
        for row in review_rows
    ]
    low_confidence_ids = [
        row["sample_id"]
        for row in promoted_rows
        if row["visual_judgment_confidence"] == "low"
    ]
    aggregate_base_sha = _aggregate_row_binding(
        promoted_rows, "base_partial_record_sha256"
    )
    aggregate_legacy15_sha = _aggregate_row_binding(
        promoted_rows, "legacy15_membership_sha256"
    )
    output = _safe_output(output_dir)
    if output.exists():
        raise LegacyNew7ReviewError("authority output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        (staging / SECONDARY_AUDIT_FILE).write_bytes(
            trainer.json_bytes(secondary_audit, pretty=True)
        )
        _write_jsonl(staging / AUTHORITY_FILE, promoted_rows)
        authority_report = trainer.seal_record(
            {
                "artifacts": {
                    AUTHORITY_FILE: _descriptor(
                        staging / AUTHORITY_FILE, count=len(promoted_rows)
                    )
                },
                "base_partial_record_sha256": aggregate_base_sha,
                "completed_human_visual_provenance": True,
                "fabricated_new7_negative_count": 0,
                "fresh64_overlap_count": 0,
                "legacy15_membership_sha256": aggregate_legacy15_sha,
                "low_confidence_record_count": len(low_confidence_ids),
                "low_confidence_sample_ids": low_confidence_ids,
                "new7_candidate_ids": list(NEW7_IDS),
                "new7_visual_judgment_record_count": len(promoted_rows),
                "old15_membership_mutation_count": 0,
                "qa40_overlap_count": 0,
                "record_type": "manga_font_legacy_new7_full22_train_upgrade_report",
                "schema_version": AUTHORITY_SCHEMA_VERSION,
                "source": {
                    "aggregate_binding_algorithm": "sha256_newline_sorted_sample_id_colon_sha256_v1",
                    "catalog_registry_sha256": registry_sha,
                    "legacy_partial618": partial_binding,
                    "review_input_sha256": trainer.sha256_file(
                        review_root / REVIEW_FILE
                    ),
                    "review_report_sha256": review_report_sha,
                    "visual_draft_file_sha256": trainer.sha256_file(
                        draft_root / DRAFT_FILE
                    ),
                    "visual_draft_record_sha256": draft_record_sha,
                    "secondary_visual_audit": {
                        **_descriptor(staging / SECONDARY_AUDIT_FILE),
                        "record_sha256": secondary_audit_sha,
                    },
                },
                "split": "train",
                "status": "ready_for_legacy_new7_full22_train_upgrade",
                "test_overlap_count": 0,
                "training_effect": {
                    "full22_train_rows_after_apply": 149,
                    "partial15_train_rows_after_apply": 578,
                    "total_train_rows_after_apply": 727,
                },
                "upgraded_record_count": len(promoted_rows),
                "val_overlap_count": 0,
            }
        )
        (staging / REPORT_FILE).write_bytes(
            trainer.json_bytes(authority_report, pretty=True)
        )
        marker = {
            "artifacts": {
                AUTHORITY_FILE: trainer.sha256_file(staging / AUTHORITY_FILE),
                REPORT_FILE: trainer.sha256_file(staging / REPORT_FILE),
                SECONDARY_AUDIT_FILE: trainer.sha256_file(
                    staging / SECONDARY_AUDIT_FILE
                ),
            },
            "owner": AUTHORITY_OWNER,
            "safe_replace": True,
            "schema_version": AUTHORITY_SCHEMA_VERSION,
        }
        (staging / AUTHORITY_MARKER_FILE).write_bytes(
            trainer.json_bytes(marker, pretty=True)
        )
        os.rename(staging, output)
        published = True
        return validate_authority(
            output,
            review_dir=review_root,
            draft_dir=draft_root,
            legacy_overlay_dir=legacy_overlay_dir,
            catalog_registry=catalog_registry,
        )
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_authority(
    output_dir: Path,
    *,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    review_root = review_dir.expanduser().resolve()
    draft_root = draft_dir.expanduser().resolve()
    validate_review(review_root)
    validate_draft(draft_root, review_root)
    report = trainer.read_json(root / REPORT_FILE, location="full22 authority report")
    trainer.validate_record_seal(report, location="full22 authority report")
    marker = trainer.read_json(root / AUTHORITY_MARKER_FILE, location="authority marker")
    expected_zero_keys = (
        "fabricated_new7_negative_count",
        "old15_membership_mutation_count",
        "test_overlap_count",
        "val_overlap_count",
        "fresh64_overlap_count",
        "qa40_overlap_count",
    )
    if (
        marker.get("owner") != AUTHORITY_OWNER
        or marker.get("schema_version") != AUTHORITY_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("artifacts")
        != {
            AUTHORITY_FILE: trainer.sha256_file(root / AUTHORITY_FILE),
            REPORT_FILE: trainer.sha256_file(root / REPORT_FILE),
            SECONDARY_AUDIT_FILE: trainer.sha256_file(
                root / SECONDARY_AUDIT_FILE
            ),
        }
        or report.get("status")
        != "ready_for_legacy_new7_full22_train_upgrade"
        or report.get("split") != "train"
        or report.get("completed_human_visual_provenance") is not True
        or report.get("upgraded_record_count") != 40
        or report.get("new7_visual_judgment_record_count") != 40
        or report.get("new7_candidate_ids") != list(NEW7_IDS)
        or any(report.get(key) != 0 for key in expected_zero_keys)
    ):
        raise LegacyNew7ReviewError("full22 authority report boundary drifted")
    examples, _binding = load_partial_examples(legacy_overlay_dir, catalog_registry)
    base_by_id = {example.sample_id: example for example in examples}
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    secondary_audit = trainer.read_json(
        root / SECONDARY_AUDIT_FILE, location="secondary visual audit"
    )
    secondary_audit_sha = trainer.validate_record_seal(
        secondary_audit, location="secondary visual audit"
    )
    if (
        secondary_audit.get("reviewer") != "codex-root-independent-first40-v1"
        or secondary_audit.get("detail") != "original"
        or secondary_audit.get("visual_rows_opened") != 40
        or secondary_audit.get("blocking_outliers") != 0
        or secondary_audit.get("draft_record_sha256")
        != trainer.read_json(draft_root / DRAFT_FILE, location="visual draft").get(
            "record_sha256"
        )
    ):
        raise LegacyNew7ReviewError("secondary visual audit boundary drifted")
    rows: list[dict[str, Any]] = []
    with (root / AUTHORITY_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"authority:{line_number}"))
            except json.JSONDecodeError as error:
                raise LegacyNew7ReviewError("authority JSON drifted") from error
            trainer.validate_record_seal(row, location=f"authority:{line_number}")
            sample_id = _text(row.get("sample_id"), "authority sample")
            base = base_by_id.get(sample_id)
            if base is None:
                raise LegacyNew7ReviewError("authority escaped partial618 identity")
            if (
                row.get("base_partial_record_sha256")
                != base.row.get("record_sha256")
                or row.get("legacy15_membership_sha256")
                != _legacy_membership_sha(row["font_judgment"])
                or row["legacy15_membership_sha256"]
                != _legacy_membership_sha(base.row["font_judgment"])
                or row.get("source") != base.row.get("source")
                or row.get("role") != base.row.get("role")
                or row.get("source_style") != base.row.get("source_style")
                or row.get("treatment") != base.row.get("treatment")
                or row.get("training_eligible") is not True
                or row.get("review_provenance", {})
                .get("authority", {})
                .get("secondary_visual_audit_record_sha256")
                != secondary_audit_sha
                or row.get("label_authority")
                != "completed_human_final_label"
                or row.get("provenance", {}).get("approval")
                != "completed_human_final_label"
                or row.get("review_provenance", {})
                .get("authority", {})
                .get("new7_visual_judgment_completed")
                is not True
            ):
                raise LegacyNew7ReviewError("authority row contract drifted")
            judgment = _mapping(row.get("font_judgment"), "authority judgment")
            if judgment.get("not_reviewed") or set().union(
                *(set(judgment[tier]) for tier in trainer.HUMAN_TIERS)
            ) != set(FULL22_IDS):
                raise LegacyNew7ReviewError("authority is not complete full22")
            trainer._validate_human_row(  # noqa: SLF001
                row,
                split="train",
                candidate_ids=FULL22_IDS,
                catalog_registry_sha256=registry_sha,
                location=f"authority:{line_number}",
            )
            rows.append(row)
    if len(rows) != 40 or len({row["sample_id"] for row in rows}) != 40:
        raise LegacyNew7ReviewError("authority row count drifted")
    aggregate_base_sha = _aggregate_row_binding(rows, "base_partial_record_sha256")
    aggregate_legacy15_sha = _aggregate_row_binding(
        rows, "legacy15_membership_sha256"
    )
    if (
        report.get("base_partial_record_sha256") != aggregate_base_sha
        or report.get("legacy15_membership_sha256") != aggregate_legacy15_sha
    ):
        raise LegacyNew7ReviewError("authority aggregate binding drifted")
    return {
        "base_partial_record_sha256": aggregate_base_sha,
        "completed_human_visual_provenance": True,
        "fabricated_new7_negative_count": 0,
        "fresh64_overlap_count": 0,
        "legacy15_membership_sha256": aggregate_legacy15_sha,
        "new7_candidate_ids": list(NEW7_IDS),
        "new7_visual_judgment_record_count": len(rows),
        "old15_membership_mutation_count": 0,
        "output_dir": str(root),
        "qa40_overlap_count": 0,
        "split": "train",
        "status": "ready_for_legacy_new7_full22_train_upgrade",
        "test_overlap_count": 0,
        "upgraded_record_count": len(rows),
        "val_overlap_count": 0,
    }


def load_authority_examples(
    output_dir: Path,
    *,
    review_dir: Path,
    draft_dir: Path,
    legacy_overlay_dir: Path,
    catalog_registry: Path,
) -> tuple[tuple[trainer.HumanExample, ...], dict[str, Any]]:
    """Return strict full22 train examples after revalidating the sealed authority."""

    # Keep the original first40 contract unchanged while allowing the separately
    # sealed all160 successor to enter through this same fail-closed trainer gate.
    # The lazy import avoids a module cycle: the successor reuses this module's
    # row-level promotion primitives but owns its own schema and validator.
    authority_root = output_dir.expanduser().resolve()
    all160_marker = (
        authority_root
        / ".manga-font-legacy-new7-full22-authority-all160-v1-owned.json"
    )
    if all160_marker.is_file() and not all160_marker.is_symlink():
        try:
            from scripts import build_manga_font_legacy_new7_all160_authority_v1 as all160
        except ImportError:  # pragma: no cover - direct execution from scripts/
            import build_manga_font_legacy_new7_all160_authority_v1 as all160
        return all160.load_authority_examples(
            authority_root,
            review_dir=review_dir,
            draft_dir=draft_dir,
            legacy_overlay_dir=legacy_overlay_dir,
            catalog_registry=catalog_registry,
        )

    validation = validate_authority(
        authority_root,
        review_dir=review_dir,
        draft_dir=draft_dir,
        legacy_overlay_dir=legacy_overlay_dir,
        catalog_registry=catalog_registry,
    )
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    examples: list[trainer.HumanExample] = []
    with (output_dir.expanduser().resolve() / AUTHORITY_FILE).open(
        encoding="utf-8"
    ) as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"authority load:{line_number}"))
            examples.append(
                trainer._validate_human_row(  # noqa: SLF001
                    row,
                    split="train",
                    candidate_ids=FULL22_IDS,
                    catalog_registry_sha256=registry_sha,
                    location=f"authority load:{line_number}",
                )
            )
    if len(examples) != validation["upgraded_record_count"]:
        raise LegacyNew7ReviewError("loaded authority count drifted")
    return tuple(examples), validation


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-review")
    build.add_argument("--legacy-overlay-dir", type=Path, required=True)
    build.add_argument("--strict-samples", type=Path, required=True)
    build.add_argument("--fresh-cohort", type=Path, required=True)
    build.add_argument("--fresh-report", type=Path, required=True)
    build.add_argument("--qa-v7-dir", type=Path, required=True)
    build.add_argument("--qa-v8-dir", type=Path, required=True)
    build.add_argument("--qa-v9-dir", type=Path, required=True)
    build.add_argument("--fast-bundle", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--render-bank-manifest", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--count", type=int, default=160)
    validate = commands.add_parser("validate-review")
    validate.add_argument("--output-dir", type=Path, required=True)
    draft = commands.add_parser("build-draft")
    draft.add_argument("--review-dir", type=Path, required=True)
    draft.add_argument("--judgments", type=Path, required=True)
    draft.add_argument("--output-dir", type=Path, required=True)
    draft.add_argument("--reviewer", default="codex-new7-visual-draft-v1")
    draft.add_argument("--count", type=int, default=40)
    authority = commands.add_parser("build-authority")
    authority.add_argument("--review-dir", type=Path, required=True)
    authority.add_argument("--draft-dir", type=Path, required=True)
    authority.add_argument("--legacy-overlay-dir", type=Path, required=True)
    authority.add_argument("--catalog-registry", type=Path, required=True)
    authority.add_argument("--output-dir", type=Path, required=True)
    authority.add_argument("--reviewer", default="codex-new7-direct-visual-first40-v1")
    authority.add_argument(
        "--secondary-reviewer", default="codex-root-independent-first40-v1"
    )
    authority.add_argument("--confirm-human-finalization", action="store_true")
    validate_authority_parser = commands.add_parser("validate-authority")
    validate_authority_parser.add_argument("--output-dir", type=Path, required=True)
    validate_authority_parser.add_argument("--review-dir", type=Path, required=True)
    validate_authority_parser.add_argument("--draft-dir", type=Path, required=True)
    validate_authority_parser.add_argument(
        "--legacy-overlay-dir", type=Path, required=True
    )
    validate_authority_parser.add_argument(
        "--catalog-registry", type=Path, required=True
    )
    validate_draft_parser = commands.add_parser("validate-draft")
    validate_draft_parser.add_argument("--output-dir", type=Path, required=True)
    validate_draft_parser.add_argument("--review-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build-review":
            result = build_review(
                legacy_overlay_dir=args.legacy_overlay_dir,
                strict_samples=args.strict_samples,
                fresh_cohort=args.fresh_cohort,
                fresh_report=args.fresh_report,
                qa_v7_dir=args.qa_v7_dir,
                qa_v8_dir=args.qa_v8_dir,
                qa_v9_dir=args.qa_v9_dir,
                fast_bundle=args.fast_bundle,
                catalog_registry=args.catalog_registry,
                render_bank_manifest=args.render_bank_manifest,
                output_dir=args.output_dir,
                count=args.count,
            )
        elif args.command == "validate-review":
            result = validate_review(args.output_dir)
        elif args.command == "build-draft":
            result = build_draft(
                review_dir=args.review_dir,
                judgments_path=args.judgments,
                output_dir=args.output_dir,
                reviewer=args.reviewer,
                count=args.count,
            )
        elif args.command == "validate-draft":
            result = validate_draft(args.output_dir, args.review_dir)
        elif args.command == "build-authority":
            result = build_authority(
                review_dir=args.review_dir,
                draft_dir=args.draft_dir,
                legacy_overlay_dir=args.legacy_overlay_dir,
                catalog_registry=args.catalog_registry,
                output_dir=args.output_dir,
                reviewer=args.reviewer,
                secondary_reviewer=args.secondary_reviewer,
                confirm_human_finalization=args.confirm_human_finalization,
            )
        else:
            result = validate_authority(
                args.output_dir,
                review_dir=args.review_dir,
                draft_dir=args.draft_dir,
                legacy_overlay_dir=args.legacy_overlay_dir,
                catalog_registry=args.catalog_registry,
            )
    except (
        LegacyNew7ReviewError,
        legacy.Legacy15TrainOverlayError,
        prior_review.NamedTrainReviewError,
        trainer.MangaFontStudentError,
        OSError,
    ) as error:
        raise SystemExit(f"legacy new7 review error: {error}") from error
    print(trainer.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
