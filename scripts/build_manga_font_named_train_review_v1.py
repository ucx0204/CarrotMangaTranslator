#!/usr/bin/env python3
"""Build and promote a train-only named-font review overlay.

The source authority is the already sealed strict full22 human export.  Its
hidden test rows are classified with the byte scanner from the student trainer
and are never JSON-deserialized here.  Only existing train rows are eligible.
The fast 28K named-review bundle is joined as non-gold reference evidence.
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
    from scripts import build_manga_font_fast_review_batches as fast_review
    from scripts import build_manga_font_student_calibration_review as named_review
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import font_matching_labels as labels
    from scripts import train_manga_font_student_v1 as trainer
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_fast_review_batches as fast_review
    import build_manga_font_student_calibration_review as named_review
    import font_matching_catalog_assets as catalog_assets
    import font_matching_labels as labels
    import train_manga_font_student_v1 as trainer


SCHEMA_VERSION = "manga-font-named-train-review-v1"
OVERLAY_SCHEMA_VERSION = "manga-font-named-train-overlay-v1"
OWNER = "carrot-manga-translator/manga-font-named-train-review-v1"
OVERLAY_OWNER = "carrot-manga-translator/manga-font-named-train-overlay-v1"
MARKER_FILE = ".manga-font-named-train-review-v1-owned.json"
OVERLAY_MARKER_FILE = ".manga-font-named-train-overlay-v1-owned.json"
REPORT_FILE = "report.json"
REVIEW_FILE = "review-input.jsonl"
TEMPLATE_FILE = "judgments-template.json"
ROWCARDS_DIR = "rowcards"
OVERLAY_FILE = "train-samples-named-overlay.jsonl"
QUEUE_FILE = "disagreement-low-confidence-review-queue.jsonl"
EXPECTED_IDS = named_review.EXPECTED_CANDIDATE_IDS
ORDINARY_ROLES = frozenset({"dialogue", "narration", "thought"})


class NamedTrainReviewError(ValueError):
    """Raised when named train review boundaries or seals drift."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise NamedTrainReviewError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise NamedTrainReviewError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise NamedTrainReviewError(f"{location}: expected text")
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
        raise NamedTrainReviewError(f"unsafe output: {output}")
    if len(output.parts) < 3 or len(output.name) < 3:
        raise NamedTrainReviewError(f"unsafe output: {output}")
    return output


def _candidate_tier(judgment: Mapping[str, Any], candidate_id: str) -> str:
    for tier in labels.FONT_TIERS:
        if candidate_id in _list(judgment.get(tier), f"judgment.{tier}"):
            return tier
    raise NamedTrainReviewError(f"candidate absent from prior partition: {candidate_id}")


def _variant_score(row: Mapping[str, Any]) -> float:
    role = _text(_mapping(row.get("role"), "role").get("primary"), "role.primary")
    style = _mapping(row.get("source_style"), "source_style")
    cohorts = {str(value) for value in row.get("cohorts", [])}
    role_bonus = {
        "sfx_ambient": 10.0,
        "sfx_motion": 8.0,
        "sfx_impact": 8.0,
        "sfx_comic": 7.5,
        "emphasis_dialogue": 7.0,
        "shout": 6.5,
        "sfx_emotion": 6.0,
        "sign_ui_title": 5.0,
        "whisper": 4.0,
    }.get(role, 0.0)
    cohort_bonus = 1.5 * len(
        cohorts & {"bubble_edge", "page_sound", "text_free", "ocr_hard"}
    )
    expressive = sum(
        float(style.get(field) or 0.0)
        for field in ("handwritten", "irregularity", "energy", "slant")
    )
    return role_bonus + cohort_bonus + expressive


def _eligible_variant(row: Mapping[str, Any]) -> bool:
    role = _text(_mapping(row.get("role"), "role").get("primary"), "role.primary")
    cohorts = {str(value) for value in row.get("cohorts", [])}
    return role not in ORDINARY_ROLES or bool(
        cohorts & {"bubble_edge", "page_sound", "text_free", "ocr_hard"}
    )


