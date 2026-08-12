#!/usr/bin/env python3
"""Build, deblind, seal, and validate baseline40 development corrections.

This tool intentionally converts the v9 ``baseline40`` cohort from QA evidence
into development-only direct visual supervision.  It never reads labels from or
writes to the v10 holdout.  The visual pack is pairwise and blind: sheets and
the public queue contain only ORIGINAL / OPTION A / OPTION B.  Candidate IDs,
model names, selected fonts, scores, and predicted roles live only in a private
binding which is opened by ``seal`` after all visual decisions are complete.

The output contract is fail-closed:

* all 35 r3h/r4a25 font-changed blocks are selected;
* every block from the configured stable-bad anchor pages is also selected;
* output directories are never overwritten;
* the v10 holdout descriptors must still match at validation time; and
* sealed labels have no calibration, evaluation, release, or promotion authority.
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image, ImageDraw, ImageFont, ImageOps


TOOL_ID = "manga-font-baseline40-development-correction"
TOOL_VERSION = "1.1.0"
SCHEMA_VERSION = 1
ANCHOR_PAGES = (3, 5, 6, 13, 16, 28, 30, 32, 38)
EXPECTED_CHANGED_BLOCKS = 35
ROWS_PER_SHEET = 4
BLIND_QUEUE = "blind-queue.jsonl"
PRIVATE_BINDING = "private-deblind-binding.json"
REVIEW_TEMPLATE = "direct-visual-review.jsonl"
SEALED_LABELS = "training-labels.jsonl"
MANIFEST = "manifest.json"
REPORT = "report.json"
INVALIDATION = "BASELINE40-INVALIDATED-AS-HOLDOUT.json"
SEAL = "SHA256SUMS.json"
POSTBLIND_ADJUDICATIONS = "postblind-adjudications.jsonl"
ACTIONABLE_CORRECTIONS = "actionable-corrections.json"
AUTHORITY = {
    "review_authority": "codex_agent_direct_visual_supervision",
    "training_eligible": True,
    "training_only": True,
    "development_only": True,
    "human_gold": False,
    "calibration_eligible": False,
    "evaluation_eligible": False,
    "automatic_release_authority": False,
    "automatic_label_promotion_allowed": False,
}
ALLOWED_PREFERENCES = {
    "option_a",
    "option_b",
    "both_acceptable",
    "none_acceptable",
}
ALLOWED_VISUAL_INTENTS = {"normal", "emphasis"}
ALLOWED_CONSISTENCY = {
    "match_page_body",
    "intentional_variant",
    "neutral_independent",
}
ALLOWED_PAIRWISE_OUTCOMES = {
    "both_bad",
    "candidate_improvement",
    "candidate_regression",
    "neutral",
    "stable_anchor_acceptable",
    "stable_anchor_bad",
}
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class CorrectionError(RuntimeError):
    """Raised when the correction-set contract is not satisfied."""


@dataclass(frozen=True)
class BuildOptions:
    baseline_report: Path
    candidate_report: Path
    comparison: Path
    output_dir: Path
    v10_holdout_manifest: Path
    v10_selection: Path
    anchor_pages: tuple[int, ...] = ANCHOR_PAGES
    rows_per_sheet: int = ROWS_PER_SHEET


def canonical_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CorrectionError(f"invalid {label}: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise CorrectionError(f"{label} must be an object: {path}")
    return value


def iter_jsonl(path: Path, label: str) -> Iterable[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise CorrectionError(f"could not read {label}: {path}: {exc}") from exc
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CorrectionError(
                f"invalid {label} JSON at line {line_number}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise CorrectionError(f"{label} line {line_number} must be an object")
        yield value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = b"".join(canonical_bytes(dict(row)) + b"\n" for row in rows)
    path.write_bytes(payload)


def descriptor(
    path: Path,
    *,
    row_count: int | None = None,
    declared_path: Path | None = None,
) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    result: dict[str, Any] = {
        "path": str((declared_path or resolved).resolve()),
        "size": resolved.stat().st_size,
        "sha256": sha256_file(resolved),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def seal_record(value: Mapping[str, Any]) -> dict[str, Any]:
    body = copy.deepcopy(dict(value))
    body.pop("record_sha256", None)
    body["record_sha256"] = sha256_bytes(canonical_bytes(body))
    return body


def _validate_seal_record(value: Mapping[str, Any], label: str) -> None:
    expected = _required_text(value.get("record_sha256"), f"{label}.record_sha256")
    body = copy.deepcopy(dict(value))
    body.pop("record_sha256", None)
    actual = sha256_bytes(canonical_bytes(body))
    if not SHA_RE.fullmatch(expected) or actual != expected:
        raise CorrectionError(f"{label} record hash drifted")


def _validate_candidate_labels(value: Any, label: str) -> None:
    if not isinstance(value, Mapping):
        raise CorrectionError(f"{label} must be an object")
    preferred = value.get("preferred_candidate_ids")
    positives = value.get("positive_candidate_ids")
    rejected = value.get("rejected_candidate_ids")
    none_acceptable = value.get("none_acceptable")
    if not all(isinstance(item, list) for item in (preferred, positives, rejected)):
        raise CorrectionError(f"{label} candidate ID fields must be lists")
    for field_name, items in (
        ("preferred_candidate_ids", preferred),
        ("positive_candidate_ids", positives),
        ("rejected_candidate_ids", rejected),
    ):
        if any(not isinstance(item, str) or not item for item in items):
            raise CorrectionError(f"{label}.{field_name} contains an invalid ID")
        if len(items) != len(set(items)):
            raise CorrectionError(f"{label}.{field_name} contains duplicates")
    if not set(preferred).issubset(positives):
        raise CorrectionError(f"{label} preferred IDs must be positive IDs")
    if set(positives) & set(rejected):
        raise CorrectionError(f"{label} positive/rejected IDs overlap")
    if not isinstance(none_acceptable, bool):
        raise CorrectionError(f"{label}.none_acceptable must be boolean")
    if none_acceptable != (not positives):
        raise CorrectionError(f"{label} none_acceptable disagrees with positives")
    if value.get("pairwise_only") is not True:
        raise CorrectionError(f"{label}.pairwise_only must stay true")


def _summarize_labels(labels: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    dispositions: Counter[str] = Counter()
    positive_fonts: Counter[str] = Counter()
    rejected_fonts: Counter[str] = Counter()
    for row in labels:
        candidates = row["candidate_labels"]
        positives = list(candidates["positive_candidate_ids"])
        rejected = list(candidates["rejected_candidate_ids"])
        if candidates["none_acceptable"]:
            dispositions["none_acceptable"] += 1
        elif len(positives) > 1:
            dispositions["both_acceptable"] += 1
        else:
            dispositions["single_preferred"] += 1
        positive_fonts.update(positives)
        rejected_fonts.update(rejected)
    return {
        "rows": len(labels),
        "font_changed_rows": sum(
            row.get("selection_reason") == "font_changed_pair" for row in labels
        ),
        "stable_bad_anchor_rows": sum(
            row.get("selection_reason") == "stable_bad_anchor" for row in labels
        ),
        "label_dispositions": dict(sorted(dispositions.items())),
        "pairwise_outcomes": dict(
            sorted(Counter(str(row["pairwise_outcome"]) for row in labels).items())
        ),
        "visual_intents": dict(
            sorted(Counter(str(row["visual_intent"]) for row in labels).items())
        ),
        "page_consistency_intents": dict(
            sorted(
                Counter(str(row["page_consistency_intent"]) for row in labels).items()
            )
        ),
        "role_corrections": sum(bool(row.get("role_correction")) for row in labels),
        "positive_font_rows": sum(
            bool(row["candidate_labels"]["positive_candidate_ids"]) for row in labels
        ),
        "none_acceptable_rows": sum(
            bool(row["candidate_labels"]["none_acceptable"]) for row in labels
        ),
        "positive_font_counts": dict(sorted(positive_fonts.items())),
        "rejected_font_counts": dict(sorted(rejected_fonts.items())),
    }


def _required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CorrectionError(f"missing {label}")
    return value


def _resolve_file(value: Any, run_dir: Path, label: str) -> Path:
    raw = Path(_required_text(value, label))
    path = raw if raw.is_absolute() else run_dir / raw
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise CorrectionError(f"missing {label}: {path}: {exc}") from exc
    if not resolved.is_file():
        raise CorrectionError(f"{label} is not a regular file: {resolved}")
    return resolved


def _load_completed_report(path: Path, label: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    resolved = path.expanduser().resolve(strict=True)
    report = read_json(resolved, label)
    if report.get("status") != "completed" or report.get("pageCount") != 40:
        raise CorrectionError(f"{label} must be a completed 40-page report")
    if report.get("cohort") != "baseline40":
        raise CorrectionError(f"{label} must use baseline40")
    pages = report.get("pages")
    if not isinstance(pages, list) or len(pages) != 40:
        raise CorrectionError(f"{label} page coverage is incomplete")
    ordered = sorted(pages, key=lambda row: int(row.get("selectionIndex", -1)))
    if [int(row.get("selectionIndex", -1)) for row in ordered] != list(range(40)):
        raise CorrectionError(f"{label} selection indexes drifted")
    for page_number, page in enumerate(ordered, start=1):
        if page.get("status") != "completed" or page.get("stage") != "done":
            raise CorrectionError(f"{label} page {page_number} is incomplete")
        decisions = page.get("fontDecisions")
        if not isinstance(decisions, list) or len(decisions) != page.get("blockCount"):
            raise CorrectionError(f"{label} page {page_number} block coverage drifted")
        for block_index, decision in enumerate(decisions):
            if decision.get("blockIndex") != block_index:
                raise CorrectionError(
                    f"{label} page {page_number} block order drifted"
                )
    return report, ordered


def _load_rgb(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        opened.load()
        return ImageOps.exif_transpose(opened).convert("RGB")


def _font_candidates(bold: bool) -> list[Path]:
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    names = ["malgunbd.ttf", "arialbd.ttf"] if bold else ["malgun.ttf", "arial.ttf"]
    return [windows / name for name in names]


def _font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    for path in _font_candidates(bold):
        if path.is_file():
            try:
                return ImageFont.truetype(str(path), size=size)
            except OSError:
                pass
    try:
        return ImageFont.truetype(
            "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size=size
        )
    except OSError:
        return ImageFont.load_default()


def _safe_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    *,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int],
) -> None:
    try:
        draw.text(xy, text, font=font, fill=fill)
    except UnicodeEncodeError:
        draw.text(
            xy,
            text.encode("ascii", "replace").decode("ascii"),
            font=font,
            fill=fill,
        )


def _bbox_crop(
    bbox: Mapping[str, Any], width: int, height: int
) -> tuple[int, int, int, int]:
    values = []
    for key in ("x", "y", "w", "h"):
        value = bbox.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise CorrectionError(f"invalid bbox.{key}")
        values.append(float(value))
    x, y, w, h = values
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1000.001 or y + h > 1000.001:
        raise CorrectionError("bbox exceeds normalized_1000 bounds")
    px = x / 1000 * width
    py = y / 1000 * height
    pw = w / 1000 * width
    ph = h / 1000 * height
    pad_x = max(48.0, pw * 0.95)
    pad_y = max(48.0, ph * 1.15)
    left = max(0, math.floor(px - pad_x))
    top = max(0, math.floor(py - pad_y))
    right = min(width, math.ceil(px + pw + pad_x))
    bottom = min(height, math.ceil(py + ph + pad_y))
    if right <= left or bottom <= top:
        raise CorrectionError("bbox produced an empty crop")
    return left, top, right, bottom


def _paste_contained(
    canvas: Image.Image,
    source: Image.Image,
    box: tuple[int, int, int, int],
) -> None:
    left, top, right, bottom = box
    max_width = right - left
    max_height = bottom - top
    scale = min(max_width / source.width, max_height / source.height)
    size = (
        max(1, round(source.width * scale)),
        max(1, round(source.height * scale)),
    )
    fitted = source.resize(size, Image.Resampling.LANCZOS)
    canvas.paste(
        fitted,
        (left + (max_width - fitted.width) // 2, top + (max_height - fitted.height) // 2),
    )
    fitted.close()


def _page_alias_order(source_page_id: str) -> tuple[str, str]:
    # Stable page-level shuffling allows the reviewer to compare page consistency
    # without revealing which run supplied either option.
    bit = hashlib.sha256(f"blind-page:{source_page_id}".encode()).digest()[0] & 1
    return ("baseline", "candidate") if bit == 0 else ("candidate", "baseline")


def _decision_visible_identity(decision: Mapping[str, Any]) -> dict[str, Any]:
    effective = decision.get("effectiveFontFamily")
    selected = decision.get("selectedFontId")
    return {
        "applied": bool(decision.get("applied")),
        "selected_font_id": selected if isinstance(selected, str) and selected else None,
        "effective_font_id": effective
        if isinstance(effective, str) and effective
        else selected
        if isinstance(selected, str) and selected
        else None,
        "predicted_role": decision.get("role"),
    }


def _render_sheet(
    *,
    path: Path,
    page_number: int,
    sheet_number: int,
    sheet_count: int,
    rows: Sequence[Mapping[str, Any]],
    original: Image.Image,
    option_a: Image.Image,
    option_b: Image.Image,
) -> None:
    width = 1840
    header_height = 112
    row_height = 350
    gap = 10
    height = header_height + len(rows) * row_height + max(0, len(rows) - 1) * gap + 18
    canvas = Image.new("RGB", (width, height), (18, 20, 24))
    draw = ImageDraw.Draw(canvas)
    title_font = _font(30, bold=True)
    label_font = _font(23, bold=True)
    small_font = _font(18)
    _safe_text(
        draw,
        (24, 18),
        f"BLIND DIRECT VISUAL REVIEW · PAGE {page_number:02d} · SHEET {sheet_number}/{sheet_count}",
        font=title_font,
        fill=(240, 244, 249),
    )
    _safe_text(
        draw,
        (24, 65),
        "Judge Japanese visual match first; also mark normal/emphasis and page consistency intent.",
        font=small_font,
        fill=(172, 183, 196),
    )
    panel_width = 566
    panel_height = 268
    panel_x = (22, 637, 1252)
    for local_index, row in enumerate(rows):
        top = header_height + local_index * (row_height + gap)
        draw.rounded_rectangle(
            (12, top, width - 12, top + row_height),
            radius=10,
            fill=(30, 34, 41) if local_index % 2 == 0 else (35, 39, 47),
        )
        review_id = str(row["review_id"])
        block_index = int(row["block_index"])
        labels = (
            f"{review_id} · BLOCK {block_index:02d} · ORIGINAL JP",
            "OPTION A",
            "OPTION B",
        )
        crop = tuple(int(value) for value in row["crop_rect_pixels"])
        crops = (original.crop(crop), option_a.crop(crop), option_b.crop(crop))
        try:
            for x, label, image in zip(panel_x, labels, crops, strict=True):
                _safe_text(
                    draw,
                    (x, top + 12),
                    label,
                    font=label_font,
                    fill=(82, 210, 231),
                )
                box = (x, top + 54, x + panel_width, top + 54 + panel_height)
                draw.rectangle(box, fill=(245, 245, 245), outline=(100, 112, 126), width=2)
                _paste_contained(canvas, image, box)
        finally:
            for image in crops:
                image.close()
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, format="PNG", compress_level=6)
    canvas.close()


def _assert_blind_payload(value: Any, location: str = "blind payload") -> None:
    forbidden_keys = {
        "font_id",
        "font_name",
        "selected_font_id",
        "effective_font_id",
        "predicted_role",
        "confidence",
        "score",
        "baseline",
        "candidate",
        "run_id",
        "model_version",
    }
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = str(key).lower()
            if normalized in forbidden_keys or normalized.endswith("_score"):
                raise CorrectionError(f"{location} leaks private field: {key}")
            _assert_blind_payload(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_blind_payload(child, f"{location}[{index}]")


def _snapshot_v10(holdout: Path, selection: Path) -> dict[str, Any]:
    holdout = holdout.expanduser().resolve(strict=True)
    selection = selection.expanduser().resolve(strict=True)
    return {
        "holdout40_manifest": descriptor(holdout, row_count=sum(1 for _ in iter_jsonl(holdout, "v10 holdout"))),
        "selection": descriptor(selection),
        "contract": {
            "read_for_labels": False,
            "mutated": False,
            "reserved_for_future_evaluation": True,
        },
    }


def build_blind(options: BuildOptions) -> dict[str, Any]:
    output = options.output_dir.expanduser().resolve()
    if output.exists():
        raise CorrectionError(f"output directory already exists: {output}")
    if options.rows_per_sheet < 1 or options.rows_per_sheet > 8:
        raise CorrectionError("rows_per_sheet must be 1..8")
    baseline_report, baseline_pages = _load_completed_report(
        options.baseline_report, "baseline report"
    )
    candidate_report, candidate_pages = _load_completed_report(
        options.candidate_report, "candidate report"
    )
    comparison = read_json(options.comparison.expanduser().resolve(strict=True), "comparison")
    if comparison.get("cohort") != "baseline40":
        raise CorrectionError("comparison must use baseline40")
    changed = comparison.get("selectedFontChangedBlocks")
    if changed != EXPECTED_CHANGED_BLOCKS:
        raise CorrectionError(
            f"expected exactly {EXPECTED_CHANGED_BLOCKS} changed blocks, found {changed}"
        )
    if baseline_report.get("runId") != comparison.get("baseline", {}).get("runId"):
        raise CorrectionError("baseline comparison binding drifted")
    if candidate_report.get("runId") != comparison.get("candidate", {}).get("runId"):
        raise CorrectionError("candidate comparison binding drifted")
    for page_number, (base_page, cand_page) in enumerate(
        zip(baseline_pages, candidate_pages, strict=True), start=1
    ):
        if base_page.get("sourcePageId") != cand_page.get("sourcePageId"):
            raise CorrectionError(f"page {page_number} source identity differs")
        if base_page.get("blockCount") != cand_page.get("blockCount"):
            raise CorrectionError(f"page {page_number} block count differs")

    comparison_blocks = comparison.get("blocks")
    if not isinstance(comparison_blocks, list):
        raise CorrectionError("comparison blocks missing")
    page_number_by_id = {
        str(page["sourcePageId"]): number
        for number, page in enumerate(baseline_pages, start=1)
    }
    selected_keys: set[tuple[str, int]] = set()
    changed_keys: set[tuple[str, int]] = set()
    for block in comparison_blocks:
        key = (str(block.get("sourcePageId")), int(block.get("blockIndex", -1)))
        page_number = page_number_by_id.get(key[0])
        if page_number is None:
            raise CorrectionError("comparison block references an unknown page")
        if block.get("selectedFontChanged") is True:
            changed_keys.add(key)
            selected_keys.add(key)
        if page_number in options.anchor_pages:
            selected_keys.add(key)
    if len(changed_keys) != EXPECTED_CHANGED_BLOCKS:
        raise CorrectionError("comparison changed-block accounting drifted")
    missing_anchor_pages = set(options.anchor_pages) - {
        page_number_by_id.get(page_id) for page_id, _ in selected_keys
    }
    if missing_anchor_pages:
        raise CorrectionError(f"anchor pages have no selected blocks: {missing_anchor_pages}")

    v10 = _snapshot_v10(options.v10_holdout_manifest, options.v10_selection)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        public_rows: list[dict[str, Any]] = []
        private_rows: list[dict[str, Any]] = []
        review_rows: list[dict[str, Any]] = []
        rows_by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)
        input_bindings: list[dict[str, Any]] = []
        row_number = 0
        for page_number, (base_page, cand_page) in enumerate(
            zip(baseline_pages, candidate_pages, strict=True), start=1
        ):
            page_id = str(base_page["sourcePageId"])
            page_keys = sorted(
                (key for key in selected_keys if key[0] == page_id), key=lambda key: key[1]
            )
            if not page_keys:
                continue
            base_run_dir = options.baseline_report.expanduser().resolve(strict=True).parent
            cand_run_dir = options.candidate_report.expanduser().resolve(strict=True).parent
            original_path = _resolve_file(
                base_page.get("stagedOriginalImagePath"), base_run_dir, "source original"
            )
            base_rendered_path = _resolve_file(
                base_page.get("renderedImagePath"), base_run_dir, "baseline rendered"
            )
            cand_rendered_path = _resolve_file(
                cand_page.get("renderedImagePath"), cand_run_dir, "candidate rendered"
            )
            original = _load_rgb(original_path)
            base_rendered = _load_rgb(base_rendered_path)
            cand_rendered = _load_rgb(cand_rendered_path)
            if original.size != base_rendered.size or original.size != cand_rendered.size:
                raise CorrectionError(f"page {page_number} image dimensions differ")
            order = _page_alias_order(page_id)
            alias_images = {
                "A": base_rendered if order[0] == "baseline" else cand_rendered,
                "B": base_rendered if order[1] == "baseline" else cand_rendered,
            }
            input_bindings.append(
                {
                    "page_number": page_number,
                    "source_page_id": page_id,
                    "original": descriptor(original_path),
                    "baseline_rendered": descriptor(base_rendered_path),
                    "candidate_rendered": descriptor(cand_rendered_path),
                }
            )
            try:
                for key in page_keys:
                    row_number += 1
                    block_index = key[1]
                    base_decision = base_page["fontDecisions"][block_index]
                    cand_decision = cand_page["fontDecisions"][block_index]
                    if base_decision.get("blockId") != cand_decision.get("blockId"):
                        raise CorrectionError(f"block identity differs: page {page_number} block {block_index}")
                    review_id = f"B40D-{row_number:03d}"
                    crop_rect = _bbox_crop(base_decision["bbox"], original.width, original.height)
                    crop_relative = f"source-crops/{review_id}.png"
                    crop_path = staging / crop_relative
                    crop_path.parent.mkdir(parents=True, exist_ok=True)
                    source_crop = original.crop(crop_rect)
                    source_crop.save(crop_path, format="PNG", compress_level=6)
                    source_crop.close()
                    public = {
                        "schema_version": SCHEMA_VERSION,
                        "review_id": review_id,
                        "page_number": page_number,
                        "block_index": block_index,
                        "source_page_id": page_id,
                        "source_text": base_decision.get("sourceText"),
                        "translated_text": base_decision.get("translatedText"),
                        "selection_reason": "font_changed_pair"
                        if key in changed_keys
                        else "stable_bad_anchor",
                        "option_aliases": ["A", "B"],
                        "source_crop_path": crop_relative,
                    }
                    _assert_blind_payload(public)
                    public_rows.append(public)
                    row_for_sheet = {
                        "review_id": review_id,
                        "block_index": block_index,
                        "crop_rect_pixels": list(crop_rect),
                    }
                    rows_by_page[page_number].append(row_for_sheet)
                    private_rows.append(
                        {
                            "review_id": review_id,
                            "page_number": page_number,
                            "block_index": block_index,
                            "block_id": base_decision["blockId"],
                            "source_page_id": page_id,
                            "source_page_sha256": base_page["sourcePageSha256"],
                            "work_id": base_page.get("workId"),
                            "chapter_id": base_page.get("chapterId"),
                            "source_text": base_decision.get("sourceText"),
                            "translated_text": base_decision.get("translatedText"),
                            "source_crop": descriptor(
                                crop_path, declared_path=output / crop_relative
                            ),
                            "selection_reason": public["selection_reason"],
                            "option_A": _decision_visible_identity(
                                base_decision if order[0] == "baseline" else cand_decision
                            ),
                            "option_B": _decision_visible_identity(
                                base_decision if order[1] == "baseline" else cand_decision
                            ),
                            "option_A_run": order[0],
                            "option_B_run": order[1],
                            "baseline": _decision_visible_identity(base_decision),
                            "candidate": _decision_visible_identity(cand_decision),
                        }
                    )
                    review_rows.append(
                        {
                            "schema_version": SCHEMA_VERSION,
                            "review_id": review_id,
                            "preference": None,
                            "visual_intent": None,
                            "consistency_intent": None,
                            "notes": "",
                        }
                    )
                page_rows = rows_by_page[page_number]
                sheet_count = math.ceil(len(page_rows) / options.rows_per_sheet)
                for sheet_index in range(sheet_count):
                    chunk = page_rows[
                        sheet_index * options.rows_per_sheet : (sheet_index + 1) * options.rows_per_sheet
                    ]
                    relative = f"sheets/page-{page_number:03d}-sheet-{sheet_index + 1:02d}.png"
                    _render_sheet(
                        path=staging / relative,
                        page_number=page_number,
                        sheet_number=sheet_index + 1,
                        sheet_count=sheet_count,
                        rows=chunk,
                        original=original,
                        option_a=alias_images["A"],
                        option_b=alias_images["B"],
                    )
                    for row in chunk:
                        next(item for item in public_rows if item["review_id"] == row["review_id"])[
                            "sheet_path"
                        ] = relative
            finally:
                original.close()
                base_rendered.close()
                cand_rendered.close()

        if len(public_rows) != len(selected_keys):
            raise CorrectionError("selected row coverage drifted")
        if len([row for row in public_rows if row["selection_reason"] == "font_changed_pair"]) != EXPECTED_CHANGED_BLOCKS:
            raise CorrectionError("changed row coverage drifted")
        for row in public_rows:
            _assert_blind_payload(row)
        write_jsonl(staging / BLIND_QUEUE, public_rows)
        write_jsonl(staging / REVIEW_TEMPLATE, review_rows)
        private = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "baseline40_private_deblind_binding",
                "warning": "DO NOT OPEN BEFORE DIRECT VISUAL REVIEW IS COMPLETE",
                "baseline_run": descriptor(options.baseline_report.expanduser().resolve(strict=True)),
                "candidate_run": descriptor(options.candidate_report.expanduser().resolve(strict=True)),
                "comparison": descriptor(options.comparison.expanduser().resolve(strict=True)),
                "rows": private_rows,
                "input_bindings": input_bindings,
            }
        )
        write_json(staging / PRIVATE_BINDING, private)
        manifest = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "baseline40_blind_development_correction_queue",
                "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
                "status": "awaiting_direct_visual_review",
                "authority": AUTHORITY,
                "counts": {
                    "selected_rows": len(public_rows),
                    "font_changed_rows": EXPECTED_CHANGED_BLOCKS,
                    "stable_bad_anchor_rows": len(public_rows) - EXPECTED_CHANGED_BLOCKS,
                    "anchor_pages": list(options.anchor_pages),
                    "sheets": len(list((staging / "sheets").glob("*.png"))),
                },
                "blind_contract": {
                    "font_ids_hidden": True,
                    "font_names_hidden": True,
                    "model_predictions_hidden": True,
                    "page_level_option_shuffle": True,
                    "private_binding_open_only_during_seal": True,
                },
                "artifacts": {
                    BLIND_QUEUE: descriptor(
                        staging / BLIND_QUEUE,
                        row_count=len(public_rows),
                        declared_path=output / BLIND_QUEUE,
                    ),
                    REVIEW_TEMPLATE: descriptor(
                        staging / REVIEW_TEMPLATE,
                        row_count=len(review_rows),
                        declared_path=output / REVIEW_TEMPLATE,
                    ),
                    PRIVATE_BINDING: descriptor(
                        staging / PRIVATE_BINDING,
                        declared_path=output / PRIVATE_BINDING,
                    ),
                },
                "v10_holdout_preservation": v10,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        write_json(staging / MANIFEST, manifest)
        os.replace(staging, output)
        published = True
        result = validate_blind(output)
        return result
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def _validate_descriptor(value: Mapping[str, Any], label: str) -> None:
    path = Path(_required_text(value.get("path"), f"{label}.path"))
    if not path.is_file():
        raise CorrectionError(f"missing {label}: {path}")
    expected = _required_text(value.get("sha256"), f"{label}.sha256")
    if not SHA_RE.fullmatch(expected) or sha256_file(path) != expected:
        raise CorrectionError(f"{label} hash drifted: {path}")
    if path.stat().st_size != value.get("size"):
        raise CorrectionError(f"{label} size drifted: {path}")


def validate_blind(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve(strict=True)
    manifest = read_json(root / MANIFEST, "blind manifest")
    if manifest.get("record_type") != "baseline40_blind_development_correction_queue":
        raise CorrectionError("not a blind correction queue")
    if manifest.get("authority") != AUTHORITY:
        raise CorrectionError("authority contract drifted")
    rows = list(iter_jsonl(root / BLIND_QUEUE, "blind queue"))
    for row in rows:
        _assert_blind_payload(row)
        sheet = root / _required_text(row.get("sheet_path"), "sheet path")
        crop = root / _required_text(row.get("source_crop_path"), "crop path")
        if not sheet.is_file() or not crop.is_file():
            raise CorrectionError("blind inspection asset is missing")
    review = list(iter_jsonl(root / REVIEW_TEMPLATE, "review template"))
    private = read_json(root / PRIVATE_BINDING, "private binding")
    if [row.get("review_id") for row in rows] != [row.get("review_id") for row in review]:
        raise CorrectionError("review template coverage drifted")
    if [row.get("review_id") for row in rows] != [row.get("review_id") for row in private.get("rows", [])]:
        raise CorrectionError("private binding coverage drifted")
    for name, value in manifest["artifacts"].items():
        # The review surface is the one intentionally mutable file in the blind
        # pack.  Its completed hash is captured by the sealed artifact lineage.
        if name == REVIEW_TEMPLATE:
            continue
        _validate_descriptor(value, "blind artifact")
    for value in manifest["v10_holdout_preservation"].values():
        if isinstance(value, Mapping) and "sha256" in value:
            _validate_descriptor(value, "v10 preserved artifact")
    return {
        "ok": True,
        "status": manifest["status"],
        "rows": len(rows),
        "changed_rows": manifest["counts"]["font_changed_rows"],
        "anchor_rows": manifest["counts"]["stable_bad_anchor_rows"],
        "sheets": manifest["counts"]["sheets"],
    }


def _validate_review_rows(
    template: Sequence[Mapping[str, Any]], decisions: Sequence[Mapping[str, Any]]
) -> None:
    expected = [row.get("review_id") for row in template]
    actual = [row.get("review_id") for row in decisions]
    if actual != expected or len(actual) != len(set(actual)):
        raise CorrectionError("direct visual review coverage/order drifted")
    for row in decisions:
        if row.get("preference") not in ALLOWED_PREFERENCES:
            raise CorrectionError(f"invalid preference: {row.get('review_id')}")
        if row.get("visual_intent") not in ALLOWED_VISUAL_INTENTS:
            raise CorrectionError(f"invalid visual intent: {row.get('review_id')}")
        if row.get("consistency_intent") not in ALLOWED_CONSISTENCY:
            raise CorrectionError(f"invalid consistency intent: {row.get('review_id')}")
        if not isinstance(row.get("notes"), str):
            raise CorrectionError(f"notes must be text: {row.get('review_id')}")


def seal_review(blind_dir: Path, output_dir: Path) -> dict[str, Any]:
    blind = blind_dir.expanduser().resolve(strict=True)
    validate_blind(blind)
    output = output_dir.expanduser().resolve()
    if output.exists():
        raise CorrectionError(f"output directory already exists: {output}")
    template = list(iter_jsonl(blind / BLIND_QUEUE, "blind queue"))
    decisions = list(iter_jsonl(blind / REVIEW_TEMPLATE, "direct visual review"))
    private = read_json(blind / PRIVATE_BINDING, "private binding")
    private_rows = private.get("rows")
    if not isinstance(private_rows, list):
        raise CorrectionError("private binding rows missing")
    _validate_review_rows(template, decisions)
    by_id = {str(row["review_id"]): row for row in private_rows}
    labels: list[dict[str, Any]] = []
    verdict_counts: Counter[str] = Counter()
    outcome_counts: Counter[str] = Counter()
    role_corrections = 0
    for public, review in zip(template, decisions, strict=True):
        review_id = str(public["review_id"])
        binding = by_id[review_id]
        preference = str(review["preference"])
        option_a = binding["option_A"]
        option_b = binding["option_B"]
        font_a = option_a.get("effective_font_id")
        font_b = option_b.get("effective_font_id")
        positives: list[str] = []
        rejected: list[str] = []
        if preference == "option_a" and isinstance(font_a, str):
            positives = [font_a]
            if isinstance(font_b, str) and font_b != font_a:
                rejected = [font_b]
        elif preference == "option_b" and isinstance(font_b, str):
            positives = [font_b]
            if isinstance(font_a, str) and font_a != font_b:
                rejected = [font_a]
        elif preference == "both_acceptable":
            positives = sorted({font for font in (font_a, font_b) if isinstance(font, str)})
        elif preference == "none_acceptable":
            rejected = sorted({font for font in (font_a, font_b) if isinstance(font, str)})
        predicted_visual = {
            "emphasis_dialogue"
            if str(binding[run]["predicted_role"]) in {"emphasis_dialogue", "shout", "sfx_impact"}
            else "normal"
            for run in ("baseline", "candidate")
        }
        visual_intent = str(review["visual_intent"])
        correction = visual_intent not in predicted_visual
        role_corrections += int(correction)
        baseline_font = binding["baseline"].get("effective_font_id")
        candidate_font = binding["candidate"].get("effective_font_id")
        if binding["selection_reason"] == "font_changed_pair":
            preferred_set = set(positives)
            if preference == "none_acceptable":
                outcome = "both_bad"
            elif baseline_font == candidate_font or preference == "both_acceptable":
                outcome = "neutral"
            elif candidate_font in preferred_set and baseline_font not in preferred_set:
                outcome = "candidate_improvement"
            elif baseline_font in preferred_set and candidate_font not in preferred_set:
                outcome = "candidate_regression"
            else:
                outcome = "neutral"
        else:
            outcome = "stable_anchor_acceptable" if preference != "none_acceptable" else "stable_anchor_bad"
        verdict_counts[preference] += 1
        outcome_counts[outcome] += 1
        labels.append(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "manga_font_baseline40_development_direct_visual_label",
                "review_id": review_id,
                "sample_id": f"baseline40-dev:{binding['source_page_id']}:{binding['block_index']}",
                "identity": {
                    "work_id": binding.get("work_id"),
                    "chapter_id": binding.get("chapter_id"),
                    "source_page_id": binding["source_page_id"],
                    "source_page_sha256": binding["source_page_sha256"],
                    "block_id": binding["block_id"],
                    "block_index": binding["block_index"],
                },
                "source_crop": binding["source_crop"],
                "source_text": binding.get("source_text"),
                "translated_text": binding.get("translated_text"),
                "candidate_labels": {
                    "preferred_candidate_ids": positives[:1],
                    "positive_candidate_ids": positives,
                    "rejected_candidate_ids": rejected,
                    "none_acceptable": preference == "none_acceptable",
                    "pairwise_only": True,
                },
                "visual_intent": visual_intent,
                "role": "emphasis_dialogue" if visual_intent == "emphasis" else "dialogue",
                "role_correction": correction,
                "page_consistency_intent": review["consistency_intent"],
                "pairwise_outcome": outcome,
                "selection_reason": binding["selection_reason"],
                "review_notes": review["notes"],
                "authority": AUTHORITY,
            }
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        crops = staging / "source-crops"
        shutil.copytree(blind / "source-crops", crops)
        write_jsonl(staging / SEALED_LABELS, labels)
        invalidation = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "qa_cohort_authority_invalidation",
                "cohort": "library-full-pipeline-font-qa-v9/baseline40",
                "previous_use": "development_baseline_visual_qa",
                "new_use": "development_only_direct_visual_supervision",
                "future_holdout_eligible": False,
                "future_calibration_eligible": False,
                "reason": "All selected baseline40 blocks were directly inspected and labeled.",
                "v10_holdout_preserved": read_json(blind / MANIFEST, "blind manifest")[
                    "v10_holdout_preservation"
                ],
            }
        )
        write_json(staging / INVALIDATION, invalidation)
        manifest = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "manga_font_baseline40_development_correction_manifest",
                "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
                "status": "sealed_training_only_development_only",
                "authority": AUTHORITY,
                "counts": {
                    "rows": len(labels),
                    "font_changed_rows": sum(row["selection_reason"] == "font_changed_pair" for row in labels),
                    "stable_bad_anchor_rows": sum(row["selection_reason"] == "stable_bad_anchor" for row in labels),
                    "preferences": dict(sorted(verdict_counts.items())),
                    "pairwise_outcomes": dict(sorted(outcome_counts.items())),
                    "visual_intents": dict(sorted(Counter(row["visual_intent"] for row in labels).items())),
                    "page_consistency_intents": dict(sorted(Counter(row["page_consistency_intent"] for row in labels).items())),
                    "role_corrections": role_corrections,
                    "positive_font_rows": sum(bool(row["candidate_labels"]["positive_candidate_ids"]) for row in labels),
                    "none_acceptable_rows": sum(row["candidate_labels"]["none_acceptable"] for row in labels),
                },
                "lineage": {
                    "blind_queue": descriptor(blind / BLIND_QUEUE, row_count=len(labels)),
                    "completed_direct_visual_review": descriptor(blind / REVIEW_TEMPLATE, row_count=len(labels)),
                    "private_deblind_binding": descriptor(blind / PRIVATE_BINDING),
                    "baseline40_holdout_authority_invalidated": True,
                    "active21_expansion": {
                        "performed": False,
                        "reason": "No existing per-block active21 render bank; synthetic rerendering would confound layout/treatment. Exact r3h/r4a25 pairwise renders were sealed instead."
                    },
                },
                "artifacts": {
                    SEALED_LABELS: descriptor(
                        staging / SEALED_LABELS,
                        row_count=len(labels),
                        declared_path=output / SEALED_LABELS,
                    ),
                    INVALIDATION: descriptor(
                        staging / INVALIDATION,
                        declared_path=output / INVALIDATION,
                    ),
                },
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        write_json(staging / MANIFEST, manifest)
        report = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "manga_font_baseline40_development_correction_report",
                "status": manifest["status"],
                "counts": manifest["counts"],
                "authority": AUTHORITY,
                "manifest_record_sha256": manifest["record_sha256"],
            }
        )
        write_json(staging / REPORT, report)
        hashes = {
            path.relative_to(staging).as_posix(): sha256_file(path)
            for path in sorted(staging.rglob("*"))
            if path.is_file() and path.name != SEAL
        }
        write_json(staging / SEAL, seal_record({"schema_version": SCHEMA_VERSION, "files": hashes}))
        os.replace(staging, output)
        published = True
        return validate_sealed(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def _load_postblind_adjudications(path: Path) -> list[dict[str, Any]]:
    rows = list(iter_jsonl(path, "postblind adjudications"))
    if not rows:
        raise CorrectionError("postblind adjudications are empty")
    review_ids: list[str] = []
    for row in rows:
        review_id = _required_text(row.get("review_id"), "adjudication.review_id")
        review_ids.append(review_id)
        page_number = row.get("page_number")
        if isinstance(page_number, bool) or not isinstance(page_number, int):
            raise CorrectionError(f"{review_id} page_number must be an integer")
        if page_number < 1 or page_number > 40:
            raise CorrectionError(f"{review_id} page_number is outside baseline40")
        candidate_labels = {
            "preferred_candidate_ids": row.get("preferred_candidate_ids"),
            "positive_candidate_ids": row.get("positive_candidate_ids"),
            "rejected_candidate_ids": row.get("rejected_candidate_ids"),
            "none_acceptable": row.get("none_acceptable"),
            "pairwise_only": True,
        }
        _validate_candidate_labels(candidate_labels, f"{review_id}.candidate_labels")
        if row.get("visual_intent") not in ALLOWED_VISUAL_INTENTS:
            raise CorrectionError(f"{review_id} visual_intent is invalid")
        if row.get("consistency_intent") not in ALLOWED_CONSISTENCY:
            raise CorrectionError(f"{review_id} consistency_intent is invalid")
        if row.get("pairwise_outcome") not in {
            "both_bad",
            "candidate_improvement",
            "candidate_regression",
            "neutral",
        }:
            raise CorrectionError(f"{review_id} pairwise_outcome is invalid")
        _required_text(row.get("notes"), f"{review_id}.notes")
        sheet = _required_text(row.get("context_sheet"), f"{review_id}.context_sheet")
        if Path(sheet).name != sheet or not sheet.lower().endswith(".png"):
            raise CorrectionError(f"{review_id} context_sheet must be a PNG basename")
        issue_tags = row.get("issue_tags")
        if (
            not isinstance(issue_tags, list)
            or not issue_tags
            or any(not isinstance(tag, str) or not tag for tag in issue_tags)
        ):
            raise CorrectionError(f"{review_id} issue_tags must be non-empty text")
        exclusion = row.get("training_exclusion")
        if exclusion is not None:
            _required_text(exclusion, f"{review_id}.training_exclusion")
            if row.get("none_acceptable") is not True:
                raise CorrectionError(
                    f"{review_id} training exclusion requires none_acceptable"
                )
    if len(review_ids) != len(set(review_ids)):
        raise CorrectionError("postblind adjudication IDs contain duplicates")
    return rows


def _expected_pairwise_outcome(
    *,
    baseline_font: Any,
    candidate_font: Any,
    labels: Mapping[str, Any],
) -> str:
    positives = set(labels["positive_candidate_ids"])
    if labels["none_acceptable"]:
        return "both_bad"
    if baseline_font == candidate_font or len(positives) > 1:
        return "neutral"
    if candidate_font in positives and baseline_font not in positives:
        return "candidate_improvement"
    if baseline_font in positives and candidate_font not in positives:
        return "candidate_regression"
    return "neutral"


def adjudicate_sealed(
    *,
    source_dir: Path,
    adjudications_path: Path,
    independent_audit_path: Path,
    baseline_block_dir: Path,
    candidate_block_dir: Path,
    output_dir: Path,
) -> dict[str, Any]:
    source = source_dir.expanduser().resolve(strict=True)
    validate_sealed(source)
    output = output_dir.expanduser().resolve()
    if output.exists():
        raise CorrectionError(f"output directory already exists: {output}")
    adjudications_path = adjudications_path.expanduser().resolve(strict=True)
    independent_audit_path = independent_audit_path.expanduser().resolve(strict=True)
    baseline_block_dir = baseline_block_dir.expanduser().resolve(strict=True)
    candidate_block_dir = candidate_block_dir.expanduser().resolve(strict=True)
    adjudications = _load_postblind_adjudications(adjudications_path)
    audits = list(iter_jsonl(independent_audit_path, "independent page audit"))
    if len(audits) != 40:
        raise CorrectionError("independent page audit must cover all 40 pages")
    audit_by_page: dict[int, dict[str, Any]] = {}
    for audit in audits:
        try:
            page_number = int(str(audit.get("page")))
        except (TypeError, ValueError) as exc:
            raise CorrectionError("independent audit page is invalid") from exc
        if page_number in audit_by_page:
            raise CorrectionError("independent audit page coverage contains duplicates")
        audit_by_page[page_number] = audit
    if set(audit_by_page) != set(range(1, 41)):
        raise CorrectionError("independent audit page coverage drifted")

    source_manifest = read_json(source / MANIFEST, "source sealed manifest")
    source_invalidation = read_json(source / INVALIDATION, "source invalidation")
    labels = list(iter_jsonl(source / SEALED_LABELS, "source sealed labels"))
    source_labels_by_id = {str(row["review_id"]): row for row in labels}
    private_descriptor = source_manifest.get("lineage", {}).get(
        "private_deblind_binding"
    )
    if not isinstance(private_descriptor, Mapping):
        raise CorrectionError("source private deblind binding is missing")
    _validate_descriptor(private_descriptor, "source private deblind binding")
    private = read_json(
        Path(str(private_descriptor["path"])), "source private deblind binding"
    )
    private_rows = private.get("rows")
    if not isinstance(private_rows, list):
        raise CorrectionError("source private deblind rows are missing")
    binding_by_id = {str(row["review_id"]): row for row in private_rows}
    adjudication_by_id = {str(row["review_id"]): row for row in adjudications}
    unknown = set(adjudication_by_id) - set(source_labels_by_id)
    if unknown:
        raise CorrectionError(f"adjudications reference unknown review IDs: {sorted(unknown)}")

    context_descriptors: dict[str, dict[str, Any]] = {}
    transitions: Counter[str] = Counter()
    changed_rows: list[dict[str, Any]] = []
    for index, source_row in enumerate(labels):
        review_id = str(source_row["review_id"])
        adjudication = adjudication_by_id.get(review_id)
        if adjudication is None:
            continue
        binding = binding_by_id.get(review_id)
        if not isinstance(binding, Mapping):
            raise CorrectionError(f"missing private binding for {review_id}")
        if source_row.get("selection_reason") != "font_changed_pair":
            raise CorrectionError(f"{review_id} is not a changed-font pair")
        if binding.get("page_number") != adjudication["page_number"]:
            raise CorrectionError(f"{review_id} page binding drifted")
        baseline_font = binding.get("baseline", {}).get("effective_font_id")
        candidate_font = binding.get("candidate", {}).get("effective_font_id")
        pair_fonts = {
            value for value in (baseline_font, candidate_font) if isinstance(value, str)
        }
        candidate_labels = {
            "preferred_candidate_ids": list(adjudication["preferred_candidate_ids"]),
            "positive_candidate_ids": list(adjudication["positive_candidate_ids"]),
            "rejected_candidate_ids": list(adjudication["rejected_candidate_ids"]),
            "none_acceptable": bool(adjudication["none_acceptable"]),
            "pairwise_only": True,
        }
        if set(candidate_labels["positive_candidate_ids"]) | set(
            candidate_labels["rejected_candidate_ids"]
        ) != pair_fonts:
            raise CorrectionError(
                f"{review_id} adjudication must account for the exact pair candidates"
            )
        expected_outcome = _expected_pairwise_outcome(
            baseline_font=baseline_font,
            candidate_font=candidate_font,
            labels=candidate_labels,
        )
        if adjudication["pairwise_outcome"] != expected_outcome:
            raise CorrectionError(
                f"{review_id} outcome should be {expected_outcome}, not "
                f"{adjudication['pairwise_outcome']}"
            )
        sheet_name = str(adjudication["context_sheet"])
        sheet_paths = (
            baseline_block_dir / sheet_name,
            candidate_block_dir / sheet_name,
        )
        sheet_evidence: list[dict[str, Any]] = []
        for sheet_path in sheet_paths:
            resolved = sheet_path.resolve(strict=True)
            key = str(resolved)
            if key not in context_descriptors:
                context_descriptors[key] = descriptor(resolved)
            sheet_evidence.append(context_descriptors[key])
        audit = audit_by_page[int(adjudication["page_number"])]
        evidence_blocks = {str(value) for value in audit.get("evidence_blocks", [])}
        if str(binding.get("block_index")) not in evidence_blocks:
            raise CorrectionError(
                f"{review_id} is not cited by the independent page audit evidence"
            )
        prior = copy.deepcopy(source_row)
        updated = copy.deepcopy(source_row)
        updated["candidate_labels"] = candidate_labels
        updated["visual_intent"] = adjudication["visual_intent"]
        updated["role"] = (
            "emphasis_dialogue"
            if adjudication["visual_intent"] == "emphasis"
            else "dialogue"
        )
        predicted_visual = {
            "emphasis"
            if str(binding[run].get("predicted_role"))
            in {"emphasis_dialogue", "shout", "sfx_impact"}
            else "normal"
            for run in ("baseline", "candidate")
        }
        updated["role_correction"] = (
            adjudication["visual_intent"] not in predicted_visual
        )
        updated["page_consistency_intent"] = adjudication["consistency_intent"]
        updated["pairwise_outcome"] = adjudication["pairwise_outcome"]
        updated["review_notes"] = adjudication["notes"]
        if adjudication.get("training_exclusion") is not None:
            updated["training_exclusion"] = {
                "excluded_from_positive_font_supervision": True,
                "reason": adjudication["training_exclusion"],
            }
        updated["adjudication"] = {
            "stage": "postblind_full_context_adjudication",
            "authority": "codex_agent_direct_visual_supervision",
            "blind_decision_completed_before_deblinding": True,
            "prior_blind_label_sha256": sha256_bytes(canonical_bytes(prior)),
            "prior_blind_decision": {
                "candidate_labels": prior["candidate_labels"],
                "visual_intent": prior["visual_intent"],
                "page_consistency_intent": prior["page_consistency_intent"],
                "pairwise_outcome": prior["pairwise_outcome"],
                "review_notes": prior["review_notes"],
            },
            "independent_page_audit": audit,
            "context_render_sheets": sheet_evidence,
            "issue_tags": list(adjudication["issue_tags"]),
            "notes": adjudication["notes"],
        }
        labels[index] = updated
        transitions[f"{prior['pairwise_outcome']}->{updated['pairwise_outcome']}"] += 1
        changed_rows.append(
            {
                "review_id": review_id,
                "page_number": binding["page_number"],
                "block_index": binding["block_index"],
                "before_outcome": prior["pairwise_outcome"],
                "after_outcome": updated["pairwise_outcome"],
                "positive_candidate_ids": candidate_labels["positive_candidate_ids"],
                "rejected_candidate_ids": candidate_labels["rejected_candidate_ids"],
                "none_acceptable": candidate_labels["none_acceptable"],
                "visual_intent": updated["visual_intent"],
                "page_consistency_intent": updated["page_consistency_intent"],
                "issue_tags": list(adjudication["issue_tags"]),
                "notes": adjudication["notes"],
            }
        )

    if len(changed_rows) != len(adjudications):
        raise CorrectionError("not every postblind adjudication was applied")
    counts = _summarize_labels(labels)
    counts["postblind_adjudicated_rows"] = len(changed_rows)
    counts["postblind_outcome_transitions"] = dict(sorted(transitions.items()))
    all_changed: list[dict[str, Any]] = []
    for row in labels:
        if row.get("selection_reason") != "font_changed_pair":
            continue
        review_id = str(row["review_id"])
        binding = binding_by_id[review_id]
        all_changed.append(
            {
                "review_id": review_id,
                "page_number": binding["page_number"],
                "block_index": binding["block_index"],
                "pairwise_outcome": row["pairwise_outcome"],
                "positive_candidate_ids": row["candidate_labels"][
                    "positive_candidate_ids"
                ],
                "rejected_candidate_ids": row["candidate_labels"][
                    "rejected_candidate_ids"
                ],
                "none_acceptable": row["candidate_labels"]["none_acceptable"],
                "visual_intent": row["visual_intent"],
                "page_consistency_intent": row["page_consistency_intent"],
                "postblind_adjudicated": "adjudication" in row,
            }
        )
    actionable = seal_record(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "manga_font_baseline40_actionable_corrections",
            "status": "training_only_development_only",
            "authority": AUTHORITY,
            "counts": {
                "font_changed_rows": len(all_changed),
                "postblind_adjudicated_rows": len(changed_rows),
                "candidate_improvements": sum(
                    row["pairwise_outcome"] == "candidate_improvement"
                    for row in all_changed
                ),
                "candidate_regressions": sum(
                    row["pairwise_outcome"] == "candidate_regression"
                    for row in all_changed
                ),
                "both_bad": sum(
                    row["pairwise_outcome"] == "both_bad" for row in all_changed
                ),
                "neutral": sum(
                    row["pairwise_outcome"] == "neutral" for row in all_changed
                ),
            },
            "postblind_changes": changed_rows,
            "font_changed_rows": sorted(
                all_changed, key=lambda row: (row["page_number"], row["block_index"])
            ),
        }
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        shutil.copytree(source / "source-crops", staging / "source-crops")
        write_jsonl(staging / SEALED_LABELS, labels)
        write_jsonl(staging / POSTBLIND_ADJUDICATIONS, adjudications)
        write_json(staging / ACTIONABLE_CORRECTIONS, actionable)
        invalidation = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "qa_cohort_authority_invalidation",
                "cohort": "library-full-pipeline-font-qa-v9/baseline40",
                "previous_use": "development_only_direct_visual_supervision",
                "new_use": "development_only_postblind_adjudicated_supervision",
                "future_holdout_eligible": False,
                "future_calibration_eligible": False,
                "reason": (
                    "Baseline40 was already invalidated after direct blind review; "
                    "full-page development context was then used to adjudicate conflicts."
                ),
                "source_invalidation_record_sha256": source_invalidation[
                    "record_sha256"
                ],
                "v10_holdout_preserved": source_invalidation[
                    "v10_holdout_preserved"
                ],
            }
        )
        write_json(staging / INVALIDATION, invalidation)
        local_adjudication_descriptor = descriptor(
            staging / POSTBLIND_ADJUDICATIONS,
            row_count=len(adjudications),
            declared_path=output / POSTBLIND_ADJUDICATIONS,
        )
        manifest = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "manga_font_baseline40_development_correction_manifest",
                "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
                "status": "sealed_training_only_development_only",
                "adjudication_stage": "postblind_full_context_adjudication",
                "authority": AUTHORITY,
                "counts": counts,
                "lineage": {
                    "source_sealed_manifest": descriptor(source / MANIFEST),
                    "source_sealed_training_labels": descriptor(
                        source / SEALED_LABELS, row_count=len(labels)
                    ),
                    "source_invalidation": descriptor(source / INVALIDATION),
                    "private_deblind_binding": private_descriptor,
                    "postblind_adjudication": {
                        "performed": True,
                        "rows": len(adjudications),
                        "blind_decisions_completed_before_deblinding": True,
                        "baseline40_treated_as_development_data": True,
                        "input": descriptor(
                            adjudications_path, row_count=len(adjudications)
                        ),
                        "sealed_copy": local_adjudication_descriptor,
                        "independent_page_audit": descriptor(
                            independent_audit_path, row_count=len(audits)
                        ),
                        "context_render_sheets": [
                            context_descriptors[key]
                            for key in sorted(context_descriptors)
                        ],
                    },
                    "baseline40_holdout_authority_invalidated": True,
                    "v10_holdout_read_for_labels": False,
                    "active21_expansion": source_manifest.get("lineage", {}).get(
                        "active21_expansion"
                    ),
                },
                "artifacts": {
                    SEALED_LABELS: descriptor(
                        staging / SEALED_LABELS,
                        row_count=len(labels),
                        declared_path=output / SEALED_LABELS,
                    ),
                    POSTBLIND_ADJUDICATIONS: local_adjudication_descriptor,
                    ACTIONABLE_CORRECTIONS: descriptor(
                        staging / ACTIONABLE_CORRECTIONS,
                        declared_path=output / ACTIONABLE_CORRECTIONS,
                    ),
                    INVALIDATION: descriptor(
                        staging / INVALIDATION,
                        declared_path=output / INVALIDATION,
                    ),
                },
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        write_json(staging / MANIFEST, manifest)
        report = seal_record(
            {
                "schema_version": SCHEMA_VERSION,
                "record_type": "manga_font_baseline40_development_correction_report",
                "status": manifest["status"],
                "adjudication_stage": manifest["adjudication_stage"],
                "counts": counts,
                "authority": AUTHORITY,
                "actionable_counts": actionable["counts"],
                "manifest_record_sha256": manifest["record_sha256"],
            }
        )
        write_json(staging / REPORT, report)
        hashes = {
            path.relative_to(staging).as_posix(): sha256_file(path)
            for path in sorted(staging.rglob("*"))
            if path.is_file() and path.name != SEAL
        }
        write_json(
            staging / SEAL,
            seal_record({"schema_version": SCHEMA_VERSION, "files": hashes}),
        )
        os.replace(staging, output)
        published = True
        return validate_sealed(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_sealed(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve(strict=True)
    manifest = read_json(root / MANIFEST, "sealed manifest")
    report = read_json(root / REPORT, "sealed report")
    invalidation = read_json(root / INVALIDATION, "baseline40 invalidation")
    seal = read_json(root / SEAL, "file seal")
    _validate_seal_record(manifest, "sealed manifest")
    _validate_seal_record(report, "sealed report")
    _validate_seal_record(invalidation, "baseline40 invalidation")
    _validate_seal_record(seal, "file seal")
    if manifest.get("authority") != AUTHORITY or report.get("authority") != AUTHORITY:
        raise CorrectionError("sealed authority drifted")
    if manifest.get("status") != "sealed_training_only_development_only":
        raise CorrectionError("sealed status drifted")
    if report.get("status") != manifest.get("status"):
        raise CorrectionError("sealed report status drifted")
    if report.get("manifest_record_sha256") != manifest.get("record_sha256"):
        raise CorrectionError("sealed report manifest binding drifted")
    if report.get("counts") != manifest.get("counts"):
        raise CorrectionError("sealed report counts drifted")
    if invalidation.get("future_holdout_eligible") is not False:
        raise CorrectionError("baseline40 holdout invalidation missing")
    if invalidation.get("future_calibration_eligible") is not False:
        raise CorrectionError("baseline40 calibration invalidation missing")
    preserved = invalidation.get("v10_holdout_preserved")
    if not isinstance(preserved, Mapping):
        raise CorrectionError("v10 preservation binding missing")
    for value in preserved.values():
        if isinstance(value, Mapping) and "sha256" in value:
            _validate_descriptor(value, "v10 preserved artifact")
    files = seal.get("files")
    if not isinstance(files, Mapping):
        raise CorrectionError("file seal missing")
    actual_files = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name != SEAL
    }
    if set(map(str, files)) != actual_files:
        raise CorrectionError("sealed file inventory drifted")
    for relative, expected in files.items():
        path = (root / str(relative)).resolve(strict=True)
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise CorrectionError("sealed file escaped artifact root") from exc
        if sha256_file(path) != expected:
            raise CorrectionError(f"sealed file hash drifted: {relative}")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise CorrectionError("sealed artifact descriptors are missing")
    for name, value in artifacts.items():
        if not isinstance(value, Mapping):
            raise CorrectionError(f"sealed artifact descriptor is invalid: {name}")
        _validate_descriptor(value, f"sealed artifact {name}")
    labels = list(iter_jsonl(root / SEALED_LABELS, "sealed labels"))
    if len(labels) != manifest.get("counts", {}).get("rows"):
        raise CorrectionError("sealed row count drifted")
    for row in labels:
        if row.get("authority") != AUTHORITY:
            raise CorrectionError("row authority drifted")
        _validate_candidate_labels(
            row.get("candidate_labels"), f"{row.get('review_id')}.candidate_labels"
        )
        if row.get("visual_intent") not in ALLOWED_VISUAL_INTENTS:
            raise CorrectionError("sealed visual intent drifted")
        expected_role = (
            "emphasis_dialogue"
            if row.get("visual_intent") == "emphasis"
            else "dialogue"
        )
        if row.get("role") != expected_role:
            raise CorrectionError("sealed role/visual intent binding drifted")
        if row.get("page_consistency_intent") not in ALLOWED_CONSISTENCY:
            raise CorrectionError("sealed page consistency intent drifted")
        if row.get("pairwise_outcome") not in ALLOWED_PAIRWISE_OUTCOMES:
            raise CorrectionError("sealed pairwise outcome drifted")
        crop = Path(row["source_crop"]["path"])
        # Source descriptors still point to the immutable blind source crop.  The
        # copied crop is additionally sealed for standalone portability.
        if not crop.is_file() or sha256_file(crop) != row["source_crop"]["sha256"]:
            raise CorrectionError("source crop lineage drifted")
        local_crop = root / "source-crops" / f"{row['review_id']}.png"
        if not local_crop.is_file() or sha256_file(local_crop) != row["source_crop"]["sha256"]:
            raise CorrectionError("portable source crop drifted")

    postblind = manifest.get("lineage", {}).get("postblind_adjudication")
    if manifest.get("adjudication_stage") == "postblind_full_context_adjudication":
        if not isinstance(postblind, Mapping) or postblind.get("performed") is not True:
            raise CorrectionError("postblind adjudication lineage is missing")
        if postblind.get("blind_decisions_completed_before_deblinding") is not True:
            raise CorrectionError("postblind chronology contract drifted")
        if postblind.get("baseline40_treated_as_development_data") is not True:
            raise CorrectionError("baseline40 development-only contract drifted")
        summary = _summarize_labels(labels)
        for key, value in summary.items():
            if manifest.get("counts", {}).get(key) != value:
                raise CorrectionError(f"postblind count drifted: {key}")
        adjudications = list(
            iter_jsonl(root / POSTBLIND_ADJUDICATIONS, "sealed adjudications")
        )
        _load_postblind_adjudications(root / POSTBLIND_ADJUDICATIONS)
        if len(adjudications) != postblind.get("rows"):
            raise CorrectionError("postblind adjudication row count drifted")
        adjudication_ids = {str(row["review_id"]) for row in adjudications}
        adjudicated_labels = [row for row in labels if "adjudication" in row]
        if {str(row["review_id"]) for row in adjudicated_labels} != adjudication_ids:
            raise CorrectionError("postblind adjudication label coverage drifted")
        if manifest.get("counts", {}).get("postblind_adjudicated_rows") != len(
            adjudicated_labels
        ):
            raise CorrectionError("postblind adjudicated count drifted")
        source_manifest_descriptor = manifest.get("lineage", {}).get(
            "source_sealed_manifest"
        )
        source_labels_descriptor = manifest.get("lineage", {}).get(
            "source_sealed_training_labels"
        )
        source_invalidation_descriptor = manifest.get("lineage", {}).get(
            "source_invalidation"
        )
        for descriptor_value, descriptor_label in (
            (source_manifest_descriptor, "source sealed manifest"),
            (source_labels_descriptor, "source sealed labels"),
            (source_invalidation_descriptor, "source invalidation"),
            (postblind.get("input"), "postblind input"),
            (postblind.get("sealed_copy"), "postblind sealed copy"),
            (postblind.get("independent_page_audit"), "independent page audit"),
        ):
            if not isinstance(descriptor_value, Mapping):
                raise CorrectionError(f"{descriptor_label} descriptor is missing")
            _validate_descriptor(descriptor_value, descriptor_label)
        context_sheets = postblind.get("context_render_sheets")
        if not isinstance(context_sheets, list) or not context_sheets:
            raise CorrectionError("postblind context sheet lineage is missing")
        for value in context_sheets:
            if not isinstance(value, Mapping):
                raise CorrectionError("postblind context sheet descriptor is invalid")
            _validate_descriptor(value, "postblind context render sheet")
        source_labels = list(
            iter_jsonl(
                Path(str(source_labels_descriptor["path"])), "source sealed labels"
            )
        )
        source_by_id = {str(row["review_id"]): row for row in source_labels}
        for row in adjudicated_labels:
            adjudication = row["adjudication"]
            if adjudication.get("stage") != "postblind_full_context_adjudication":
                raise CorrectionError("row postblind stage drifted")
            prior = source_by_id.get(str(row["review_id"]))
            if prior is None:
                raise CorrectionError("row prior blind label is missing")
            if adjudication.get("prior_blind_label_sha256") != sha256_bytes(
                canonical_bytes(prior)
            ):
                raise CorrectionError("row prior blind label hash drifted")
            evidence = adjudication.get("context_render_sheets")
            if not isinstance(evidence, list) or len(evidence) != 2:
                raise CorrectionError("row context render evidence drifted")
            for value in evidence:
                _validate_descriptor(value, "row context render evidence")
        source_invalidation_record = read_json(
            Path(str(source_invalidation_descriptor["path"])), "source invalidation"
        )
        if preserved != source_invalidation_record.get("v10_holdout_preserved"):
            raise CorrectionError("v10 preservation lineage drifted after adjudication")
        actionable = read_json(
            root / ACTIONABLE_CORRECTIONS, "actionable corrections"
        )
        _validate_seal_record(actionable, "actionable corrections")
        if actionable.get("authority") != AUTHORITY:
            raise CorrectionError("actionable correction authority drifted")
        if actionable.get("counts", {}).get("font_changed_rows") != EXPECTED_CHANGED_BLOCKS:
            raise CorrectionError("actionable changed-block coverage drifted")
        if actionable.get("counts", {}).get("postblind_adjudicated_rows") != len(
            adjudications
        ):
            raise CorrectionError("actionable adjudication count drifted")
    elif postblind is not None:
        raise CorrectionError("unexpected postblind lineage without adjudication stage")
    return {
        "ok": True,
        "status": manifest["status"],
        "rows": len(labels),
        "counts": manifest["counts"],
        "manifest_record_sha256": manifest["record_sha256"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-blind")
    build.add_argument("--baseline-report", type=Path, required=True)
    build.add_argument("--candidate-report", type=Path, required=True)
    build.add_argument("--comparison", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--v10-holdout-manifest", type=Path, required=True)
    build.add_argument("--v10-selection", type=Path, required=True)
    build.add_argument("--rows-per-sheet", type=int, default=ROWS_PER_SHEET)
    validate_b = commands.add_parser("validate-blind")
    validate_b.add_argument("--output-dir", type=Path, required=True)
    seal = commands.add_parser("seal")
    seal.add_argument("--blind-dir", type=Path, required=True)
    seal.add_argument("--output-dir", type=Path, required=True)
    adjudicate = commands.add_parser("adjudicate")
    adjudicate.add_argument("--source-dir", type=Path, required=True)
    adjudicate.add_argument("--adjudications", type=Path, required=True)
    adjudicate.add_argument("--independent-audit", type=Path, required=True)
    adjudicate.add_argument("--baseline-block-dir", type=Path, required=True)
    adjudicate.add_argument("--candidate-block-dir", type=Path, required=True)
    adjudicate.add_argument("--output-dir", type=Path, required=True)
    validate_s = commands.add_parser("validate")
    validate_s.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "build-blind":
            result = build_blind(
                BuildOptions(
                    baseline_report=args.baseline_report,
                    candidate_report=args.candidate_report,
                    comparison=args.comparison,
                    output_dir=args.output_dir,
                    v10_holdout_manifest=args.v10_holdout_manifest,
                    v10_selection=args.v10_selection,
                    rows_per_sheet=args.rows_per_sheet,
                )
            )
        elif args.command == "validate-blind":
            result = validate_blind(args.output_dir)
        elif args.command == "seal":
            result = seal_review(args.blind_dir, args.output_dir)
        elif args.command == "adjudicate":
            result = adjudicate_sealed(
                source_dir=args.source_dir,
                adjudications_path=args.adjudications,
                independent_audit_path=args.independent_audit,
                baseline_block_dir=args.baseline_block_dir,
                candidate_block_dir=args.candidate_block_dir,
                output_dir=args.output_dir,
            )
        else:
            result = validate_sealed(args.output_dir)
    except (CorrectionError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
