#!/usr/bin/env python3
"""Build and validate a sealed, image-only review pack for library font QA.

The production QA runner writes ``run-report.json`` and deliberately leaves
visual acceptance to a reviewer.  This helper turns one *completed* report
into PNGs that can be inspected with ``view_image`` without launching the app:

* one original-versus-rendered page pair per source page;
* paginated, block-level original-versus-rendered crop sheets;
* JSONL decision metadata and a deterministic inspection order; and
* SHA-256 bindings for every referenced input and generated output.

It never writes into the source run.  Build output is created atomically in a
new sibling directory, and ``validate`` fails closed when any input, page,
block, generated asset, index, or seal is missing or has drifted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

try:
    from scripts import font_decision_outline_policy as outline_policy
except ImportError:  # pragma: no cover - direct execution from scripts/
    script_dir = str(Path(__file__).resolve().parent)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    import font_decision_outline_policy as outline_policy


TOOL_ID = "manga-library-font-qa-visual-review"
TOOL_VERSION = "1.0.0"
INDEX_NAME = "visual-review-index.json"
INDEX_SEAL_NAME = "visual-review-index.sha256"
DECISIONS_NAME = "block-review.jsonl"
ORDER_NAME = "inspection-order.txt"
README_NAME = "REVIEW-INSTRUCTIONS.txt"
SCHEMA_VERSION = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

PAIR_BACKGROUND = (18, 20, 24)
PAIR_PANEL = (34, 38, 45)
TEXT_PRIMARY = (241, 245, 249)
TEXT_MUTED = (173, 184, 197)
ACCENT = (80, 205, 230)
ROLE_ACCENT = (250, 204, 84)


class ReviewError(RuntimeError):
    """Raised when the review contract cannot be proven complete."""


@dataclass(frozen=True)
class BuildOptions:
    report_path: Path
    output_dir: Path
    expected_pages: int = 40
    pair_page_max_width: int = 1200
    pair_page_max_height: int = 1800
    blocks_per_sheet: int = 6
    crop_padding_ratio: float = 0.35


@dataclass(frozen=True)
class PageInputs:
    original: Path
    cleaned: Path
    rendered: Path
    font_input: Path
    font_inference: Path | None


@dataclass(frozen=True)
class LoadedPage:
    report: dict[str, Any]
    inputs: PageInputs
    original: Image.Image
    cleaned: Image.Image
    rendered: Image.Image
    input_bindings: dict[str, dict[str, Any] | None]


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise ReviewError(f"Could not hash file: {path}: {exc}") from exc
    return digest.hexdigest()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReviewError(f"Invalid {label}: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ReviewError(f"{label} must contain a JSON object: {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _as_nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReviewError(f"Missing or empty {field}.")
    return value


def _as_int(value: Any, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ReviewError(f"{field} must be an integer >= {minimum}.")
    return value


def _as_finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReviewError(f"{field} must be numeric.")
    number = float(value)
    if not math.isfinite(number):
        raise ReviewError(f"{field} must be finite.")
    return number


def _require_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ReviewError(f"{field} must be a lowercase SHA-256 digest.")
    return value


def _resolve_reference(run_dir: Path, raw: Any, field: str) -> Path:
    text = _as_nonempty_string(raw, field)
    path = Path(text)
    if not path.is_absolute():
        path = run_dir / path
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ReviewError(f"Missing {field}: {path}: {exc}") from exc
    if not resolved.is_file():
        raise ReviewError(f"{field} is not a regular file: {resolved}")
    return resolved


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _open_rgb(path: Path, field: str) -> Image.Image:
    try:
        with Image.open(path) as opened:
            opened.load()
            transposed = ImageOps.exif_transpose(opened)
            image = transposed.convert("RGB")
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise ReviewError(f"Could not fully decode {field}: {path}: {exc}") from exc
    if image.width <= 0 or image.height <= 0:
        image.close()
        raise ReviewError(f"{field} has invalid dimensions: {path}")
    return image


def _file_binding(
    path: Path,
    *,
    kind: str,
    expected_sha256: str | None = None,
    image: Image.Image | None = None,
) -> dict[str, Any]:
    try:
        stat = path.stat()
    except OSError as exc:
        raise ReviewError(f"Could not stat {kind}: {path}: {exc}") from exc
    actual_sha256 = sha256_file(path)
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        raise ReviewError(
            f"{kind} SHA-256 mismatch: expected {expected_sha256}, "
            f"got {actual_sha256}: {path}"
        )
    binding: dict[str, Any] = {
        "kind": kind,
        "path": str(path),
        "size": stat.st_size,
        "sha256": actual_sha256,
    }
    if image is not None:
        binding["width"] = image.width
        binding["height"] = image.height
        binding["mode"] = image.mode
    return binding


def _validate_bbox(raw: Any, page_number: int, block_index: int) -> dict[str, float]:
    if not isinstance(raw, dict):
        raise ReviewError(
            f"Page {page_number} block {block_index} has no normalized bbox object."
        )
    bbox = {
        key: _as_finite_number(raw.get(key), f"page {page_number} block {block_index} bbox.{key}")
        for key in ("x", "y", "w", "h")
    }
    epsilon = 1e-6
    if bbox["x"] < 0 or bbox["y"] < 0 or bbox["w"] <= 0 or bbox["h"] <= 0:
        raise ReviewError(
            f"Page {page_number} block {block_index} has a non-positive/out-of-range bbox."
        )
    if bbox["x"] + bbox["w"] > 1000 + epsilon or bbox["y"] + bbox["h"] > 1000 + epsilon:
        raise ReviewError(
            f"Page {page_number} block {block_index} bbox exceeds normalized_1000 bounds."
        )
    return bbox


def _validate_decisions(page: Mapping[str, Any], page_number: int) -> list[dict[str, Any]]:
    raw_decisions = page.get("fontDecisions")
    if not isinstance(raw_decisions, list):
        raise ReviewError(f"Page {page_number} is missing fontDecisions.")
    block_count = _as_int(page.get("blockCount"), f"page {page_number} blockCount")
    if block_count != len(raw_decisions):
        raise ReviewError(
            f"Page {page_number} blockCount={block_count} but has "
            f"{len(raw_decisions)} fontDecisions."
        )
    decisions: list[dict[str, Any]] = []
    block_ids: set[str] = set()
    for index, raw in enumerate(raw_decisions):
        if not isinstance(raw, dict):
            raise ReviewError(f"Page {page_number} block {index} is not an object.")
        reported_index = _as_int(
            raw.get("blockIndex"), f"page {page_number} block {index} blockIndex"
        )
        if reported_index != index:
            raise ReviewError(
                f"Page {page_number} decision order is incomplete: expected blockIndex "
                f"{index}, got {reported_index}."
            )
        block_id = _as_nonempty_string(
            raw.get("blockId"), f"page {page_number} block {index} blockId"
        )
        if block_id in block_ids:
            raise ReviewError(f"Page {page_number} has duplicate blockId: {block_id}")
        block_ids.add(block_id)
        if not isinstance(raw.get("applied"), bool):
            raise ReviewError(f"Page {page_number} block {index} applied must be boolean.")
        if raw["applied"]:
            _as_nonempty_string(
                raw.get("selectedFontId"),
                f"page {page_number} block {index} selectedFontId",
            )
            try:
                outline_policy.validate_applied_font_decision_outline(
                    raw,
                    location=f"Page {page_number} block {index}",
                )
            except outline_policy.FontDecisionOutlinePolicyError as exc:
                raise ReviewError(str(exc)) from exc
        bbox = _validate_bbox(raw.get("bbox"), page_number, index)
        top5 = raw.get("top5", [])
        if not isinstance(top5, list):
            raise ReviewError(f"Page {page_number} block {index} top5 must be a list.")
        decisions.append({**raw, "bbox": bbox})
    return decisions


def _validate_font_input(
    path: Path,
    *,
    page_id: str,
    source_sha256: str,
    block_count: int,
    page_number: int,
) -> None:
    value = _read_json(path, f"page {page_number} font input")
    if value.get("schemaVersion") != 1:
        raise ReviewError(f"Page {page_number} font input schemaVersion must be 1.")
    if value.get("sourcePageId") != page_id or value.get("sourcePageSha256") != source_sha256:
        raise ReviewError(f"Page {page_number} font input is bound to a different source page.")
    page = value.get("page")
    if not isinstance(page, dict) or not isinstance(page.get("blocks"), list):
        raise ReviewError(f"Page {page_number} font input page.blocks is incomplete.")
    requests = value.get("requestBlocks")
    if not isinstance(requests, list):
        raise ReviewError(f"Page {page_number} font input requestBlocks is incomplete.")
    if len(page["blocks"]) != block_count or len(requests) != block_count:
        raise ReviewError(
            f"Page {page_number} font input block coverage is incomplete "
            f"({len(page['blocks'])=} {len(requests)=} {block_count=})."
        )


def _validate_font_inference(path: Path, page_number: int) -> None:
    value = _read_json(path, f"page {page_number} font inference")
    if not value:
        raise ReviewError(f"Page {page_number} font inference is empty.")


def _load_completed_report(report_path: Path, expected_pages: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        report_path = report_path.resolve(strict=True)
    except OSError as exc:
        raise ReviewError(f"Missing run report: {report_path}: {exc}") from exc
    if not report_path.is_file():
        raise ReviewError(f"Run report is not a regular file: {report_path}")
    report = _read_json(report_path, "run report")
    if report.get("schemaVersion") != 1:
        raise ReviewError("run-report.json schemaVersion must be 1.")
    if report.get("status") != "completed" or not report.get("finishedAt"):
        raise ReviewError("run-report.json must be finished with status=completed.")
    report_page_count = _as_int(report.get("pageCount"), "run report pageCount", 1)
    if report_page_count != expected_pages:
        raise ReviewError(
            f"Expected exactly {expected_pages} completed pages, report declares "
            f"{report_page_count}."
        )
    pages = report.get("pages")
    if not isinstance(pages, list) or len(pages) != report_page_count:
        actual = len(pages) if isinstance(pages, list) else "non-list"
        raise ReviewError(
            f"run-report.json page pairing is incomplete: declared {report_page_count}, "
            f"found {actual}."
        )
    for field in ("runId", "cohort", "cohortDigest", "candidateId"):
        _as_nonempty_string(report.get(field), f"run report {field}")
    indexed_pages: list[tuple[int, dict[str, Any]]] = []
    for position, page in enumerate(pages, start=1):
        if not isinstance(page, dict):
            raise ReviewError(f"run-report.json page {position} is not an object.")
        selection_index = _as_int(
            page.get("selectionIndex"), f"run report page {position} selectionIndex"
        )
        indexed_pages.append((selection_index, page))
    ordered = [
        page
        for _selection_index, page in sorted(
            indexed_pages, key=lambda item: item[0]
        )
    ]
    expected_indexes = list(range(report_page_count))
    actual_indexes = [
        page.get("selectionIndex") if isinstance(page, dict) else None for page in ordered
    ]
    if actual_indexes != expected_indexes:
        raise ReviewError(
            f"run-report.json selectionIndex coverage must be exactly {expected_indexes}; "
            f"got {actual_indexes}."
        )
    page_ids: set[str] = set()
    for index, page in enumerate(ordered):
        number = index + 1
        if not isinstance(page, dict) or page.get("status") != "completed" or page.get("stage") != "done":
            raise ReviewError(f"Page {number} is missing, partial, or not at stage=done.")
        page_id = _as_nonempty_string(page.get("sourcePageId"), f"page {number} sourcePageId")
        if page_id in page_ids:
            raise ReviewError(f"Duplicate sourcePageId in run report: {page_id}")
        page_ids.add(page_id)
        _require_sha256(page.get("sourcePageSha256"), f"page {number} sourcePageSha256")
        _require_sha256(page.get("renderedImageSha256"), f"page {number} renderedImageSha256")
        _validate_decisions(page, number)
    return report, ordered


def _load_page(
    run_dir: Path,
    page: dict[str, Any],
    page_number: int,
) -> LoadedPage:
    page_id = str(page["sourcePageId"])
    source_sha = str(page["sourcePageSha256"])
    block_count = int(page["blockCount"])
    original_path = _resolve_reference(
        run_dir, page.get("stagedOriginalImagePath"), f"page {page_number} staged original"
    )
    raw_cleaned_path = page.get("cleanedImagePath")
    cleaned_path = (
        original_path
        if block_count == 0
        and (not isinstance(raw_cleaned_path, str) or not raw_cleaned_path.strip())
        else _resolve_reference(
            run_dir, raw_cleaned_path, f"page {page_number} cleaned image"
        )
    )
    rendered_path = _resolve_reference(
        run_dir, page.get("renderedImagePath"), f"page {page_number} rendered image"
    )
    font_input_path = _resolve_reference(
        run_dir, page.get("fontInputPath"), f"page {page_number} font input"
    )
    raw_inference_path = page.get("fontInferencePath")
    font_inference_path = (
        _resolve_reference(
            run_dir,
            raw_inference_path,
            f"page {page_number} font inference",
        )
        if raw_inference_path
        else None
    )
    if block_count and font_inference_path is None:
        raise ReviewError(f"Page {page_number} has blocks but no font inference trace.")

    original = _open_rgb(original_path, f"page {page_number} staged original")
    cleaned = _open_rgb(cleaned_path, f"page {page_number} cleaned image")
    rendered = _open_rgb(rendered_path, f"page {page_number} rendered image")
    if original.size != cleaned.size or original.size != rendered.size:
        original.close()
        cleaned.close()
        rendered.close()
        raise ReviewError(
            f"Page {page_number} image dimensions do not match: "
            f"original={original.size}, cleaned={cleaned.size}, rendered={rendered.size}."
        )

    try:
        _validate_font_input(
            font_input_path,
            page_id=page_id,
            source_sha256=source_sha,
            block_count=block_count,
            page_number=page_number,
        )
        if font_inference_path is not None:
            _validate_font_inference(font_inference_path, page_number)
        bindings: dict[str, dict[str, Any] | None] = {
            "original": _file_binding(
                original_path,
                kind="staged_original_image",
                expected_sha256=source_sha,
                image=original,
            ),
            "cleaned": _file_binding(cleaned_path, kind="cleaned_image", image=cleaned),
            "rendered": _file_binding(
                rendered_path,
                kind="rendered_image",
                expected_sha256=str(page["renderedImageSha256"]),
                image=rendered,
            ),
            "fontInput": _file_binding(font_input_path, kind="font_input_json"),
            "fontInference": _file_binding(font_inference_path, kind="font_inference_json")
            if font_inference_path is not None
            else None,
        }
    except Exception:
        original.close()
        cleaned.close()
        rendered.close()
        raise

    return LoadedPage(
        report=page,
        inputs=PageInputs(
            original=original_path,
            cleaned=cleaned_path,
            rendered=rendered_path,
            font_input=font_input_path,
            font_inference=font_inference_path,
        ),
        original=original,
        cleaned=cleaned,
        rendered=rendered,
        input_bindings=bindings,
    )


def _font_candidates(bold: bool) -> list[Path]:
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    regular_names = [
        "malgun.ttf",
        "YuGothR.ttc",
        "msgothic.ttc",
        "arialuni.ttf",
        "NotoSansCJK-Regular.ttc",
        "NotoSansKR-Regular.otf",
        "DejaVuSans.ttf",
    ]
    bold_names = [
        "malgunbd.ttf",
        "YuGothB.ttc",
        "NotoSansCJK-Bold.ttc",
        "NotoSansKR-Bold.otf",
        "DejaVuSans-Bold.ttf",
    ]
    roots = [
        windows,
        Path("/usr/share/fonts/opentype/noto"),
        Path("/usr/share/fonts/truetype/noto"),
        Path("/usr/share/fonts/truetype/dejavu"),
        Path("/Library/Fonts"),
        Path("/System/Library/Fonts"),
    ]
    return [root / name for name in (bold_names if bold else regular_names) for root in roots]


def _load_font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    for candidate in _font_candidates(bold):
        if not candidate.is_file():
            continue
        try:
            return ImageFont.truetype(str(candidate), size=size)
        except OSError:
            continue
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size=size)
    except OSError:
        return ImageFont.load_default()


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> float:
    try:
        return float(draw.textlength(text, font=font))
    except (UnicodeEncodeError, AttributeError):
        safe = text.encode("ascii", "replace").decode("ascii")
        return float(draw.textlength(safe, font=font))


def _safe_draw_text(
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


def _wrap_text(
    draw: ImageDraw.ImageDraw,
    text: Any,
    font: ImageFont.ImageFont,
    max_width: int,
    *,
    max_lines: int,
) -> list[str]:
    normalized = " ".join(str(text or "").replace("\x00", "").split())
    if not normalized:
        return [""]
    lines: list[str] = []
    current = ""
    for char in normalized:
        candidate = current + char
        if current and _text_width(draw, candidate, font) > max_width:
            lines.append(current.rstrip())
            current = char.lstrip()
            if len(lines) == max_lines:
                break
        else:
            current = candidate
    if len(lines) < max_lines and current:
        lines.append(current.rstrip())
    consumed = "".join(lines).replace(" ", "")
    original_compact = normalized.replace(" ", "")
    if len(consumed) < len(original_compact) and lines:
        tail = lines[-1]
        while tail and _text_width(draw, tail + "…", font) > max_width:
            tail = tail[:-1]
        lines[-1] = tail.rstrip() + "…"
    return lines[:max_lines]


def _draw_wrapped(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: Any,
    *,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int],
    max_width: int,
    max_lines: int,
    line_height: int,
) -> int:
    lines = _wrap_text(draw, text, font, max_width, max_lines=max_lines)
    y = xy[1]
    for line in lines:
        _safe_draw_text(draw, (xy[0], y), line, font=font, fill=fill)
        y += line_height
    return y


def _fit_image(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    scale = min(max_width / image.width, max_height / image.height, 1.0)
    size = (
        max(1, int(round(image.width * scale))),
        max(1, int(round(image.height * scale))),
    )
    return image.copy() if size == image.size else image.resize(size, Image.Resampling.LANCZOS)


def _save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", compress_level=6)


def _display_title(page: Mapping[str, Any], page_number: int) -> str:
    work = str(page.get("workTitle") or page.get("workId") or "unknown work")
    chapter = str(page.get("chapterTitle") or page.get("chapterId") or "unknown chapter")
    name = str(page.get("sourcePageName") or page.get("sourcePageId") or "unknown page")
    return f"{page_number:02d}. {work} / {chapter} / {name}"


def _render_page_pair(
    loaded: LoadedPage,
    page_number: int,
    output: Path,
    *,
    candidate_id: str,
    cohort: str,
    max_width: int,
    max_height: int,
) -> tuple[int, int]:
    original = _fit_image(loaded.original, max_width, max_height)
    rendered = _fit_image(loaded.rendered, max_width, max_height)
    gap = 18
    outer = 24
    header_height = 142
    label_height = 44
    panel_width = max(original.width, rendered.width)
    panel_height = max(original.height, rendered.height)
    canvas = Image.new(
        "RGB",
        (outer * 2 + panel_width * 2 + gap, header_height + label_height + panel_height + outer),
        PAIR_BACKGROUND,
    )
    draw = ImageDraw.Draw(canvas)
    title_font = _load_font(31, bold=True)
    meta_font = _load_font(22)
    label_font = _load_font(25, bold=True)
    title = _display_title(loaded.report, page_number)
    _draw_wrapped(
        draw,
        (outer, 18),
        title,
        font=title_font,
        fill=TEXT_PRIMARY,
        max_width=canvas.width - outer * 2,
        max_lines=2,
        line_height=38,
    )
    summary = (
        f"candidate={candidate_id} · cohort={cohort} · "
        f"blocks={loaded.report.get('blockCount', 0)} · "
        f"page_id={loaded.report.get('sourcePageId', '')}"
    )
    _draw_wrapped(
        draw,
        (outer, 96),
        summary,
        font=meta_font,
        fill=TEXT_MUTED,
        max_width=canvas.width - outer * 2,
        max_lines=1,
        line_height=28,
    )
    left_x = outer
    right_x = outer + panel_width + gap
    image_y = header_height + label_height
    for x, label in ((left_x, "ORIGINAL"), (right_x, "APP RENDERED")):
        draw.rectangle((x, header_height, x + panel_width, image_y - 4), fill=PAIR_PANEL)
        _safe_draw_text(draw, (x + 12, header_height + 7), label, font=label_font, fill=ACCENT)
    draw.rectangle((left_x, image_y, left_x + panel_width, image_y + panel_height), fill=PAIR_PANEL)
    draw.rectangle((right_x, image_y, right_x + panel_width, image_y + panel_height), fill=PAIR_PANEL)
    canvas.paste(original, (left_x + (panel_width - original.width) // 2, image_y))
    canvas.paste(rendered, (right_x + (panel_width - rendered.width) // 2, image_y))
    _save_png(canvas, output)
    size = canvas.size
    original.close()
    rendered.close()
    canvas.close()
    return size


def _bbox_to_crop_rect(
    bbox: Mapping[str, float],
    width: int,
    height: int,
    padding_ratio: float,
) -> tuple[int, int, int, int]:
    x = bbox["x"] / 1000.0 * width
    y = bbox["y"] / 1000.0 * height
    w = bbox["w"] / 1000.0 * width
    h = bbox["h"] / 1000.0 * height
    pad_x = max(12.0, w * padding_ratio)
    pad_y = max(12.0, h * padding_ratio)
    left = max(0, int(math.floor(x - pad_x)))
    top = max(0, int(math.floor(y - pad_y)))
    right = min(width, int(math.ceil(x + w + pad_x)))
    bottom = min(height, int(math.ceil(y + h + pad_y)))
    if right <= left or bottom <= top:
        raise ReviewError("Normalized bbox produced an empty pixel crop.")
    return left, top, right, bottom


def _paste_contained(
    canvas: Image.Image,
    image: Image.Image,
    box: tuple[int, int, int, int],
) -> None:
    left, top, right, bottom = box
    max_width = max(1, right - left)
    max_height = max(1, bottom - top)
    scale = min(max_width / image.width, max_height / image.height)
    size = (
        max(1, int(round(image.width * scale))),
        max(1, int(round(image.height * scale))),
    )
    fitted = image.resize(size, Image.Resampling.LANCZOS) if size != image.size else image.copy()
    canvas.paste(
        fitted,
        (left + (max_width - fitted.width) // 2, top + (max_height - fitted.height) // 2),
    )
    fitted.close()


def _format_confidence(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return "n/a"
    return f"{float(value):.3f}"


def _top5_text(decision: Mapping[str, Any]) -> str:
    values: list[str] = []
    for candidate in decision.get("top5", [])[:5]:
        if not isinstance(candidate, dict):
            continue
        font_id = str(candidate.get("fontId") or "?")
        score = candidate.get("confidence", candidate.get("totalScore"))
        values.append(f"{font_id}({_format_confidence(score)})")
    return ", ".join(values) if values else "none"


def _render_block_sheet(
    loaded: LoadedPage,
    page_number: int,
    decisions: Sequence[dict[str, Any]],
    sheet_number: int,
    sheet_count: int,
    output: Path,
    *,
    candidate_id: str,
    padding_ratio: float,
) -> tuple[tuple[int, int], list[dict[str, Any]]]:
    canvas_width = 1800
    header_height = 132
    row_height = 332
    row_gap = 10
    row_count = max(1, len(decisions))
    canvas_height = header_height + row_count * row_height + max(0, row_count - 1) * row_gap + 18
    canvas = Image.new("RGB", (canvas_width, canvas_height), PAIR_BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    title_font = _load_font(30, bold=True)
    meta_font = _load_font(22)
    small_font = _load_font(20)
    selected_font = _load_font(23, bold=True)
    title = (
        f"{_display_title(loaded.report, page_number)} · "
        f"{candidate_id} · block sheet {sheet_number}/{sheet_count}"
    )
    _draw_wrapped(
        draw,
        (22, 16),
        title,
        font=title_font,
        fill=TEXT_PRIMARY,
        max_width=canvas_width - 44,
        max_lines=2,
        line_height=36,
    )
    _safe_draw_text(
        draw,
        (22, 94),
        "Each row uses the same normalized_1000 bbox plus context padding; image pixels are not annotated.",
        font=small_font,
        fill=TEXT_MUTED,
    )
    if not decisions:
        _safe_draw_text(
            draw,
            (44, header_height + 80),
            "NO TRANSLATED BLOCKS ON THIS PAGE",
            font=title_font,
            fill=ROLE_ACCENT,
        )

    metadata_rows: list[dict[str, Any]] = []
    panel_width = 490
    panel_height = 252
    for local_index, decision in enumerate(decisions):
        row_top = header_height + local_index * (row_height + row_gap)
        row_bottom = row_top + row_height
        row_fill = (29, 33, 40) if local_index % 2 == 0 else (34, 38, 46)
        draw.rounded_rectangle((14, row_top, canvas_width - 14, row_bottom), radius=12, fill=row_fill)
        block_index = int(decision["blockIndex"])
        bbox = decision["bbox"]
        crop_rect = _bbox_to_crop_rect(
            bbox,
            loaded.original.width,
            loaded.original.height,
            padding_ratio,
        )
        original_crop = loaded.original.crop(crop_rect)
        rendered_crop = loaded.rendered.crop(crop_rect)
        left_box = (28, row_top + 54, 28 + panel_width, row_top + 54 + panel_height)
        right_box = (542, row_top + 54, 542 + panel_width, row_top + 54 + panel_height)
        draw.rectangle(left_box, fill=(245, 245, 245), outline=(92, 103, 116), width=2)
        draw.rectangle(right_box, fill=(245, 245, 245), outline=(92, 103, 116), width=2)
        _paste_contained(canvas, original_crop, left_box)
        _paste_contained(canvas, rendered_crop, right_box)
        _safe_draw_text(draw, (28, row_top + 17), f"BLOCK {block_index:02d} · ORIGINAL", font=meta_font, fill=ACCENT)
        _safe_draw_text(draw, (542, row_top + 17), "APP RENDERED", font=meta_font, fill=ACCENT)

        meta_x = 1056
        meta_width = canvas_width - meta_x - 28
        role = decision.get("role") or "unknown"
        font_id = decision.get("selectedFontId") or "unapplied"
        _safe_draw_text(
            draw,
            (meta_x, row_top + 18),
            f"role={role}",
            font=selected_font,
            fill=ROLE_ACCENT,
        )
        _draw_wrapped(
            draw,
            (meta_x, row_top + 50),
            f"font={font_id}  applied={decision.get('applied')}  confidence={_format_confidence(decision.get('confidence'))}",
            font=selected_font,
            fill=ACCENT,
            max_width=meta_width,
            max_lines=2,
            line_height=29,
        )
        y = row_top + 110
        y = _draw_wrapped(
            draw,
            (meta_x, y),
            f"source: {decision.get('sourceText') or ''}",
            font=small_font,
            fill=TEXT_MUTED,
            max_width=meta_width,
            max_lines=2,
            line_height=25,
        )
        y = _draw_wrapped(
            draw,
            (meta_x, y + 2),
            f"ko: {decision.get('translatedText') or ''}",
            font=small_font,
            fill=TEXT_PRIMARY,
            max_width=meta_width,
            max_lines=2,
            line_height=25,
        )
        _draw_wrapped(
            draw,
            (meta_x, y + 4),
            f"top5: {_top5_text(decision)}",
            font=small_font,
            fill=TEXT_MUTED,
            max_width=meta_width,
            max_lines=2,
            line_height=25,
        )
        metadata_rows.append(
            {
                "blockIndex": block_index,
                "blockId": decision.get("blockId"),
                "bboxNormalized1000": bbox,
                "cropRectPixels": list(crop_rect),
                "sourceText": decision.get("sourceText") or "",
                "translatedText": decision.get("translatedText") or "",
                "applied": decision.get("applied"),
                "selectedFontId": decision.get("selectedFontId"),
                "effectiveFontFamily": decision.get("effectiveFontFamily"),
                "role": decision.get("role"),
                "confidence": decision.get("confidence"),
                "source": decision.get("source"),
                "selectionCalibration": decision.get("selectionCalibration"),
                "noneAcceptable": decision.get("noneAcceptable"),
                "localConfidence": decision.get("localConfidence"),
                "top5": decision.get("top5", []),
                "manualVerdict": None,
                "manualNotes": "",
            }
        )
        original_crop.close()
        rendered_crop.close()

    _save_png(canvas, output)
    size = canvas.size
    canvas.close()
    return size, metadata_rows


def _generated_binding(path: Path, root: Path, *, kind: str, image_size: tuple[int, int] | None = None) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    binding: dict[str, Any] = {
        "kind": kind,
        "path": relative,
        "size": path.stat().st_size,
        "sha256": sha256_file(path),
    }
    if image_size is not None:
        binding["width"], binding["height"] = image_size
    return binding


def _unique_input_bindings(page_rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    by_path: dict[str, dict[str, Any]] = {}
    for row in page_rows:
        for value in row["inputs"].values():
            if value is None:
                continue
            previous = by_path.get(value["path"])
            if previous is not None:
                if not _same_input_snapshot(previous, value):
                    raise ReviewError(f"Conflicting bindings for input: {value['path']}")
                continue
            by_path[value["path"]] = value
    return [by_path[path] for path in sorted(by_path)]


def _same_input_snapshot(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    """Compare one physical input while allowing page-specific role labels."""
    return {
        key: value for key, value in left.items() if key != "kind"
    } == {
        key: value for key, value in right.items() if key != "kind"
    }


def _write_review_instructions(path: Path, report: Mapping[str, Any], page_count: int) -> None:
    content = textwrap.dedent(
        f"""\
        Library full-pipeline font QA visual review

        Candidate: {report.get('candidateId')}
        Cohort: {report.get('cohort')}
        Pages: {page_count}

        Inspect files in inspection-order.txt from top to bottom.  For every page:
        1. Open page-NNN-pair.png and compare the complete original/app-rendered page.
        2. Open every following block sheet and judge font role, style, consistency,
           legibility, overflow, and whether unusual SFX/handwriting/emphasis was kept.
        3. Record verdicts in a COPY of block-review.jsonl.  Editing this sealed pack
           intentionally makes validation fail.

        Validate before and after review:
          python scripts/build_library_font_qa_visual_review.py validate --review-dir <this-directory>

        This pack is an inspection aid.  It never constitutes automatic model acceptance.
        """
    )
    path.write_text(content, encoding="utf-8", newline="\n")


def _snapshot_matches(binding: Mapping[str, Any]) -> bool:
    path = Path(str(binding["path"]))
    try:
        return (
            path.is_file()
            and path.stat().st_size == binding["size"]
            and sha256_file(path) == binding["sha256"]
        )
    except (OSError, ReviewError):
        return False


def build_review(options: BuildOptions) -> dict[str, Any]:
    if options.expected_pages <= 0:
        raise ReviewError("expected_pages must be positive.")
    if options.pair_page_max_width < 256 or options.pair_page_max_height < 256:
        raise ReviewError("Pair preview dimensions must be at least 256 pixels.")
    if options.blocks_per_sheet <= 0 or options.blocks_per_sheet > 20:
        raise ReviewError("blocks_per_sheet must be between 1 and 20.")
    if not 0 <= options.crop_padding_ratio <= 2:
        raise ReviewError("crop_padding_ratio must be between 0 and 2.")

    try:
        report_path = options.report_path.resolve(strict=True)
    except OSError as exc:
        raise ReviewError(f"Missing run report: {options.report_path}: {exc}") from exc
    if not report_path.is_file():
        raise ReviewError(f"Run report is not a regular file: {report_path}")
    run_dir = report_path.parent.resolve(strict=True)
    output_dir = options.output_dir.resolve(strict=False)
    if output_dir.exists():
        raise ReviewError(f"Refusing to overwrite existing review output: {output_dir}")
    if _is_relative_to(output_dir, run_dir):
        raise ReviewError("Review output must be outside the source run directory.")
    output_dir.parent.mkdir(parents=True, exist_ok=True)

    report, pages = _load_completed_report(report_path, options.expected_pages)
    report_binding = _file_binding(report_path, kind="run_report_json")
    temp_dir = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.tmp-", dir=output_dir.parent)
    ).resolve()
    try:
        page_rows: list[dict[str, Any]] = []
        generated: list[dict[str, Any]] = []
        decision_rows: list[dict[str, Any]] = []
        inspection_relative_paths: list[str] = []
        for page_index, page in enumerate(pages):
            page_number = page_index + 1
            loaded = _load_page(run_dir, page, page_number)
            try:
                pair_relative = f"pages/page-{page_number:03d}-pair.png"
                pair_path = temp_dir / Path(pair_relative)
                pair_size = _render_page_pair(
                    loaded,
                    page_number,
                    pair_path,
                    candidate_id=str(report["candidateId"]),
                    cohort=str(report["cohort"]),
                    max_width=options.pair_page_max_width,
                    max_height=options.pair_page_max_height,
                )
                pair_binding = _generated_binding(
                    pair_path, temp_dir, kind="page_pair_png", image_size=pair_size
                )
                generated.append(pair_binding)
                inspection_relative_paths.append(pair_relative)

                decisions = _validate_decisions(page, page_number)
                chunks = [
                    decisions[index : index + options.blocks_per_sheet]
                    for index in range(0, len(decisions), options.blocks_per_sheet)
                ] or [[]]
                block_sheets: list[dict[str, Any]] = []
                for sheet_index, chunk in enumerate(chunks):
                    sheet_number = sheet_index + 1
                    sheet_relative = (
                        f"blocks/page-{page_number:03d}-blocks-{sheet_number:02d}.png"
                    )
                    sheet_path = temp_dir / Path(sheet_relative)
                    sheet_size, rows = _render_block_sheet(
                        loaded,
                        page_number,
                        chunk,
                        sheet_number,
                        len(chunks),
                        sheet_path,
                        candidate_id=str(report["candidateId"]),
                        padding_ratio=options.crop_padding_ratio,
                    )
                    binding = _generated_binding(
                        sheet_path,
                        temp_dir,
                        kind="block_comparison_sheet_png",
                        image_size=sheet_size,
                    )
                    binding["blockIndexes"] = [row["blockIndex"] for row in rows]
                    generated.append(binding)
                    block_sheets.append(binding)
                    inspection_relative_paths.append(sheet_relative)
                    for row in rows:
                        decision_rows.append(
                            {
                                "schemaVersion": SCHEMA_VERSION,
                                "selectionIndex": page_index,
                                "pageNumber": page_number,
                                "sourcePageId": page["sourcePageId"],
                                "workId": page.get("workId"),
                                "workTitle": page.get("workTitle"),
                                "chapterId": page.get("chapterId"),
                                "chapterTitle": page.get("chapterTitle"),
                                "sourcePageName": page.get("sourcePageName"),
                                "pagePairPath": pair_relative,
                                "blockSheetPath": sheet_relative,
                                **row,
                            }
                        )
                page_rows.append(
                    {
                        "selectionIndex": page_index,
                        "pageNumber": page_number,
                        "sourcePageId": page["sourcePageId"],
                        "sourcePageName": page.get("sourcePageName"),
                        "workId": page.get("workId"),
                        "workTitle": page.get("workTitle"),
                        "chapterId": page.get("chapterId"),
                        "chapterTitle": page.get("chapterTitle"),
                        "blockCount": page["blockCount"],
                        "inputs": loaded.input_bindings,
                        "pagePair": pair_binding,
                        "blockSheets": block_sheets,
                    }
                )
            finally:
                loaded.original.close()
                loaded.cleaned.close()
                loaded.rendered.close()

        decisions_path = temp_dir / DECISIONS_NAME
        decisions_path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                + "\n"
                for row in decision_rows
            ),
            encoding="utf-8",
            newline="\n",
        )
        generated.append(_generated_binding(decisions_path, temp_dir, kind="block_review_jsonl"))

        order_path = temp_dir / ORDER_NAME
        final_order = [str((output_dir / relative).resolve()) for relative in inspection_relative_paths]
        order_path.write_text("\n".join(final_order) + "\n", encoding="utf-8", newline="\n")
        generated.append(_generated_binding(order_path, temp_dir, kind="inspection_order_text"))

        instructions_path = temp_dir / README_NAME
        _write_review_instructions(instructions_path, report, len(page_rows))
        generated.append(_generated_binding(instructions_path, temp_dir, kind="review_instructions_text"))

        input_bindings = _unique_input_bindings(page_rows)
        generated.sort(key=lambda row: row["path"])
        binding = {
            "schemaVersion": SCHEMA_VERSION,
            "sourceReport": report_binding,
            "runIdentity": {
                "runId": report["runId"],
                "cohort": report["cohort"],
                "cohortDigest": report["cohortDigest"],
                "candidateId": report["candidateId"],
                "pageCount": len(page_rows),
            },
            "inputs": input_bindings,
            "generated": generated,
        }
        index = {
            "schemaVersion": SCHEMA_VERSION,
            "tool": {"id": TOOL_ID, "version": TOOL_VERSION},
            "reviewStatus": "manual_visual_review_required",
            "sourceRunDirectory": str(run_dir),
            "outputDirectory": str(output_dir),
            "expectedPageCount": options.expected_pages,
            "reviewContract": {
                "bboxSpace": "normalized_1000",
                "pairPageMaxWidth": options.pair_page_max_width,
                "pairPageMaxHeight": options.pair_page_max_height,
                "blocksPerSheet": options.blocks_per_sheet,
                "cropPaddingRatio": options.crop_padding_ratio,
                "originalPixelsAnnotated": False,
                "renderedPixelsAnnotated": False,
                "manualAcceptanceRequired": True,
            },
            "pages": page_rows,
            "blockReviewRows": len(decision_rows),
            "inspectionAssets": len(inspection_relative_paths),
            "binding": binding,
            "bindingSha256": sha256_bytes(canonical_json_bytes(binding)),
        }
        index_path = temp_dir / INDEX_NAME
        _write_json(index_path, index)
        index_sha256 = sha256_file(index_path)
        (temp_dir / INDEX_SEAL_NAME).write_text(
            f"{index_sha256}  {INDEX_NAME}\n", encoding="ascii", newline="\n"
        )

        for input_binding in [report_binding, *input_bindings]:
            if not _snapshot_matches(input_binding):
                raise ReviewError(
                    f"Source/run input changed while the review was being built: "
                    f"{input_binding['path']}"
                )
        validate_review(temp_dir, expected_output_directory=output_dir)
        temp_dir.rename(output_dir)
        summary = validate_review(output_dir)
        return {
            **summary,
            "outputDirectory": str(output_dir),
            "indexPath": str(output_dir / INDEX_NAME),
            "inspectionOrderPath": str(output_dir / ORDER_NAME),
        }
    except Exception:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        raise


def _validate_relative_output_path(root: Path, raw: Any, field: str) -> Path:
    text = _as_nonempty_string(raw, field)
    relative = Path(text)
    if relative.is_absolute() or ".." in relative.parts:
        raise ReviewError(f"{field} must be a safe relative path: {text}")
    target = (root / relative).resolve(strict=False)
    if not _is_relative_to(target, root):
        raise ReviewError(f"{field} escapes the review directory: {text}")
    return target


def _validate_actual_binding(binding: Mapping[str, Any], *, generated_root: Path | None = None) -> None:
    if generated_root is None:
        path = Path(_as_nonempty_string(binding.get("path"), "input binding path"))
        try:
            path = path.resolve(strict=True)
        except OSError as exc:
            raise ReviewError(f"Missing sealed input: {path}: {exc}") from exc
    else:
        path = _validate_relative_output_path(
            generated_root, binding.get("path"), "generated binding path"
        )
        if not path.is_file():
            raise ReviewError(f"Missing generated review file: {path}")
    expected_size = _as_int(binding.get("size"), f"binding size for {path}")
    expected_sha = _require_sha256(binding.get("sha256"), f"binding SHA-256 for {path}")
    if not path.is_file() or path.stat().st_size != expected_size:
        raise ReviewError(f"Sealed file size changed: {path}")
    actual_sha = sha256_file(path)
    if actual_sha != expected_sha:
        raise ReviewError(
            f"Sealed file SHA-256 changed: expected {expected_sha}, got {actual_sha}: {path}"
        )
    if "width" in binding or "height" in binding:
        expected_width = _as_int(binding.get("width"), f"binding width for {path}", 1)
        expected_height = _as_int(binding.get("height"), f"binding height for {path}", 1)
        image = _open_rgb(path, f"sealed image {path}")
        try:
            if image.size != (expected_width, expected_height):
                raise ReviewError(f"Sealed image dimensions changed: {path}")
        finally:
            image.close()


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ReviewError(f"Could not read {label}: {path}: {exc}") from exc
    for line_number, line in enumerate(lines, start=1):
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ReviewError(f"Invalid {label} line {line_number}: {exc}") from exc
        if not isinstance(value, dict):
            raise ReviewError(f"{label} line {line_number} is not an object.")
        rows.append(value)
    return rows


def _validate_index_relationships(
    *,
    root: Path,
    recorded_output: Path,
    index: Mapping[str, Any],
    binding: Mapping[str, Any],
    generated_by_path: Mapping[str, dict[str, Any]],
    input_by_path: Mapping[str, dict[str, Any]],
    report: Mapping[str, Any],
    report_pages: Sequence[dict[str, Any]],
) -> tuple[int, int]:
    identity = binding.get("runIdentity")
    if not isinstance(identity, dict):
        raise ReviewError("Visual review runIdentity is missing.")
    for field in ("runId", "cohort", "cohortDigest", "candidateId"):
        if identity.get(field) != report.get(field):
            raise ReviewError(f"Visual review runIdentity.{field} does not match run-report.json.")

    page_count = _as_int(index.get("expectedPageCount"), "expectedPageCount", 1)
    if identity.get("pageCount") != page_count or report.get("pageCount") != page_count:
        raise ReviewError("Visual review page count does not match its bound run.")
    pages = index.get("pages")
    if not isinstance(pages, list) or len(pages) != page_count:
        raise ReviewError("Visual review index page coverage is incomplete.")
    page_numbers = [page.get("pageNumber") if isinstance(page, dict) else None for page in pages]
    if page_numbers != list(range(1, page_count + 1)):
        raise ReviewError("Visual review index page order is incomplete.")

    expected_inspection_paths: list[str] = []
    expected_decision_rows: dict[tuple[int, int], tuple[dict[str, Any], dict[str, Any], str]] = {}
    for offset, (page_index, report_page) in enumerate(zip(pages, report_pages, strict=True)):
        page_number = offset + 1
        if not isinstance(page_index, dict):
            raise ReviewError(f"Visual review page {page_number} is not an object.")
        for field in (
            "selectionIndex",
            "sourcePageId",
            "sourcePageName",
            "workId",
            "workTitle",
            "chapterId",
            "chapterTitle",
            "blockCount",
        ):
            if page_index.get(field) != report_page.get(field):
                raise ReviewError(
                    f"Visual review page {page_number} {field} does not match run-report.json."
                )
        inputs = page_index.get("inputs")
        if not isinstance(inputs, dict) or set(inputs) != {
            "original",
            "cleaned",
            "rendered",
            "fontInput",
            "fontInference",
        }:
            raise ReviewError(f"Visual review page {page_number} input bindings are incomplete.")
        expected_input_kinds = {
            "original": "staged_original_image",
            "cleaned": "cleaned_image",
            "rendered": "rendered_image",
            "fontInput": "font_input_json",
            "fontInference": "font_inference_json",
        }
        for input_name, input_binding in inputs.items():
            if input_binding is None:
                continue
            if not isinstance(input_binding, dict):
                raise ReviewError(f"Visual review page {page_number} has an invalid input binding.")
            if input_binding.get("kind") != expected_input_kinds[input_name]:
                raise ReviewError(
                    f"Visual review page {page_number} {input_name} input has the wrong kind."
                )
            input_path = input_binding.get("path")
            sealed_input = input_by_path.get(input_path)
            if sealed_input is None or not _same_input_snapshot(
                sealed_input, input_binding
            ):
                raise ReviewError(
                    f"Visual review page {page_number} input is absent from the sealed binding."
                )

        pair = page_index.get("pagePair")
        if not isinstance(pair, dict) or generated_by_path.get(pair.get("path")) != pair:
            raise ReviewError(f"Visual review page {page_number} pair PNG is not sealed.")
        if pair.get("kind") != "page_pair_png":
            raise ReviewError(f"Visual review page {page_number} pair has the wrong asset kind.")
        pair_path = str(pair["path"])
        expected_inspection_paths.append(pair_path)

        sheets = page_index.get("blockSheets")
        if not isinstance(sheets, list) or not sheets:
            raise ReviewError(f"Visual review page {page_number} has no block comparison sheet.")
        covered_indexes: list[int] = []
        sheet_for_block: dict[int, str] = {}
        for sheet in sheets:
            if not isinstance(sheet, dict) or generated_by_path.get(sheet.get("path")) != sheet:
                raise ReviewError(f"Visual review page {page_number} has an unsealed block sheet.")
            if sheet.get("kind") != "block_comparison_sheet_png":
                raise ReviewError(f"Visual review page {page_number} block sheet has the wrong kind.")
            indexes = sheet.get("blockIndexes")
            if not isinstance(indexes, list) or any(
                isinstance(value, bool) or not isinstance(value, int) for value in indexes
            ):
                raise ReviewError(f"Visual review page {page_number} blockIndexes are invalid.")
            sheet_path = str(sheet["path"])
            expected_inspection_paths.append(sheet_path)
            for block_index in indexes:
                if block_index in sheet_for_block:
                    raise ReviewError(
                        f"Visual review page {page_number} block {block_index} appears on multiple sheets."
                    )
                covered_indexes.append(block_index)
                sheet_for_block[block_index] = sheet_path
        block_count = int(report_page["blockCount"])
        if covered_indexes != list(range(block_count)):
            raise ReviewError(
                f"Visual review page {page_number} block-sheet coverage is incomplete: "
                f"{covered_indexes}."
            )
        report_decisions = _validate_decisions(report_page, page_number)
        for decision in report_decisions:
            block_index = int(decision["blockIndex"])
            expected_decision_rows[(page_number, block_index)] = (
                report_page,
                decision,
                sheet_for_block[block_index],
            )

    inspection_assets = _as_int(index.get("inspectionAssets"), "inspectionAssets", 1)
    if inspection_assets != len(expected_inspection_paths):
        raise ReviewError("Visual review inspection asset count is inconsistent.")
    order_lines = (root / ORDER_NAME).read_text(encoding="utf-8").splitlines()
    expected_order_lines = [
        str((recorded_output / relative).resolve(strict=False))
        for relative in expected_inspection_paths
    ]
    if order_lines != expected_order_lines:
        raise ReviewError("inspection-order.txt does not cover every page and block sheet in order.")

    review_rows = _read_jsonl(root / DECISIONS_NAME, "block review metadata")
    if len(review_rows) != len(expected_decision_rows):
        raise ReviewError("block-review.jsonl row count is incomplete.")
    seen_rows: set[tuple[int, int]] = set()
    comparable_fields = (
        "applied",
        "selectedFontId",
        "effectiveFontFamily",
        "role",
        "confidence",
        "source",
        "selectionCalibration",
        "noneAcceptable",
        "localConfidence",
        "top5",
    )
    for row in review_rows:
        page_number = _as_int(row.get("pageNumber"), "block review pageNumber", 1)
        block_index = _as_int(row.get("blockIndex"), "block review blockIndex")
        key = (page_number, block_index)
        if key in seen_rows or key not in expected_decision_rows:
            raise ReviewError(f"block-review.jsonl has a duplicate or unknown row: {key}.")
        seen_rows.add(key)
        report_page, decision, sheet_path = expected_decision_rows[key]
        if (
            row.get("sourcePageId") != report_page.get("sourcePageId")
            or row.get("sourceText") != (decision.get("sourceText") or "")
            or row.get("translatedText") != (decision.get("translatedText") or "")
            or row.get("bboxNormalized1000") != decision.get("bbox")
            or row.get("blockSheetPath") != sheet_path
            or row.get("manualVerdict") is not None
            or row.get("manualNotes") != ""
        ):
            raise ReviewError(f"block-review.jsonl metadata drifted for row {key}.")
        for field in comparable_fields:
            if row.get(field) != decision.get(field):
                raise ReviewError(f"block-review.jsonl {field} drifted for row {key}.")
    if seen_rows != set(expected_decision_rows):
        raise ReviewError("block-review.jsonl coverage is incomplete.")
    if len(review_rows) != _as_int(index.get("blockReviewRows"), "blockReviewRows"):
        raise ReviewError("Block review row coverage is incomplete.")
    return page_count, len(review_rows)


def validate_review(
    review_dir: Path,
    *,
    expected_output_directory: Path | None = None,
) -> dict[str, Any]:
    try:
        root = review_dir.resolve(strict=True)
    except OSError as exc:
        raise ReviewError(f"Missing review directory: {review_dir}: {exc}") from exc
    if not root.is_dir():
        raise ReviewError(f"Review path is not a directory: {root}")
    index_path = root / INDEX_NAME
    seal_path = root / INDEX_SEAL_NAME
    if not index_path.is_file() or not seal_path.is_file():
        raise ReviewError("Review index or SHA-256 seal is missing.")
    try:
        seal_parts = seal_path.read_text(encoding="ascii").strip().split()
    except (OSError, UnicodeError) as exc:
        raise ReviewError(f"Could not read review index seal: {exc}") from exc
    if len(seal_parts) != 2 or seal_parts[1] != INDEX_NAME or not SHA256_RE.fullmatch(seal_parts[0]):
        raise ReviewError("Review index SHA-256 seal has invalid syntax.")
    actual_index_sha = sha256_file(index_path)
    if actual_index_sha != seal_parts[0]:
        raise ReviewError("Review index does not match its SHA-256 seal.")
    index = _read_json(index_path, "visual review index")
    if index.get("schemaVersion") != SCHEMA_VERSION:
        raise ReviewError("Unsupported visual review index schemaVersion.")
    if index.get("tool") != {"id": TOOL_ID, "version": TOOL_VERSION}:
        raise ReviewError("Visual review index was produced by an unsupported tool version.")
    if index.get("reviewStatus") != "manual_visual_review_required":
        raise ReviewError("Visual review index has an invalid review status.")
    if expected_output_directory is not None:
        recorded_output = Path(
            _as_nonempty_string(index.get("outputDirectory"), "index outputDirectory")
        ).resolve(strict=False)
        if recorded_output != expected_output_directory.resolve(strict=False):
            raise ReviewError("Temporary review pack is bound to a different final output path.")
    else:
        recorded_output = Path(
            _as_nonempty_string(index.get("outputDirectory"), "index outputDirectory")
        ).resolve(strict=False)
        if recorded_output != root:
            raise ReviewError(
                f"Review directory moved after sealing: expected {recorded_output}, got {root}."
            )

    binding = index.get("binding")
    if not isinstance(binding, dict):
        raise ReviewError("Visual review index binding is missing.")
    expected_binding_sha = _require_sha256(index.get("bindingSha256"), "bindingSha256")
    if sha256_bytes(canonical_json_bytes(binding)) != expected_binding_sha:
        raise ReviewError("Visual review binding digest is invalid.")
    source_report = binding.get("sourceReport")
    inputs = binding.get("inputs")
    generated = binding.get("generated")
    if not isinstance(source_report, dict) or not isinstance(inputs, list) or not isinstance(generated, list):
        raise ReviewError("Visual review binding lists are incomplete.")
    _validate_actual_binding(source_report)
    seen_inputs: set[str] = set()
    input_by_path: dict[str, dict[str, Any]] = {}
    for input_binding in inputs:
        if not isinstance(input_binding, dict):
            raise ReviewError("Input binding is not an object.")
        path = _as_nonempty_string(input_binding.get("path"), "input binding path")
        if path in seen_inputs:
            raise ReviewError(f"Duplicate sealed input binding: {path}")
        seen_inputs.add(path)
        input_by_path[path] = input_binding
        _validate_actual_binding(input_binding)

    seen_generated: set[str] = set()
    generated_by_path: dict[str, dict[str, Any]] = {}
    for generated_binding in generated:
        if not isinstance(generated_binding, dict):
            raise ReviewError("Generated binding is not an object.")
        relative = _as_nonempty_string(generated_binding.get("path"), "generated binding path")
        if relative in seen_generated:
            raise ReviewError(f"Duplicate generated binding: {relative}")
        seen_generated.add(relative)
        generated_by_path[relative] = generated_binding
        _validate_actual_binding(generated_binding, generated_root=root)
    actual_files = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }
    expected_files = seen_generated | {INDEX_NAME, INDEX_SEAL_NAME}
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        raise ReviewError(
            f"Review directory file set drifted; missing={missing}, extra={extra}."
        )

    source_report_path = Path(str(source_report["path"]))
    page_count = _as_int(index.get("expectedPageCount"), "expectedPageCount", 1)
    report, report_pages = _load_completed_report(source_report_path, page_count)
    page_count, decision_count = _validate_index_relationships(
        root=root,
        recorded_output=recorded_output,
        index=index,
        binding=binding,
        generated_by_path=generated_by_path,
        input_by_path=input_by_path,
        report=report,
        report_pages=report_pages,
    )
    return {
        "ok": True,
        "pages": page_count,
        "blocks": decision_count,
        "inspectionAssets": _as_int(index.get("inspectionAssets"), "inspectionAssets", 1),
        "candidateId": binding.get("runIdentity", {}).get("candidateId"),
        "cohort": binding.get("runIdentity", {}).get("cohort"),
        "bindingSha256": expected_binding_sha,
        "indexSha256": actual_index_sha,
    }


def _default_output(report_path: Path) -> Path:
    run_dir = report_path.resolve(strict=False).parent
    return run_dir.parent / f"{run_dir.name}-visual-review"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build or validate sealed no-GUI visual review packs for library font QA."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="Build a new sealed visual review pack.")
    build.add_argument("--run-report", type=Path, required=True, help="Completed run-report.json.")
    build.add_argument(
        "--output",
        type=Path,
        help="New output directory outside the run (default: sibling <run>-visual-review).",
    )
    build.add_argument("--expected-pages", type=int, default=40)
    build.add_argument("--pair-page-max-width", type=int, default=1200)
    build.add_argument("--pair-page-max-height", type=int, default=1800)
    build.add_argument("--blocks-per-sheet", type=int, default=6)
    build.add_argument("--crop-padding-ratio", type=float, default=0.35)

    validate = subparsers.add_parser("validate", help="Re-hash and validate an existing pack.")
    validate.add_argument("--review-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            report_path = args.run_report
            output = args.output or _default_output(report_path)
            result = build_review(
                BuildOptions(
                    report_path=report_path,
                    output_dir=output,
                    expected_pages=args.expected_pages,
                    pair_page_max_width=args.pair_page_max_width,
                    pair_page_max_height=args.pair_page_max_height,
                    blocks_per_sheet=args.blocks_per_sheet,
                    crop_padding_ratio=args.crop_padding_ratio,
                )
            )
        else:
            result = validate_review(args.review_dir)
    except ReviewError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