def _select_examples(
    examples: Sequence[trainer.HumanExample],
    *,
    count: int,
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> list[trainer.HumanExample]:
    pool = [
        example
        for example in examples
        if _eligible_variant(example.row)
        and example.sample_id not in excluded_sample_ids
    ]
    if len(pool) < count:
        raise NamedTrainReviewError("not enough train-authorized variant rows")
    selected: list[trainer.HumanExample] = []
    remaining = list(pool)
    work_counts: Counter[str] = Counter()
    chapter_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    page_ids: set[str] = set()
    crop_sha256s: set[str] = set()
    for work_cap, chapter_cap in ((3, 1), (4, 1), (4, 2), (5, 2)):
        while len(selected) < count:
            eligible = [
                example
                for example in remaining
                if work_counts[example.work_id] < work_cap
                and chapter_counts[str(example.row.get("chapter_id"))] < chapter_cap
                and str(example.row.get("page_id")) not in page_ids
                and str(
                    _mapping(example.row.get("source"), "source").get(
                        "sample_crop_sha256"
                    )
                )
                not in crop_sha256s
            ]
            if not eligible:
                break
            eligible.sort(
                key=lambda example: (
                    -(
                        _variant_score(example.row)
                        + 5.0 / (1 + work_counts[example.work_id])
                        + 4.0
                        / (
                            1
                            + role_counts[
                                str(_mapping(example.row["role"], "role")["primary"])
                            ]
                        )
                    ),
                    example.sample_id,
                )
            )
            chosen = eligible[0]
            selected.append(chosen)
            remaining.remove(chosen)
            work_counts[chosen.work_id] += 1
            chapter_counts[str(chosen.row.get("chapter_id"))] += 1
            role_counts[str(_mapping(chosen.row["role"], "role")["primary"])] += 1
            page_ids.add(str(chosen.row.get("page_id")))
            crop_sha256s.add(
                str(
                    _mapping(chosen.row.get("source"), "source").get(
                        "sample_crop_sha256"
                    )
                )
            )
        if len(selected) == count:
            break
    if len(selected) != count:
        raise NamedTrainReviewError(f"diversity selector produced {len(selected)}/{count}")
    return selected


def _load_fast_references(
    bundle_dir: Path, *, selected_ids: set[str]
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    root = bundle_dir.expanduser().resolve()
    report = fast_review._read_json(root / fast_review.REPORT_FILE, "fast report")  # noqa: SLF001
    fast_review.validate_record_seal(report, location="fast report")
    if report.get("schema_version") != fast_review.SCHEMA_VERSION:
        raise NamedTrainReviewError("fast review schema drifted")
    found: dict[str, dict[str, Any]] = {}
    skipped_test = 0
    parsed_nontrain = 0
    for batch in _list(report.get("batches"), "fast report.batches"):
        batch_map = _mapping(batch, "fast batch")
        artifacts = _mapping(batch_map.get("artifacts"), "fast batch.artifacts")
        item_descriptor = _mapping(artifacts.get("review_items"), "review items")
        path = root / "batches" / _text(batch_map.get("batch"), "batch") / _text(
            item_descriptor.get("file"), "review item file"
        )
        if trainer.sha256_file(path) != item_descriptor.get("sha256"):
            raise NamedTrainReviewError("fast review item hash drifted")
        with path.open("rb") as handle:
            for raw_line in handle:
                if not raw_line.strip():
                    continue
                split = trainer.top_level_string_field_without_deserializing(
                    raw_line, "split"
                )
                if split == "test":
                    skipped_test += 1
                    continue
                sample_id = trainer.top_level_string_field_without_deserializing(
                    raw_line, "sample_id"
                )
                if split != "train" or sample_id not in selected_ids:
                    continue
                row = dict(_mapping(json.loads(raw_line), f"fast item {sample_id}"))
                fast_review.validate_review_item(row)
                if row.get("split") != "train" or sample_id in found:
                    raise NamedTrainReviewError("fast train identity drifted")
                found[sample_id] = row
    if set(found) != selected_ids or parsed_nontrain:
        raise NamedTrainReviewError("selected rows missing from fast train authority")
    return found, {
        "fast_bundle_report_sha256": trainer.sha256_file(root / fast_review.REPORT_FILE),
        "fast_test_rows_json_deserialized": 0,
        "fast_test_rows_byte_skipped": skipped_test,
    }


def _render_descriptor(
    candidate_id: str,
    *,
    role: str,
    orientation: str,
    candidates: Mapping[str, Mapping[str, Any]],
    renders: Mapping[tuple[str, str, str], Mapping[str, Any]],
    prior_tier: str,
) -> dict[str, Any]:
    probe = named_review.ROLE_PROBES.get(role, "dialogue-body")
    mode = "vertical" if orientation == "vertical" else "horizontal"
    render = (
        renders.get((candidate_id, probe, mode))
        or renders.get((candidate_id, probe, "horizontal"))
        or renders.get((candidate_id, probe, "vertical"))
    )
    if render is None:
        raise NamedTrainReviewError(f"missing render {candidate_id}/{probe}/{mode}")
    artifact = _mapping(render.get("artifact"), "render artifact")
    return {
        "candidate_id": candidate_id,
        "font_label": _text(candidates[candidate_id].get("font_label"), "font label"),
        "image": {
            "height": artifact.get("height"),
            "path": _text(artifact.get("file"), "render file"),
            "sha256": _text(artifact.get("sha256"), "render sha"),
            "width": artifact.get("width"),
        },
        "prior_tier": prior_tier,
        "probe_id": probe,
        "writing_mode": mode,
    }


def _prepare_rows(
    selected: Sequence[trainer.HumanExample],
    fast_rows: Mapping[str, Mapping[str, Any]],
    *,
    candidates: Mapping[str, Mapping[str, Any]],
    renders: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, example in enumerate(selected, 1):
        base = example.row
        judgment = _mapping(base.get("font_judgment"), "base judgment")
        role = _text(_mapping(base.get("role"), "base role").get("primary"), "role")
        orientation = _text(
            _mapping(base.get("treatment"), "base treatment").get("orientation"),
            "orientation",
        )
        fast = fast_rows[example.sample_id]
        candidate_rows = [
            _render_descriptor(
                candidate_id,
                role=role,
                orientation=orientation,
                candidates=candidates,
                renders=renders,
                prior_tier=_candidate_tier(judgment, candidate_id),
            )
            for candidate_id in EXPECTED_IDS
        ]
        rows.append(
            trainer.seal_record(
                {
                    "base_train_record_sha256": base["record_sha256"],
                    "candidate_ids": list(EXPECTED_IDS),
                    "candidates": candidate_rows,
                    "chapter": copy.deepcopy(fast.get("chapter")),
                    "cohorts": copy.deepcopy(base.get("cohorts", [])),
                    "fast_review_record_sha256": fast["record_sha256"],
                    "model_reference": {
                        "pass_summaries": copy.deepcopy(fast.get("pass_summaries")),
                        "top5_candidates": [
                            {
                                "candidate_id": candidate.get("candidate_id"),
                                "aggregate": copy.deepcopy(candidate.get("aggregate")),
                            }
                            for candidate in fast.get("candidates", [])
                        ],
                    },
                    "page": copy.deepcopy(fast.get("page")),
                    "prior_font_judgment": copy.deepcopy(judgment),
                    "record_type": "manga_font_named_train_review_item",
                    "role": copy.deepcopy(base.get("role")),
                    "rowcard": None,
                    "sample_id": example.sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "selection_rank": index,
                    "source": copy.deepcopy(base.get("source")),
                    "source_style": copy.deepcopy(base.get("source_style")),
                    "split": "train",
                    "treatment": copy.deepcopy(base.get("treatment")),
                    "work": copy.deepcopy(fast.get("work")),
                    "work_id": example.work_id,
                }
            )
        )
    return rows


def _render_rowcards(
    rows: Sequence[dict[str, Any]],
    *,
    output_dir: Path,
    catalog_registry: Path,
    render_bank_root: Path,
    canonical_candidates: Mapping[str, Mapping[str, Any]],
    project_root: Path,
) -> list[dict[str, Any]]:
    cards = output_dir / ROWCARDS_DIR
    cards.mkdir(parents=True)
    resolver = catalog_assets.CatalogAssetResolver(catalog_registry)
    font_path = named_review._annotation_font_path(canonical_candidates, project_root)  # noqa: SLF001
    title_font = named_review._font(27, font_path)  # noqa: SLF001
    body_font = named_review._font(16, font_path)  # noqa: SLF001
    small_font = named_review._font(13, font_path)  # noqa: SLF001
    left_width, cell_width, header_height, lane_height = 620, 230, 100, 340
    width, height = left_width + cell_width * 11, header_height + lane_height * 2
    result: list[dict[str, Any]] = []
    for index, row in enumerate(rows, 1):
        canvas = Image.new("RGB", (width, height), (245, 247, 250))
        draw = ImageDraw.Draw(canvas)
        draw.text(
            (18, 12),
            f"TRAIN-ONLY NAMED REVIEW {index:02d}/{len(rows):02d}  {row['sample_id']}",
            fill=(18, 23, 31),
            font=title_font,
        )
        draw.text(
            (18, 55),
            f"role={row['role']['primary']}  work={row['work'].get('title','')}  chapter={row['chapter'].get('title','')}",
            fill=(54, 61, 72),
            font=body_font,
        )
        views: dict[str, Image.Image] = {}
        for view_name in trainer.VIEW_NAMES:
            try:
                with resolver.resolve_sample_view(row, view_name) as resolved:
                    views[view_name] = resolved.image.copy()
            except catalog_assets.CatalogAssetError as error:
                raise NamedTrainReviewError(str(error)) from error
        named_review._fit_paste(canvas, views["raw_224"], (18, 122, 292, 400))  # noqa: SLF001
        named_review._fit_paste(canvas, views["context_224"], (315, 122, 598, 400))  # noqa: SLF001
        named_review._fit_paste(canvas, views["glyph_224"], (165, 438, 450, 755))  # noqa: SLF001
        draw.text((18, 103), "RAW", fill=(32, 38, 48), font=small_font)
        draw.text((315, 103), "CONTEXT", fill=(32, 38, 48), font=small_font)
        draw.text((165, 416), "GLYPH", fill=(32, 38, 48), font=small_font)
        for image in views.values():
            image.close()
        for candidate_index, candidate in enumerate(row["candidates"]):
            lane, column = divmod(candidate_index, 11)
            left = left_width + column * cell_width
            top = header_height + lane * lane_height
            tier = candidate["prior_tier"]
            color = named_review.TIER_COLORS[tier]
            draw.rectangle(
                (left + 3, top + 4, left + cell_width - 4, top + lane_height - 5),
                fill=(255, 255, 255),
                outline=color,
                width=3,
            )
            draw.text(
                (left + 9, top + 12),
                f"{candidate_index + 1:02d} {candidate['candidate_id'][:22]}",
                fill=(20, 24, 30),
                font=small_font,
            )
            draw.text(
                (left + 9, top + 36),
                candidate["font_label"][:20],
                fill=(45, 50, 58),
                font=small_font,
            )
            render = named_review._load_render_image(render_bank_root, candidate)  # noqa: SLF001
            named_review._fit_paste(  # noqa: SLF001
                canvas,
                render,
                (left + 9, top + 64, left + cell_width - 9, top + lane_height - 42),
            )
            render.close()
            draw.text(
                (left + 9, top + lane_height - 31),
                f"prior: {tier}",
                fill=color,
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
        result.append(descriptor)
        row["rowcard"] = copy.deepcopy(descriptor)
        row.pop("record_sha256", None)
        row.update(trainer.seal_record(row))
    return result


def _load_base(
    base_export: Path, catalog_registry: Path
) -> trainer.HumanSnapshot:
    return trainer.validate_human_input(
        base_export,
        candidate_ids=EXPECTED_IDS,
        catalog_registry_sha256=trainer.sha256_file(catalog_registry),
    )


def build_review(
    *,
    base_export: Path,
    fast_bundle: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    output_dir: Path,
    count: int,
    excluded_sample_ids: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    output = _safe_output(output_dir)
    if output.exists():
        raise NamedTrainReviewError("review output already exists")
    snapshot = _load_base(base_export, catalog_registry)
    selected = _select_examples(
        snapshot.train_examples,
        count=count,
        excluded_sample_ids=excluded_sample_ids,
    )
    fast_rows, isolation = _load_fast_references(
        fast_bundle, selected_ids={example.sample_id for example in selected}
    )
    canonical_candidates, renders = named_review.load_render_bank(render_bank_manifest)
    rows = _prepare_rows(
        selected, fast_rows, candidates=canonical_candidates, renders=renders
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
        _write_jsonl(staging / REVIEW_FILE, rows)
        template = {
            row["sample_id"]: {
                "acceptable": [],
                "confidence": None,
                "marginal": [],
                "notes": "",
                "preferred": [],
            }
            for row in rows
        }
        (staging / TEMPLATE_FILE).write_bytes(trainer.json_bytes(template, pretty=True))
        works = Counter(row["work_id"] for row in rows)
        chapters = Counter(str(row["chapter"].get("id")) for row in rows)
        roles = Counter(str(row["role"].get("primary")) for row in rows)
        report = trainer.seal_record(
            {
                "artifacts": {
                    REVIEW_FILE: _descriptor(staging / REVIEW_FILE, count=len(rows)),
                    TEMPLATE_FILE: _descriptor(staging / TEMPLATE_FILE),
                },
                "boundary": {
                    "base_hidden_test_pixels_opened": 0,
                    "base_hidden_test_rows_json_deserialized": 0,
                    "future_qa_40x2_exclusion": "entire_master_manifest_is_reserved_from_qa_selection",
                    "selected_split": "train",
                    "val33_rows_selected": 0,
                },
                "candidate_ids": list(EXPECTED_IDS),
                "inputs": {
                    "base_manifest_sha256": snapshot.manifest_sha256,
                    "base_samples_sha256": snapshot.samples_sha256,
                    "catalog_registry_sha256": trainer.sha256_file(catalog_registry),
                    "render_bank_manifest_sha256": trainer.sha256_file(render_bank_manifest),
                    **isolation,
                },
                "selection": {
                    "excluded_sample_ids": sorted(excluded_sample_ids),
                    "sample_crop_sha256_unique": True,
                },
                "record_type": "manga_font_named_train_review_report",
                "rowcards": cards,
                "schema_version": SCHEMA_VERSION,
                "stats": {
                    "chapter_count": len(chapters),
                    "max_per_chapter": max(chapters.values()),
                    "max_per_work": max(works.values()),
                    "record_count": len(rows),
                    "role_counts": dict(sorted(roles.items())),
                    "variant_count": sum(_eligible_variant(row) for row in rows),
                    "work_count": len(works),
                },
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
        if output.exists():
            raise NamedTrainReviewError("review output appeared during build")
        os.rename(staging, output)
        published = True
        return validate_review(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_review(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = trainer.read_json(root / REPORT_FILE, location="named train report")
    trainer.validate_record_seal(report, location="named train report")
    marker = trainer.read_json(root / MARKER_FILE, location="named train marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("report_sha256") != trainer.sha256_file(root / REPORT_FILE)
        or report.get("schema_version") != SCHEMA_VERSION
        or report.get("candidate_ids") != list(EXPECTED_IDS)
    ):
        raise NamedTrainReviewError("review metadata drifted")
    rows: list[dict[str, Any]] = []
    with (root / REVIEW_FILE).open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            row = dict(_mapping(json.loads(line), f"review:{number}"))
            trainer.validate_record_seal(row, location=f"review:{number}")
            if row.get("split") != "train" or row.get("candidate_ids") != list(
                EXPECTED_IDS
            ):
                raise NamedTrainReviewError("review train/candidate boundary drifted")
            card = _mapping(row.get("rowcard"), "rowcard")
            path = root / _text(card.get("file"), "rowcard.file")
            if trainer.sha256_file(path) != card.get("sha256"):
                raise NamedTrainReviewError("rowcard hash drifted")
            rows.append(row)
    if len(rows) != report["stats"]["record_count"] or len(rows) != len(
        {row["sample_id"] for row in rows}
    ):
        raise NamedTrainReviewError("review identity count drifted")
    return {
        "output_dir": str(root),
        "record_count": len(rows),
        "status": "ready_for_named_train_judgment",
    }


def _partition(entry: Mapping[str, Any], *, sample_id: str) -> dict[str, Any]:
    chosen: dict[str, list[str]] = {}
    flattened: list[str] = []
    for tier in ("preferred", "acceptable", "marginal"):
        values = [_text(value, f"{sample_id}.{tier}") for value in _list(entry.get(tier), f"{sample_id}.{tier}")]
        if len(values) != len(set(values)):
            raise NamedTrainReviewError(f"{sample_id}: duplicate {tier}")
        chosen[tier] = values
        flattened.extend(values)
    if not flattened or len(flattened) != len(set(flattened)) or not set(flattened) <= set(EXPECTED_IDS):
        raise NamedTrainReviewError(f"{sample_id}: invalid named partition")
    unacceptable = [value for value in EXPECTED_IDS if value not in set(flattened)]
    return {
        "acceptable": chosen["acceptable"],
        "marginal": chosen["marginal"],
        "none_acceptable": not bool(chosen["preferred"] or chosen["acceptable"]),
        "not_reviewed": [],
        "preferred": chosen["preferred"],
        "unacceptable": unacceptable,
        "unrenderable": [],
    }


def build_overlay(
    *,
    review_dir: Path,
    judgments_path: Path,
    base_export: Path,
    catalog_registry: Path,
    output_dir: Path,
    reviewer: str,
) -> dict[str, Any]:
    review_validation = validate_review(review_dir)
    review_root = review_dir.expanduser().resolve()
    judgments = trainer.read_json(judgments_path, location="named train judgments")
    snapshot = _load_base(base_export, catalog_registry)
    base_by_id = {example.sample_id: example for example in snapshot.train_examples}
    review_rows = [
        json.loads(line)
        for line in (review_root / REVIEW_FILE).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    sample_ids = [str(row["sample_id"]) for row in review_rows]
    if set(judgments) != set(sample_ids) or len(judgments) != len(sample_ids):
        raise NamedTrainReviewError("judgments must cover the review set exactly")
    overlay_rows: list[dict[str, Any]] = []
    queue: list[dict[str, Any]] = []
    for review_row in review_rows:
        sample_id = str(review_row["sample_id"])
        entry = _mapping(judgments[sample_id], f"judgments.{sample_id}")
        confidence = float(entry.get("confidence"))
        if not 0.0 <= confidence <= 1.0:
            raise NamedTrainReviewError(f"{sample_id}: invalid confidence")
        partition = _partition(entry, sample_id=sample_id)
        base = base_by_id.get(sample_id)
        if base is None or base.row["record_sha256"] != review_row["base_train_record_sha256"]:
            raise NamedTrainReviewError(f"{sample_id}: base train authority drifted")
        row = copy.deepcopy(dict(base.row))
        original_sha = str(row.pop("record_sha256"))
        prior = copy.deepcopy(row["font_judgment"])
        row["font_judgment"] = partition
        provenance = dict(_mapping(row.get("provenance"), "provenance"))
        provenance["named_train_review_overlay"] = {
            "base_train_record_sha256": original_sha,
            "font_judgment_only": True,
            "human_named_review": True,
            "review_item_sha256": review_row["record_sha256"],
            "schema_version": OVERLAY_SCHEMA_VERSION,
            "test_data_used": False,
        }
        row["provenance"] = provenance
        review_provenance = dict(_mapping(row.get("review_provenance"), "review provenance"))
        review_provenance["named_train_review_overlay"] = {
            "confidence": confidence,
            "notes": str(entry.get("notes", "")),
            "reviewer": reviewer,
            "rowcard_sha256": review_row["rowcard"]["sha256"],
            "schema_version": OVERLAY_SCHEMA_VERSION,
        }
        row["review_provenance"] = review_provenance
        row = trainer.seal_record(row)
        trainer._validate_human_row(  # noqa: SLF001
            row,
            split="train",
            candidate_ids=EXPECTED_IDS,
            catalog_registry_sha256=trainer.sha256_file(catalog_registry),
            location=f"named overlay {sample_id}",
        )
        overlay_rows.append(row)
        prior_positive = set(prior["preferred"]) | set(prior["acceptable"])
        new_positive = set(partition["preferred"]) | set(partition["acceptable"])
        if prior != partition or confidence < 0.93:
            queue.append(
                trainer.seal_record(
                    {
                        "confidence": confidence,
                        "new_positive": sorted(new_positive),
                        "new_preferred": list(partition["preferred"]),
                        "notes": str(entry.get("notes", "")),
                        "prior_positive": sorted(prior_positive),
                        "prior_preferred": list(prior["preferred"]),
                        "reason": [
                            reason
                            for reason, active in (
                                ("partition_changed", prior != partition),
                                ("low_confidence", confidence < 0.93),
                            )
                            if active
                        ],
                        "record_type": "manga_font_named_train_secondary_review_item",
                        "review_item_sha256": review_row["record_sha256"],
                        "sample_id": sample_id,
                        "schema_version": OVERLAY_SCHEMA_VERSION,
                        "split": "train",
                    }
                )
            )
    output = _safe_output(output_dir)
    if output.exists():
        raise NamedTrainReviewError("overlay output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        _write_jsonl(staging / OVERLAY_FILE, overlay_rows)
        _write_jsonl(staging / QUEUE_FILE, queue)
        report = trainer.seal_record(
            {
                "artifacts": {
                    OVERLAY_FILE: _descriptor(staging / OVERLAY_FILE, count=len(overlay_rows)),
                    QUEUE_FILE: _descriptor(staging / QUEUE_FILE, count=len(queue)),
                },
                "bindings": {
                    "base_manifest_sha256": snapshot.manifest_sha256,
                    "base_samples_sha256": snapshot.samples_sha256,
                    "judgments_sha256": trainer.sha256_file(judgments_path),
                    "review_report_sha256": trainer.sha256_file(review_root / REPORT_FILE),
                },
                "checks": {
                    "base_hidden_test_pixels_opened": 0,
                    "base_hidden_test_rows_json_deserialized": 0,
                    "modified_field_scope": "font_judgment_plus_provenance_only",
                    "overlay_split": "train",
                    "val_rows_modified": 0,
                },
                "record_count": len(overlay_rows),
                "record_type": "manga_font_named_train_overlay_report",
                "review_record_count": review_validation["record_count"],
                "schema_version": OVERLAY_SCHEMA_VERSION,
                "secondary_review_queue_count": len(queue),
            }
        )
        (staging / REPORT_FILE).write_bytes(trainer.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {
                REPORT_FILE: trainer.sha256_file(staging / REPORT_FILE),
                OVERLAY_FILE: trainer.sha256_file(staging / OVERLAY_FILE),
                QUEUE_FILE: trainer.sha256_file(staging / QUEUE_FILE),
            },
            "owner": OVERLAY_OWNER,
            "safe_replace": True,
            "schema_version": OVERLAY_SCHEMA_VERSION,
        }
        (staging / OVERLAY_MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))
        if output.exists():
            raise NamedTrainReviewError("overlay output appeared during build")
        os.rename(staging, output)
        published = True
        return validate_overlay(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_overlay(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    marker = trainer.read_json(root / OVERLAY_MARKER_FILE, location="overlay marker")
    report = trainer.read_json(root / REPORT_FILE, location="overlay report")
    trainer.validate_record_seal(report, location="overlay report")
    if marker.get("owner") != OVERLAY_OWNER or report.get("schema_version") != OVERLAY_SCHEMA_VERSION:
        raise NamedTrainReviewError("overlay metadata drifted")
    for name, expected in _mapping(marker.get("artifacts"), "overlay marker artifacts").items():
        if trainer.sha256_file(root / name) != expected:
            raise NamedTrainReviewError(f"overlay artifact hash drifted: {name}")
    rows = 0
    with (root / OVERLAY_FILE).open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            row = dict(_mapping(json.loads(line), f"overlay:{number}"))
            trainer.validate_record_seal(row, location=f"overlay:{number}")
            if row.get("split") != "train":
                raise NamedTrainReviewError("overlay contains non-train row")
            rows += 1
    if rows != report.get("record_count"):
        raise NamedTrainReviewError("overlay record count drifted")
    return {
        "output_dir": str(root),
        "record_count": rows,
        "secondary_review_queue_count": report.get("secondary_review_queue_count"),
        "status": "ready_for_train_only_merge",
    }


def _assert_overlay_scope(
    base_row: Mapping[str, Any], overlay_row: Mapping[str, Any], *, sample_id: str
) -> None:
    immutable_keys = set(base_row) - {
        "font_judgment",
        "provenance",
        "record_sha256",
        "review_provenance",
    }
    if set(overlay_row) != set(base_row) or any(
        overlay_row.get(key) != base_row.get(key) for key in immutable_keys
    ):
        raise NamedTrainReviewError(
            f"{sample_id}: overlay changed identity, pixels, or auxiliary labels"
        )
    base_provenance = dict(_mapping(base_row.get("provenance"), "base provenance"))
    overlay_provenance = dict(
        _mapping(overlay_row.get("provenance"), "overlay provenance")
    )
    named_provenance = overlay_provenance.pop("named_train_review_overlay", None)
    if overlay_provenance != base_provenance or not isinstance(
        named_provenance, Mapping
    ):
        raise NamedTrainReviewError(f"{sample_id}: provenance scope drifted")
    if (
        named_provenance.get("base_train_record_sha256")
        != base_row.get("record_sha256")
        or named_provenance.get("font_judgment_only") is not True
        or named_provenance.get("human_named_review") is not True
        or named_provenance.get("test_data_used") is not False
    ):
        raise NamedTrainReviewError(f"{sample_id}: named review authority drifted")
    base_review = dict(
        _mapping(base_row.get("review_provenance"), "base review provenance")
    )
    overlay_review = dict(
        _mapping(overlay_row.get("review_provenance"), "overlay review provenance")
    )
    named_review_provenance = overlay_review.pop(
        "named_train_review_overlay", None
    )
    if overlay_review != base_review or not isinstance(
        named_review_provenance, Mapping
    ):
        raise NamedTrainReviewError(f"{sample_id}: review provenance scope drifted")
    if named_review_provenance.get("schema_version") != OVERLAY_SCHEMA_VERSION:
        raise NamedTrainReviewError(f"{sample_id}: review provenance schema drifted")


def apply_train_overlay(
    snapshot: trainer.HumanSnapshot,
    *,
    overlay_dir: Path,
    catalog_registry: Path,
    candidate_ids: tuple[str, ...] = EXPECTED_IDS,
    expected_replacements: int = 48,
) -> tuple[trainer.HumanSnapshot, dict[str, Any]]:
    """Replace exactly the named train rows while preserving val/test authority."""

    if tuple(candidate_ids) != EXPECTED_IDS:
        raise NamedTrainReviewError("train overlay candidate order drifted")
    # A caller may already have applied a separately sealed validation-only
    # overlay.  In that case ``snapshot.samples_sha256`` deliberately names the
    # combined validation authority rather than the immutable source export.
    # Reload the source named by the snapshot and bind this train overlay to
    # that authority; then prove that the caller has not changed any train row.
    authority_snapshot = _load_base(snapshot.root, catalog_registry)
    if (
        snapshot.root.expanduser().resolve() != authority_snapshot.root
        or snapshot.manifest_sha256 != authority_snapshot.manifest_sha256
        or snapshot.marker_sha256 != authority_snapshot.marker_sha256
        or snapshot.report_sha256 != authority_snapshot.report_sha256
        or snapshot.skipped_test_rows != authority_snapshot.skipped_test_rows
        or snapshot.train_examples != authority_snapshot.train_examples
    ):
        raise NamedTrainReviewError(
            "input snapshot train authority drifted from its sealed base export"
        )
    validation = validate_overlay(overlay_dir)
    root = overlay_dir.expanduser().resolve()
    report = trainer.read_json(root / REPORT_FILE, location="overlay report")
    bindings = _mapping(report.get("bindings"), "overlay report.bindings")
    if (
        bindings.get("base_manifest_sha256") != authority_snapshot.manifest_sha256
        or bindings.get("base_samples_sha256") != authority_snapshot.samples_sha256
        or validation.get("record_count") != expected_replacements
    ):
        raise NamedTrainReviewError("overlay/base authority binding drifted")
    registry_sha = trainer.sha256_file(catalog_registry.expanduser().resolve())
    base_by_id = {example.sample_id: example for example in snapshot.train_examples}
    overlay_by_id: dict[str, trainer.HumanExample] = {}
    with (root / OVERLAY_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = dict(_mapping(json.loads(line), f"train overlay:{line_number}"))
            trainer.validate_record_seal(row, location=f"train overlay:{line_number}")
            sample_id = _text(row.get("sample_id"), "train overlay.sample_id")
            base_example = base_by_id.get(sample_id)
            if base_example is None or sample_id in overlay_by_id:
                raise NamedTrainReviewError(
                    f"{sample_id}: overlay is not a unique base-train replacement"
                )
            _assert_overlay_scope(base_example.row, row, sample_id=sample_id)
            overlay_by_id[sample_id] = trainer._validate_human_row(  # noqa: SLF001
                row,
                split="train",
                candidate_ids=candidate_ids,
                catalog_registry_sha256=registry_sha,
                location=f"applied named train overlay:{line_number}",
            )
    if len(overlay_by_id) != expected_replacements:
        raise NamedTrainReviewError(
            f"expected {expected_replacements} train replacements, found {len(overlay_by_id)}"
        )
    merged_train = tuple(
        overlay_by_id.get(example.sample_id, example) for example in snapshot.train_examples
    )
    preserved = sum(
        merged is original
        for merged, original in zip(merged_train, snapshot.train_examples, strict=True)
    )
    if (
        len(merged_train) != len(snapshot.train_examples)
        or preserved != len(snapshot.train_examples) - expected_replacements
        or tuple(example.sample_id for example in merged_train)
        != tuple(example.sample_id for example in snapshot.train_examples)
    ):
        raise NamedTrainReviewError("base train order/count preservation failed")
    merged = trainer.HumanSnapshot(
        root=snapshot.root,
        train_examples=merged_train,
        val_examples=snapshot.val_examples,
        skipped_test_rows=snapshot.skipped_test_rows,
        marker_sha256=snapshot.marker_sha256,
        manifest_sha256=snapshot.manifest_sha256,
        report_sha256=snapshot.report_sha256,
        samples_sha256=snapshot.samples_sha256,
    )
    result = {
        **validation,
        "base_train_record_count": len(snapshot.train_examples),
        "hidden_test_labels_deserialized": 0,
        "hidden_test_pixels_opened": 0,
        "preserved_train_record_count": preserved,
        "replaced_train_record_count": len(overlay_by_id),
        "status": "ready_for_train_only_merge",
        "val_record_count_unchanged": len(snapshot.val_examples),
        "val_rows_modified": 0,
        "view_bindings_modified": 0,
    }
    return merged, result


def preflight_apply(
    *,
    overlay_dir: Path,
    base_export: Path,
    catalog_registry: Path,
    expected_replacements: int = 48,
) -> dict[str, Any]:
    snapshot = _load_base(base_export, catalog_registry)
    _merged, result = apply_train_overlay(
        snapshot,
        overlay_dir=overlay_dir,
        catalog_registry=catalog_registry,
        expected_replacements=expected_replacements,
    )
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-review")
    build.add_argument("--base-export", type=Path, required=True)
    build.add_argument("--fast-bundle", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--render-bank-manifest", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--count", type=int, default=48)
    build.add_argument("--exclude-sample-id", action="append", default=[])
    validate = commands.add_parser("validate-review")
    validate.add_argument("--output-dir", type=Path, required=True)
    promote = commands.add_parser("build-overlay")
    promote.add_argument("--review-dir", type=Path, required=True)
    promote.add_argument("--judgments", type=Path, required=True)
    promote.add_argument("--base-export", type=Path, required=True)
    promote.add_argument("--catalog-registry", type=Path, required=True)
    promote.add_argument("--output-dir", type=Path, required=True)
    promote.add_argument("--reviewer", default="codex-named-variant-train-review-v1")
    overlay = commands.add_parser("validate-overlay")
    overlay.add_argument("--output-dir", type=Path, required=True)
    apply = commands.add_parser("preflight-apply")
    apply.add_argument("--overlay-dir", type=Path, required=True)
    apply.add_argument("--base-export", type=Path, required=True)
    apply.add_argument("--catalog-registry", type=Path, required=True)
    apply.add_argument("--expected-replacements", type=int, default=48)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build-review":
            result = build_review(
                base_export=args.base_export,
                fast_bundle=args.fast_bundle,
                catalog_registry=args.catalog_registry,
                render_bank_manifest=args.render_bank_manifest,
                output_dir=args.output_dir,
                count=args.count,
                excluded_sample_ids=frozenset(args.exclude_sample_id),
            )
        elif args.command == "validate-review":
            result = validate_review(args.output_dir)
        elif args.command == "build-overlay":
            result = build_overlay(
                review_dir=args.review_dir,
                judgments_path=args.judgments,
                base_export=args.base_export,
                catalog_registry=args.catalog_registry,
                output_dir=args.output_dir,
                reviewer=args.reviewer,
            )
        elif args.command == "validate-overlay":
            result = validate_overlay(args.output_dir)
        else:
            result = preflight_apply(
                overlay_dir=args.overlay_dir,
                base_export=args.base_export,
                catalog_registry=args.catalog_registry,
                expected_replacements=args.expected_replacements,
            )
    except (NamedTrainReviewError, trainer.MangaFontStudentError, OSError) as error:
        raise SystemExit(f"named train review error: {error}") from error
    print(trainer.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
