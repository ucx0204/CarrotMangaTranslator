#!/usr/bin/env python3
"""Enrich a FontClip crop manifest with CTD glyph masks.

The input manifest is grouped by source page so ComicTextMasker performs exactly
one ONNX inference for every page.  Each usable OCR box produces a tightly
masked source-colour glyph, its binary mask, a lightly padded source context,
and aspect-preserving 224px glyph/context images.

Progress is committed as one atomic shard per page.  An interrupted invocation
can therefore be run again with the same arguments without repeating completed
page inference.  ``--overwrite`` only removes outputs carrying this script's
ownership marker.
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
import unicodedata
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from PIL import Image

try:
    from fontclip_glyph_mask import (
        DEFAULT_CONFIG_PATH,
        DEFAULT_MODEL_PATH,
        DEFAULT_PREPROCESSOR_PATH,
        ComicTextMasker,
    )
except ImportError:  # Supports ``python -m scripts.enrich_fontclip_dataset_masks``.
    from scripts.fontclip_glyph_mask import (  # type: ignore[no-redef]
        DEFAULT_CONFIG_PATH,
        DEFAULT_MODEL_PATH,
        DEFAULT_PREPROCESSOR_PATH,
        ComicTextMasker,
    )


TOOL_ID = "manga-translator-fontclip-mask-enricher"
SCHEMA_VERSION = 3
LEGACY_MARKER_SCHEMA_VERSIONS = frozenset({1, 2})
LETTERBOX_SIZE = 224
MARKER_NAME = ".fontclip-mask-enrichment.json"
STATE_DIR_NAME = ".fontclip-mask-pages"
MASKED_MANIFEST_NAME = "manifest_masked.jsonl"
HIGH_PRECISION_MANIFEST_NAME = "manifest_masked_high_precision.jsonl"
REJECTS_MANIFEST_NAME = "mask_rejects.jsonl"

OUTPUT_DIR_NAMES = {
    "context": "images/masked_context",
    "glyph_rgba": "images/masked_glyph_rgba",
    "mask": "images/masked_mask",
    "glyph_224": "images/masked_glyph_224",
    "context_224": "images/masked_context_224",
}

HIGH_PRECISION_GATE = {
    "tier": "A",
    "minimum_ocr_score": 0.95,
    "minimum_meaningful_chars": 2,
    "minimum_ink_ratio": 0.01,
    "maximum_ink_ratio": 0.60,
    "maximum_border_contact_ratio": 0.02,
    "minimum_font_axis_size_px": 18,
    "requires_nonempty_mask": True,
}


class EnrichmentError(RuntimeError):
    """Expected command-line/data error."""


class UnsafeOverwriteError(EnrichmentError):
    """Raised when existing output cannot be proven to belong to this tool."""


@dataclass(frozen=True)
class InputRow:
    line_number: int
    row: dict[str, Any]
    page_path: Path
    page_key: str
    bbox_xyxy: tuple[float, float, float, float]


@dataclass(frozen=True)
class OutputLayout:
    dataset: Path
    marker: Path
    state_dir: Path
    masked_manifest: Path
    high_precision_manifest: Path
    rejects_manifest: Path
    image_dirs: dict[str, Path]

    @property
    def owned_paths(self) -> tuple[Path, ...]:
        return (
            self.state_dir,
            self.masked_manifest,
            self.high_precision_manifest,
            self.rejects_manifest,
            *self.image_dirs.values(),
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _content_signature(path: Path) -> dict[str, Any]:
    """Return an exact, JSON-stable signature for one required file."""

    resolved = path.expanduser().resolve()
    stat = resolved.stat()
    if not resolved.is_file():
        raise FileNotFoundError(f"signature target is not a file: {resolved}")
    return {
        "path": str(resolved),
        "size": stat.st_size,
        "sha256": _sha256_file(resolved),
    }


def _optional_content_signature(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    resolved = Path(value).expanduser().resolve()
    if not resolved.is_file():
        return {
            "path": str(resolved),
            "size": None,
            "sha256": None,
            "missing": True,
        }
    return _content_signature(resolved)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_write_jsonl(path: Path, records: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(_canonical_json(record))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_save_png(path: Path, pixels: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        Image.fromarray(np.asarray(pixels)).save(
            temporary,
            format="PNG",
            optimize=False,
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _output_layout(dataset: Path) -> OutputLayout:
    return OutputLayout(
        dataset=dataset,
        marker=dataset / MARKER_NAME,
        state_dir=dataset / STATE_DIR_NAME,
        masked_manifest=dataset / MASKED_MANIFEST_NAME,
        high_precision_manifest=dataset / HIGH_PRECISION_MANIFEST_NAME,
        rejects_manifest=dataset / REJECTS_MANIFEST_NAME,
        image_dirs={
            name: dataset / relative
            for name, relative in OUTPUT_DIR_NAMES.items()
        },
    )


def _load_marker(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UnsafeOverwriteError(
            f"cannot verify mask-enrichment marker {path}: {exc}"
        ) from exc
    if (
        not isinstance(payload, dict)
        or payload.get("tool") != TOOL_ID
        or payload.get("schema_version")
        not in {SCHEMA_VERSION, *LEGACY_MARKER_SCHEMA_VERSIONS}
    ):
        raise UnsafeOverwriteError(
            f"refusing to use unrecognized mask-enrichment marker: {path}"
        )
    return payload


def _safe_remove_owned(path: Path, dataset: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if not _is_within(path, dataset) or path.resolve() == dataset.resolve():
        raise UnsafeOverwriteError(f"refusing to remove unsafe path: {path}")
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _prepare_output(
    layout: OutputLayout,
    *,
    signature: Mapping[str, Any],
    overwrite: bool,
) -> bool:
    """Prepare output and return whether this invocation is a resume."""

    marker = _load_marker(layout.marker)
    existing_owned = [path for path in layout.owned_paths if path.exists()]
    expected_owned_outputs = [
        path.relative_to(layout.dataset).as_posix()
        for path in layout.owned_paths
    ]
    if marker is not None:
        marker_signature = marker.get("signature")
        if (
            marker.get("owned_outputs") != expected_owned_outputs
            or not isinstance(marker_signature, dict)
            or marker_signature.get("dataset") != str(layout.dataset)
        ):
            raise UnsafeOverwriteError(
                "refusing to trust a mask-enrichment marker whose dataset or "
                f"owned-output list does not match this run: {layout.marker}"
            )

    if overwrite:
        if (existing_owned or layout.marker.exists()) and marker is None:
            raise UnsafeOverwriteError(
                "refusing --overwrite because the exact mask-enrichment "
                f"marker is absent: {layout.marker}"
            )
        if marker is not None:
            for path in layout.owned_paths:
                _safe_remove_owned(path, layout.dataset)
        marker = None
    elif marker is None and existing_owned:
        raise UnsafeOverwriteError(
            "mask outputs already exist without this tool's marker; pass "
            "--overwrite only after restoring the exact marker or move the "
            f"conflicting paths: {existing_owned[0]}"
        )
    elif (
        marker is not None
        and marker.get("schema_version") != SCHEMA_VERSION
    ):
        raise EnrichmentError(
            "the existing mask dataset uses legacy enrichment schema "
            f"v{marker.get('schema_version')}; pass --overwrite to perform "
            "a guarded rebuild with the current schema"
        )
    elif marker is not None and marker.get("signature") != signature:
        raise EnrichmentError(
            "the input manifest or mask configuration changed since the "
            "previous run; pass --overwrite to start a guarded rebuild"
        )

    resumed = marker is not None
    if marker is None:
        _atomic_write_json(
            layout.marker,
            {
                "tool": TOOL_ID,
                "schema_version": SCHEMA_VERSION,
                "created_at": _utc_now(),
                "signature": dict(signature),
                "owned_outputs": expected_owned_outputs,
            },
        )

    layout.state_dir.mkdir(parents=True, exist_ok=True)
    for directory in layout.image_dirs.values():
        directory.mkdir(parents=True, exist_ok=True)
    return resumed


def _resolve_manifest(dataset: Path, value: str) -> Path:
    supplied = Path(value).expanduser()
    path = supplied if supplied.is_absolute() else dataset / supplied
    resolved = path.resolve()
    if not resolved.is_file():
        raise EnrichmentError(f"input manifest is missing: {resolved}")
    return resolved


def _resolve_page_path(
    row: Mapping[str, Any],
    library: Path,
) -> tuple[Path, str]:
    raw_value = row.get("source_image_path")
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise ValueError("source_image_path is missing")
    supplied = Path(raw_value.strip()).expanduser()
    candidate = supplied if supplied.is_absolute() else library / supplied
    resolved = candidate.resolve()
    if not _is_within(resolved, library):
        raise ValueError(
            f"source_image_path escapes --library: {raw_value!r}"
        )
    if not resolved.is_file():
        raise FileNotFoundError(f"source page is missing: {resolved}")
    return resolved, resolved.relative_to(library).as_posix()


def _parse_bbox(row: Mapping[str, Any]) -> tuple[float, float, float, float]:
    value = row.get("bbox_px")
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("bbox_px must be a four-value xyxy array")
    try:
        bbox = tuple(float(part) for part in value)
    except (TypeError, ValueError) as exc:
        raise ValueError("bbox_px contains a non-numeric coordinate") from exc
    if not all(math.isfinite(part) for part in bbox):
        raise ValueError("bbox_px coordinates must be finite")
    x1, y1, x2, y2 = bbox
    if x2 <= x1 or y2 <= y1:
        raise ValueError("bbox_px must be a nonempty xyxy box")
    return bbox  # type: ignore[return-value]


def _reject_record(
    *,
    line_number: int,
    stage: str,
    reasons: Sequence[str],
    row: Mapping[str, Any] | None = None,
    page_key: str | None = None,
    error: str | None = None,
    raw_line: str | None = None,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "line_number": line_number,
        "stage": stage,
        "reasons": list(reasons),
    }
    if page_key is not None:
        record["source_image_path"] = page_key
    if error is not None:
        record["error"] = error
    if row is not None:
        record["row"] = dict(row)
    if raw_line is not None:
        record["raw_line"] = raw_line
    if details:
        record["details"] = dict(details)
    return record


def _load_input(
    manifest: Path,
    library: Path,
) -> tuple[
    "OrderedDict[str, list[InputRow]]",
    list[dict[str, Any]],
    int,
]:
    groups: "OrderedDict[str, list[InputRow]]" = OrderedDict()
    rejects: list[dict[str, Any]] = []
    total_lines = 0
    with manifest.open("r", encoding="utf-8-sig") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            stripped = raw_line.strip()
            if not stripped:
                continue
            total_lines += 1
            try:
                decoded = json.loads(stripped)
            except json.JSONDecodeError as exc:
                rejects.append(
                    _reject_record(
                        line_number=line_number,
                        stage="input",
                        reasons=["invalid_json"],
                        raw_line=stripped,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                )
                continue
            if not isinstance(decoded, dict):
                rejects.append(
                    _reject_record(
                        line_number=line_number,
                        stage="input",
                        reasons=["row_not_object"],
                        raw_line=stripped,
                    )
                )
                continue
            row = dict(decoded)
            try:
                page_path, page_key = _resolve_page_path(row, library)
                bbox = _parse_bbox(row)
            except (OSError, ValueError) as exc:
                rejects.append(
                    _reject_record(
                        line_number=line_number,
                        stage="input",
                        reasons=["invalid_source_or_bbox"],
                        row=row,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                )
                continue
            groups.setdefault(page_key, []).append(
                InputRow(
                    line_number=line_number,
                    row=row,
                    page_path=page_path,
                    page_key=page_key,
                    bbox_xyxy=bbox,
                )
            )
    return groups, rejects, total_lines


def _meaningful_character_count(value: Any) -> int:
    if not isinstance(value, str):
        return 0
    return sum(
        1
        for character in value
        if unicodedata.category(character)[:1] in {"L", "N"}
    )


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _quality_gate(
    row: Mapping[str, Any],
    *,
    ink_ratio: float,
    border_contact_ratio: float,
    glyph_width: int,
    glyph_height: int,
    nonempty: bool,
) -> dict[str, Any]:
    tier = str(row.get("tier", "")).strip().upper()
    score = _float_or_none(row.get("ocr_score"))
    meaningful_chars = _meaningful_character_count(row.get("ocr_text"))
    orientation = str(row.get("orientation", "")).strip().lower()
    font_axis = "width" if orientation == "vertical" else "height"
    font_axis_size = glyph_width if font_axis == "width" else glyph_height

    checks = {
        "tier_a": tier == "A",
        "ocr_score_at_least_0_95": (
            score is not None
            and score >= HIGH_PRECISION_GATE["minimum_ocr_score"]
        ),
        "meaningful_chars_at_least_2": (
            meaningful_chars
            >= HIGH_PRECISION_GATE["minimum_meaningful_chars"]
        ),
        "ink_ratio_at_least_0_01": (
            ink_ratio >= HIGH_PRECISION_GATE["minimum_ink_ratio"]
        ),
        "ink_ratio_at_most_0_60": (
            ink_ratio <= HIGH_PRECISION_GATE["maximum_ink_ratio"]
        ),
        "border_contact_ratio_at_most_0_02": (
            border_contact_ratio
            <= HIGH_PRECISION_GATE["maximum_border_contact_ratio"]
        ),
        "font_axis_size_at_least_18": (
            font_axis_size
            >= HIGH_PRECISION_GATE["minimum_font_axis_size_px"]
        ),
        "nonempty_mask": bool(nonempty),
    }
    reason_by_check = {
        "tier_a": "tier_not_a",
        "ocr_score_at_least_0_95": "ocr_score_below_0_95",
        "meaningful_chars_at_least_2": "meaningful_chars_below_2",
        "ink_ratio_at_least_0_01": "ink_ratio_below_0_01",
        "ink_ratio_at_most_0_60": "ink_ratio_above_0_60",
        "border_contact_ratio_at_most_0_02": (
            "border_contact_ratio_above_0_02"
        ),
        "font_axis_size_at_least_18": "font_axis_size_below_18",
        "nonempty_mask": "empty_mask",
    }
    reasons = [
        reason_by_check[name]
        for name, passed in checks.items()
        if not passed
    ]
    return {
        "name": "strict_high_precision_v1",
        "passed": not reasons,
        "checks": checks,
        "reasons": reasons,
        "observed": {
            "tier": tier or None,
            "ocr_score": score,
            "meaningful_chars": meaningful_chars,
            "ink_ratio": ink_ratio,
            "border_contact_ratio": border_contact_ratio,
            "orientation": orientation or None,
            "font_axis": font_axis,
            "font_axis_size_px": font_axis_size,
            "glyph_width_px": glyph_width,
            "glyph_height_px": glyph_height,
            "nonempty_mask": bool(nonempty),
        },
        "requirements": dict(HIGH_PRECISION_GATE),
    }


def _tight_context_bbox(
    tight_bbox: Sequence[int],
    *,
    page_width: int,
    page_height: int,
) -> tuple[tuple[int, int, int, int], int]:
    x1, y1, x2, y2 = (int(value) for value in tight_bbox)
    glyph_height = y2 - y1
    padding = max(2, min(8, int(round(glyph_height * 0.08))))
    return (
        (
            max(0, x1 - padding),
            max(0, y1 - padding),
            min(page_width, x2 + padding),
            min(page_height, y2 + padding),
        ),
        padding,
    )


def _normalized_rgba(pixels: Any) -> np.ndarray:
    rgba = np.array(pixels, dtype=np.uint8, copy=True)
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError(f"expected RGBA pixels, found shape {rgba.shape}")
    rgba[rgba[..., 3] == 0, :3] = 0
    return np.ascontiguousarray(rgba)


def _white_composite_rgba(pixels: Any) -> np.ndarray:
    rgba = _normalized_rgba(pixels)
    image = Image.fromarray(rgba)
    white = Image.new("RGBA", image.size, (255, 255, 255, 255))
    return np.asarray(
        Image.alpha_composite(white, image).convert("RGB"),
        dtype=np.uint8,
    )


def _letterbox(pixels: Any, *, rgba: bool) -> np.ndarray:
    mode = "RGBA" if rgba else "RGB"
    source = Image.fromarray(np.asarray(pixels))
    if source.mode != mode:
        source = source.convert(mode)
    width, height = source.size
    if width < 1 or height < 1:
        raise ValueError("cannot letterbox an empty image")
    scale = min(LETTERBOX_SIZE / width, LETTERBOX_SIZE / height)
    resized_size = (
        max(1, int(round(width * scale))),
        max(1, int(round(height * scale))),
    )
    resized = source.resize(resized_size, Image.Resampling.LANCZOS)
    background = (0, 0, 0, 0) if rgba else (255, 255, 255)
    canvas = Image.new(mode, (LETTERBOX_SIZE, LETTERBOX_SIZE), background)
    offset = (
        (LETTERBOX_SIZE - resized.width) // 2,
        (LETTERBOX_SIZE - resized.height) // 2,
    )
    # Copy RGBA pixels directly.  Supplying the image itself as a paste mask
    # would apply alpha twice and make antialiased glyph edges too transparent.
    canvas.paste(resized, offset)
    return np.asarray(canvas, dtype=np.uint8)


def _pixel_sha256(pixels: Any, mode: str) -> str:
    image = Image.fromarray(np.asarray(pixels))
    if image.mode != mode:
        image = image.convert(mode)
    digest = hashlib.sha256()
    digest.update(mode.encode("ascii"))
    digest.update(b"\0")
    digest.update(f"{image.width}x{image.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(image.tobytes())
    return digest.hexdigest()


def _difference_hash(glyph_rgba: Any) -> str:
    composite = Image.fromarray(_white_composite_rgba(glyph_rgba)).convert("L")
    resized = composite.resize((9, 8), Image.Resampling.LANCZOS)
    values = np.asarray(resized, dtype=np.uint8)
    comparisons = values[:, 1:] > values[:, :-1]
    result = 0
    for value in comparisons.reshape(-1):
        result = (result << 1) | int(bool(value))
    return f"{result:016x}"


_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename_component(value: Any, fallback: str) -> str:
    text = str(value).strip() if value is not None else ""
    cleaned = _UNSAFE_FILENAME.sub("_", text).strip("._")
    return (cleaned or fallback)[:96]


def _asset_paths(
    layout: OutputLayout,
    item: InputRow,
) -> dict[str, Path]:
    split = _safe_filename_component(item.row.get("split"), "unsplit")
    sample_id = _safe_filename_component(
        item.row.get("id"),
        f"row_{item.line_number:08d}",
    )
    identity = "\0".join(
        (
            item.page_key,
            str(item.line_number),
            _canonical_json(item.row),
        )
    )
    suffix = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:10]
    filename = f"{sample_id}-{suffix}.png"
    return {
        name: directory / split / filename
        for name, directory in layout.image_dirs.items()
    }


def _relative_asset_paths(
    paths: Mapping[str, Path],
    dataset: Path,
) -> dict[str, str]:
    return {
        name: path.relative_to(dataset).as_posix()
        for name, path in paths.items()
    }


def _save_assets(
    paths: Mapping[str, Path],
    *,
    glyph_rgba: Any,
    glyph_mask: Any,
    context_rgb: Any,
) -> dict[str, str]:
    saved: list[Path] = []
    try:
        normalized_rgba = _normalized_rgba(glyph_rgba)
        white_glyph = _white_composite_rgba(normalized_rgba)
        assets = {
            "glyph_rgba": normalized_rgba,
            "mask": np.asarray(glyph_mask, dtype=np.uint8),
            "context": np.asarray(context_rgb, dtype=np.uint8),
            "glyph_224": _letterbox(white_glyph, rgba=False),
            "context_224": _letterbox(context_rgb, rgba=False),
        }
        for name in ("context", "glyph_rgba", "mask", "glyph_224", "context_224"):
            _atomic_save_png(paths[name], assets[name])
            saved.append(paths[name])
        return {
            name: _sha256_file(paths[name])
            for name in ("context", "glyph_rgba", "mask", "glyph_224", "context_224")
        }
    except Exception:
        for path in saved:
            path.unlink(missing_ok=True)
        raise


def _model_metadata(
    masker: ComicTextMasker,
    signature: Mapping[str, Any],
) -> dict[str, Any]:
    metadata = dict(masker.model_info)
    metadata.pop("inference_count", None)
    metadata["content_signatures"] = {
        "model": signature["model_signature"],
        "config": signature["config_signature"],
        "preprocessor": signature["preprocessor_signature"],
    }
    metadata["model_sha256"] = signature["model_signature"]["sha256"]
    config_signature = signature["config_signature"]
    preprocessor_signature = signature["preprocessor_signature"]
    metadata["config_sha256"] = (
        config_signature.get("sha256")
        if isinstance(config_signature, dict)
        else None
    )
    metadata["preprocessor_sha256"] = (
        preprocessor_signature.get("sha256")
        if isinstance(preprocessor_signature, dict)
        else None
    )
    return metadata


def _enrich_row(
    item: InputRow,
    *,
    page: Any,
    result: Any,
    layout: OutputLayout,
    model_metadata: Mapping[str, Any],
    source_page_signature: Mapping[str, Any],
) -> dict[str, Any]:
    if result.empty or result.tight_bbox is None:
        raise ValueError("empty_mask")

    tight_bbox = tuple(int(value) for value in result.tight_bbox)
    x1, y1, x2, y2 = tight_bbox
    glyph_width = x2 - x1
    glyph_height = y2 - y1
    context_bbox, padding = _tight_context_bbox(
        tight_bbox,
        page_width=page.width,
        page_height=page.height,
    )
    cx1, cy1, cx2, cy2 = context_bbox
    context_rgb = np.ascontiguousarray(page.image_rgb[cy1:cy2, cx1:cx2])
    if context_rgb.size == 0:
        raise ValueError("empty_context")

    paths = _asset_paths(layout, item)
    asset_sha256 = _save_assets(
        paths,
        glyph_rgba=result.rgba,
        glyph_mask=result.tight_mask,
        context_rgb=context_rgb,
    )
    relative_paths = _relative_asset_paths(paths, layout.dataset)
    stats = asdict(result.stats)
    orientation = str(item.row.get("orientation", "")).strip().lower()
    font_axis = "width" if orientation == "vertical" else "height"
    font_axis_size = glyph_width if font_axis == "width" else glyph_height
    normalized_rgba = _normalized_rgba(result.rgba)
    white_composite = _white_composite_rgba(normalized_rgba)
    quality = _quality_gate(
        item.row,
        ink_ratio=float(result.stats.ink_ratio),
        border_contact_ratio=float(result.stats.border_contact_ratio),
        glyph_width=glyph_width,
        glyph_height=glyph_height,
        nonempty=True,
    )

    enriched = dict(item.row)
    enriched.update(
        {
            "mask_schema_version": SCHEMA_VERSION,
            "mask_paths": relative_paths,
            "final_image_paths": relative_paths,
            "mask_asset_sha256": asset_sha256,
            "masked_context_path": relative_paths["context"],
            "glyph_rgba_path": relative_paths["glyph_rgba"],
            "glyph_mask_path": relative_paths["mask"],
            "glyph_224_path": relative_paths["glyph_224"],
            "context_224_path": relative_paths["context_224"],
            "source_page_path": item.page_key,
            "source_page_absolute_path": str(item.page_path),
            "source_page_content_signature": dict(source_page_signature),
            "source_page_sha256": source_page_signature["sha256"],
            "raw_bbox_px": list(item.row["bbox_px"]),
            "source_crop_bbox_px": (
                list(item.row["crop_bbox_px"])
                if isinstance(item.row.get("crop_bbox_px"), (list, tuple))
                else None
            ),
            "ctd_ocr_bbox_px": list(result.ocr_bbox),
            "ctd_tight_bbox_px": list(tight_bbox),
            "mask_tight_bbox_px": list(tight_bbox),
            "ctd_tight_bbox_local_px": (
                list(result.tight_bbox_local)
                if result.tight_bbox_local is not None
                else None
            ),
            "masked_context_bbox_px": list(context_bbox),
            "final_bbox_px": list(context_bbox),
            "masked_context_padding_px": padding,
            "glyph_size_px": [glyph_width, glyph_height],
            "font_axis": font_axis,
            "font_axis_size_px": font_axis_size,
            "mask_stats": stats,
            "mask_model": dict(model_metadata),
            "mask_quality_gate": quality,
            "mask_high_precision": bool(quality["passed"]),
            "needs_mask_enrichment": False,
            "mask_enrichment_status": "complete",
            "glyph_sha256": _pixel_sha256(normalized_rgba, "RGBA"),
            "glyph_white_composite_sha256": _pixel_sha256(
                white_composite,
                "RGB",
            ),
            "glyph_dhash": _difference_hash(normalized_rgba),
            "glyph_transparent_rgb_normalized": True,
            "masked_letterbox_size_px": LETTERBOX_SIZE,
            "glyph_224_mode": "RGB",
            "glyph_224_background": "white",
            "mask_review": {
                "status": "pending",
                "allowed_decisions": ["pass", "reject", "recrop"],
                "recrop_bbox_px": None,
                "notes": None,
            },
        }
    )
    return enriched


def _shard_path(state_dir: Path, page_key: str) -> Path:
    digest = hashlib.sha256(page_key.encode("utf-8")).hexdigest()
    return state_dir / f"page-{digest}.json"


def _load_shard(
    path: Path,
    signature_hash: str,
) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("tool") != TOOL_ID
        or payload.get("schema_version") != SCHEMA_VERSION
        or payload.get("signature_hash") != signature_hash
    ):
        return None
    return payload


def _input_bindings(items: Sequence[InputRow]) -> list[dict[str, Any]]:
    return [
        {
            "line_number": item.line_number,
            "id": item.row.get("id"),
            "row_sha256": hashlib.sha256(
                _canonical_json(item.row).encode("utf-8")
            ).hexdigest(),
        }
        for item in items
    ]


def _input_binding_hash(bindings: Sequence[Mapping[str, Any]]) -> str:
    return hashlib.sha256(
        _canonical_json(list(bindings)).encode("utf-8")
    ).hexdigest()


def _positive_pair(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        width, height = (int(part) for part in value)
    except (TypeError, ValueError):
        return None
    if width < 1 or height < 1:
        return None
    return width, height


def _bbox_size(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x1, y1, x2, y2 = (int(part) for part in value)
    except (TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    return x2 - x1, y2 - y1


def _validate_record_assets(
    record: Mapping[str, Any],
    dataset: Path,
) -> bool:
    required_names = {
        "context",
        "glyph_rgba",
        "mask",
        "glyph_224",
        "context_224",
    }
    paths = record.get("mask_paths")
    hashes = record.get("mask_asset_sha256")
    glyph_size = _positive_pair(record.get("glyph_size_px"))
    context_size = _bbox_size(record.get("final_bbox_px"))
    stats = record.get("mask_stats")
    if (
        not isinstance(paths, dict)
        or not isinstance(hashes, dict)
        or not isinstance(stats, dict)
        or not required_names.issubset(paths)
        or not required_names.issubset(hashes)
        or glyph_size is None
        or context_size is None
    ):
        return False
    glyph_width, glyph_height = glyph_size
    try:
        expected_gate = _quality_gate(
            record,
            ink_ratio=float(stats.get("ink_ratio", math.nan)),
            border_contact_ratio=float(
                stats.get("border_contact_ratio", math.nan)
            ),
            glyph_width=glyph_width,
            glyph_height=glyph_height,
            nonempty=True,
        )
    except (TypeError, ValueError):
        return False
    if (
        record.get("needs_mask_enrichment") is not False
        or record.get("mask_enrichment_status") != "complete"
        or record.get("mask_schema_version") != SCHEMA_VERSION
        or record.get("mask_quality_gate") != expected_gate
        or record.get("mask_high_precision")
        is not bool(expected_gate["passed"])
        or record.get("font_axis") != expected_gate["observed"]["font_axis"]
        or record.get("font_axis_size_px")
        != expected_gate["observed"]["font_axis_size_px"]
    ):
        return False

    expected = {
        "context": ("RGB", context_size),
        "glyph_rgba": ("RGBA", glyph_size),
        "mask": ("L", glyph_size),
        "glyph_224": ("RGB", (LETTERBOX_SIZE, LETTERBOX_SIZE)),
        "context_224": ("RGB", (LETTERBOX_SIZE, LETTERBOX_SIZE)),
    }
    decoded: dict[str, np.ndarray] = {}
    try:
        for name, (expected_mode, expected_size) in expected.items():
            relative = paths.get(name)
            expected_hash = hashes.get(name)
            if (
                not isinstance(relative, str)
                or not isinstance(expected_hash, str)
                or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)
            ):
                return False
            candidate = (dataset / relative).resolve()
            if not _is_within(candidate, dataset) or not candidate.is_file():
                return False
            with Image.open(candidate) as opened:
                opened.load()
                if (
                    opened.mode != expected_mode
                    or opened.size != expected_size
                ):
                    return False
                if name in {"glyph_rgba", "mask", "glyph_224"}:
                    decoded[name] = np.asarray(opened, dtype=np.uint8)
            if _sha256_file(candidate) != expected_hash:
                return False
    except (OSError, ValueError):
        return False

    glyph_rgba = decoded["glyph_rgba"]
    glyph_mask = decoded["mask"]
    if (
        not np.array_equal(glyph_rgba[..., 3], glyph_mask)
        or not set(np.unique(glyph_mask).tolist()).issubset({0, 255})
        or np.any(glyph_rgba[glyph_rgba[..., 3] == 0, :3] != 0)
    ):
        return False
    normalized = _normalized_rgba(glyph_rgba)
    white_composite = _white_composite_rgba(normalized)
    if (
        record.get("glyph_sha256")
        != _pixel_sha256(normalized, "RGBA")
        or record.get("glyph_white_composite_sha256")
        != _pixel_sha256(white_composite, "RGB")
        or record.get("glyph_dhash") != _difference_hash(normalized)
        or not np.array_equal(
            decoded["glyph_224"],
            _letterbox(white_composite, rgba=False),
        )
    ):
        return False
    return True


def _wrapped_line_numbers(value: Any) -> list[int] | None:
    if not isinstance(value, list):
        return None
    lines: list[int] = []
    for wrapped in value:
        if not isinstance(wrapped, dict):
            return None
        line_number = wrapped.get("line_number")
        if not isinstance(line_number, int):
            return None
        lines.append(line_number)
    return lines


def _shard_reusable(
    shard: Mapping[str, Any],
    *,
    dataset: Path,
    bindings: Sequence[Mapping[str, Any]],
    binding_hash: str,
    source_page_signature: Mapping[str, Any],
) -> bool:
    masked = shard.get("masked")
    if (
        shard.get("status") != "complete"
        or not isinstance(masked, list)
        or not masked
        or shard.get("input_bindings") != list(bindings)
        or shard.get("input_binding_hash") != binding_hash
        or shard.get("source_page_content_signature")
        != dict(source_page_signature)
    ):
        return False

    expected_lines = [int(binding["line_number"]) for binding in bindings]
    high_lines = _wrapped_line_numbers(shard.get("high_precision"))
    reject_lines = _wrapped_line_numbers(shard.get("rejects"))
    masked_lines = _wrapped_line_numbers(masked)
    if (
        high_lines is None
        or reject_lines is None
        or masked_lines is None
        or len(set(high_lines)) != len(high_lines)
        or len(set(reject_lines)) != len(reject_lines)
        or set(high_lines).intersection(reject_lines)
        or sorted(high_lines + reject_lines) != sorted(expected_lines)
        or not set(high_lines).issubset(masked_lines)
    ):
        return False

    return all(
        isinstance(wrapped, dict)
        and isinstance(wrapped.get("record"), dict)
        and wrapped["record"].get("source_page_content_signature")
        == dict(source_page_signature)
        and _validate_record_assets(wrapped["record"], dataset)
        for wrapped in masked
    )


def _write_page_shard(
    path: Path,
    *,
    signature_hash: str,
    page_key: str | None,
    status: str,
    masked: Sequence[Mapping[str, Any]],
    high_precision: Sequence[Mapping[str, Any]],
    rejects: Sequence[Mapping[str, Any]],
    page_model: Mapping[str, Any] | None = None,
    input_bindings: Sequence[Mapping[str, Any]] | None = None,
    input_binding_hash: str | None = None,
    source_page_signature: Mapping[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "tool": TOOL_ID,
        "schema_version": SCHEMA_VERSION,
        "signature_hash": signature_hash,
        "page_key": page_key,
        "status": status,
        "masked": list(masked),
        "high_precision": list(high_precision),
        "rejects": list(rejects),
    }
    if page_model is not None:
        payload["page_model"] = dict(page_model)
    if input_bindings is not None:
        payload["input_bindings"] = list(input_bindings)
    if input_binding_hash is not None:
        payload["input_binding_hash"] = input_binding_hash
    if source_page_signature is not None:
        payload["source_page_content_signature"] = dict(
            source_page_signature
        )
    _atomic_write_json(path, payload)


def _wrapped(line_number: int, record: Mapping[str, Any]) -> dict[str, Any]:
    return {"line_number": line_number, "record": dict(record)}


def _process_page(
    items: Sequence[InputRow],
    *,
    masker: ComicTextMasker,
    layout: OutputLayout,
    signature_hash: str,
    model_metadata: Mapping[str, Any],
    input_bindings: Sequence[Mapping[str, Any]],
    input_binding_hash: str,
    source_page_signature: Mapping[str, Any],
) -> tuple[int, int, int, str]:
    page_key = items[0].page_key
    masked: list[dict[str, Any]] = []
    high_precision: list[dict[str, Any]] = []
    rejects: list[dict[str, Any]] = []
    transient_failure = False

    try:
        page = masker.infer_page(items[0].page_path)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        rejects.extend(
            _wrapped(
                item.line_number,
                _reject_record(
                    line_number=item.line_number,
                    stage="page_inference",
                    reasons=["page_inference_failed"],
                    row=item.row,
                    page_key=page_key,
                    error=error,
                ),
            )
            for item in items
        )
        _write_page_shard(
            _shard_path(layout.state_dir, page_key),
            signature_hash=signature_hash,
            page_key=page_key,
            status="transient_error",
            masked=masked,
            high_precision=high_precision,
            rejects=rejects,
            input_bindings=input_bindings,
            input_binding_hash=input_binding_hash,
            source_page_signature=source_page_signature,
        )
        return 0, 0, len(rejects), "transient_error"

    page_model = {
        "source_image_path": page_key,
        "source_page_content_signature": dict(source_page_signature),
        "width": page.width,
        "height": page.height,
        "provider": page.provider,
        "model_path": page.model_path,
    }
    for item in items:
        try:
            result = page.extract(item.bbox_xyxy, bbox_format="xyxy")
            if result.empty:
                rejects.append(
                    _wrapped(
                        item.line_number,
                        _reject_record(
                            line_number=item.line_number,
                            stage="mask_extraction",
                            reasons=["empty_mask"],
                            row=item.row,
                            page_key=page_key,
                            details={
                                "mask_stats": asdict(result.stats),
                                "ctd_ocr_bbox_px": list(result.ocr_bbox),
                            },
                        ),
                    )
                )
                continue
            enriched = _enrich_row(
                item,
                page=page,
                result=result,
                layout=layout,
                model_metadata=model_metadata,
                source_page_signature=source_page_signature,
            )
        except Exception as exc:
            transient_failure = True
            rejects.append(
                _wrapped(
                    item.line_number,
                    _reject_record(
                        line_number=item.line_number,
                        stage="mask_extraction",
                        reasons=["mask_extraction_or_save_failed"],
                        row=item.row,
                        page_key=page_key,
                        error=f"{type(exc).__name__}: {exc}",
                    ),
                )
            )
            continue

        wrapped = _wrapped(item.line_number, enriched)
        masked.append(wrapped)
        quality = enriched["mask_quality_gate"]
        if quality["passed"]:
            high_precision.append(wrapped)
        else:
            rejects.append(
                _wrapped(
                    item.line_number,
                    _reject_record(
                        line_number=item.line_number,
                        stage="high_precision_gate",
                        reasons=quality["reasons"],
                        row=enriched,
                        page_key=page_key,
                    ),
                )
            )

    if transient_failure:
        status = "transient_error"
    elif not masked:
        status = "empty"
    else:
        status = "complete"
    _write_page_shard(
        _shard_path(layout.state_dir, page_key),
        signature_hash=signature_hash,
        page_key=page_key,
        status=status,
        masked=masked,
        high_precision=high_precision,
        rejects=rejects,
        page_model=page_model,
        input_bindings=input_bindings,
        input_binding_hash=input_binding_hash,
        source_page_signature=source_page_signature,
    )
    return len(masked), len(high_precision), len(rejects), status


def _aggregate_outputs(
    layout: OutputLayout,
    *,
    signature_hash: str,
) -> dict[str, int]:
    masked: list[tuple[int, dict[str, Any]]] = []
    high_precision: list[tuple[int, dict[str, Any]]] = []
    rejects: list[tuple[int, dict[str, Any]]] = []
    page_shards = 0
    retryable_page_shards = 0

    for path in sorted(layout.state_dir.glob("*.json")):
        shard = _load_shard(path, signature_hash)
        if shard is None:
            continue
        if shard.get("page_key") is not None:
            if shard.get("status") == "complete":
                page_shards += 1
            else:
                retryable_page_shards += 1
        for key, destination in (
            ("masked", masked),
            ("high_precision", high_precision),
            ("rejects", rejects),
        ):
            values = shard.get(key)
            if not isinstance(values, list):
                continue
            for wrapped in values:
                if not isinstance(wrapped, dict):
                    continue
                line_number = wrapped.get("line_number")
                record = wrapped.get("record")
                if isinstance(line_number, int) and isinstance(record, dict):
                    destination.append((line_number, record))

    masked.sort(key=lambda item: item[0])
    high_precision.sort(key=lambda item: item[0])
    rejects.sort(key=lambda item: (item[0], str(item[1].get("stage", ""))))
    _atomic_write_jsonl(
        layout.masked_manifest,
        (record for _, record in masked),
    )
    _atomic_write_jsonl(
        layout.high_precision_manifest,
        (record for _, record in high_precision),
    )
    _atomic_write_jsonl(
        layout.rejects_manifest,
        (record for _, record in rejects),
    )
    return {
        "masked_rows": len(masked),
        "high_precision_rows": len(high_precision),
        "reject_rows": len(rejects),
        "completed_page_shards": page_shards,
        "retryable_page_shards": retryable_page_shards,
    }


def _signature(
    *,
    dataset: Path,
    library: Path,
    manifest: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    model_path = Path(args.model).expanduser().resolve()
    model_signature = _content_signature(model_path)
    config_signature = _optional_content_signature(args.config)
    preprocessor_signature = _optional_content_signature(args.preprocessor)
    return {
        "dataset": str(dataset),
        "library": str(library),
        "manifest": str(manifest),
        "manifest_sha256": _sha256_file(manifest),
        "model_path": str(model_path),
        "model_signature": model_signature,
        "config_path": (
            str(Path(args.config).expanduser().resolve())
            if args.config
            else None
        ),
        "config_signature": config_signature,
        "preprocessor_path": (
            str(Path(args.preprocessor).expanduser().resolve())
            if args.preprocessor
            else None
        ),
        "preprocessor_signature": preprocessor_signature,
        "threshold": args.threshold,
        "min_component_pixels": args.min_component_pixels,
        "border_band": args.border_band,
        "verify_model_hash": bool(args.verify_model_hash),
        "letterbox_size": LETTERBOX_SIZE,
        "quality_gate": dict(HIGH_PRECISION_GATE),
        "schema_version": SCHEMA_VERSION,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset",
        required=True,
        help="FontClip dataset root containing the input manifest",
    )
    parser.add_argument(
        "--library",
        required=True,
        help="manga library root used to resolve source_image_path",
    )
    parser.add_argument(
        "--manifest",
        default="manifest.jsonl",
        help="input JSONL path (default: <dataset>/manifest.jsonl)",
    )
    parser.add_argument("--model", default=str(DEFAULT_MODEL_PATH))
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument(
        "--preprocessor",
        default=str(DEFAULT_PREPROCESSOR_PATH),
    )
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--min-component-pixels", type=int, default=3)
    parser.add_argument("--border-band", type=int, default=1)
    parser.add_argument("--verify-model-hash", action="store_true")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help=(
            "guardedly rebuild only outputs owned by this script; an exact "
            f"{MARKER_NAME} marker is required when outputs already exist"
        ),
    )
    parser.add_argument("--quiet", action="store_true")
    return parser


def _progress(message: str, quiet: bool) -> None:
    if not quiet:
        print(message, file=sys.stderr, flush=True)


def run(args: argparse.Namespace) -> dict[str, Any]:
    dataset = Path(args.dataset).expanduser().resolve()
    library = Path(args.library).expanduser().resolve()
    if not dataset.is_dir():
        raise EnrichmentError(f"dataset directory is missing: {dataset}")
    if not library.is_dir():
        raise EnrichmentError(f"library directory is missing: {library}")
    if (
        dataset == library
        or _is_within(dataset, library)
        or _is_within(library, dataset)
    ):
        raise EnrichmentError(
            "--dataset and --library must be separate, non-nested directories"
        )

    manifest = _resolve_manifest(dataset, args.manifest)
    layout = _output_layout(dataset)
    if manifest in {
        layout.masked_manifest,
        layout.high_precision_manifest,
        layout.rejects_manifest,
    }:
        raise EnrichmentError("an output manifest cannot be used as input")

    masker = ComicTextMasker(
        args.model,
        config_path=args.config or None,
        preprocessor_path=args.preprocessor or None,
        threshold=args.threshold,
        min_component_pixels=args.min_component_pixels,
        border_band=args.border_band,
        verify_model_hash=args.verify_model_hash,
        eager=True,
    )
    if not masker.available:
        raise EnrichmentError(
            "ComicTextMasker is unavailable; no output was changed: "
            f"{masker.unavailable_reason or 'unknown model initialization error'}"
        )

    signature = _signature(
        dataset=dataset,
        library=library,
        manifest=manifest,
        args=args,
    )
    signature_hash = hashlib.sha256(
        _canonical_json(signature).encode("utf-8")
    ).hexdigest()
    layout = _output_layout(dataset)
    resumed = _prepare_output(
        layout,
        signature=signature,
        overwrite=bool(args.overwrite),
    )

    groups, input_rejects, total_rows = _load_input(manifest, library)
    _write_page_shard(
        layout.state_dir / "input-rejects.json",
        signature_hash=signature_hash,
        page_key=None,
        status="input_rejects",
        masked=[],
        high_precision=[],
        rejects=[
            _wrapped(int(record["line_number"]), record)
            for record in input_rejects
        ],
    )

    model_metadata = _model_metadata(masker, signature)
    processed_pages = 0
    resumed_pages = 0
    interrupted = False
    page_items = list(groups.items())
    try:
        for page_index, (page_key, items) in enumerate(page_items, 1):
            shard_path = _shard_path(layout.state_dir, page_key)
            bindings = _input_bindings(items)
            binding_hash = _input_binding_hash(bindings)
            try:
                source_signature = _content_signature(items[0].page_path)
            except OSError as exc:
                error = f"{type(exc).__name__}: {exc}"
                source_rejects = [
                    _wrapped(
                        item.line_number,
                        _reject_record(
                            line_number=item.line_number,
                            stage="source_signature",
                            reasons=["source_signature_failed"],
                            row=item.row,
                            page_key=page_key,
                            error=error,
                        ),
                    )
                    for item in items
                ]
                _write_page_shard(
                    shard_path,
                    signature_hash=signature_hash,
                    page_key=page_key,
                    status="transient_error",
                    masked=[],
                    high_precision=[],
                    rejects=source_rejects,
                    input_bindings=bindings,
                    input_binding_hash=binding_hash,
                )
                processed_pages += 1
                _progress(
                    f"[page {page_index}/{len(page_items)}] "
                    f"source-signature-error {page_key}",
                    args.quiet,
                )
                continue
            existing = _load_shard(shard_path, signature_hash)
            if (
                existing is not None
                and existing.get("page_key") == page_key
                and _shard_reusable(
                    existing,
                    dataset=dataset,
                    bindings=bindings,
                    binding_hash=binding_hash,
                    source_page_signature=source_signature,
                )
            ):
                resumed_pages += 1
                _progress(
                    f"[page {page_index}/{len(page_items)}] resume {page_key}",
                    args.quiet,
                )
                continue

            before = masker.inference_count
            masked_count, high_count, reject_count, page_status = _process_page(
                items,
                masker=masker,
                layout=layout,
                signature_hash=signature_hash,
                model_metadata=model_metadata,
                input_bindings=bindings,
                input_binding_hash=binding_hash,
                source_page_signature=source_signature,
            )
            inference_delta = masker.inference_count - before
            if inference_delta > 1:
                raise EnrichmentError(
                    f"internal invariant violated: {inference_delta} "
                    f"inferences for one page ({page_key})"
                )
            processed_pages += 1
            _progress(
                f"[page {page_index}/{len(page_items)}] masked={masked_count} "
                f"high_precision={high_count} rejects={reject_count} "
                f"status={page_status} inference={inference_delta} {page_key}",
                args.quiet,
            )
    except KeyboardInterrupt:
        interrupted = True
        _progress(
            "[interrupt] preserving completed page shards and rebuilding "
            "aggregate manifests",
            args.quiet,
        )
    finally:
        aggregate = _aggregate_outputs(
            layout,
            signature_hash=signature_hash,
        )

    summary: dict[str, Any] = {
        "ok": not interrupted,
        "interrupted": interrupted,
        "dataset": str(dataset),
        "library": str(library),
        "input_manifest": str(manifest),
        "input_rows": total_rows,
        "valid_pages": len(groups),
        "invalid_input_rows": len(input_rejects),
        "processed_pages_this_run": processed_pages,
        "resumed_pages_this_run": resumed_pages,
        "page_inferences_this_run": masker.inference_count,
        "resumed_invocation": resumed,
        "outputs": {
            "masked_manifest": str(layout.masked_manifest),
            "high_precision_manifest": str(
                layout.high_precision_manifest
            ),
            "rejects_manifest": str(layout.rejects_manifest),
        },
        **aggregate,
        "model": masker.model_info,
    }
    if interrupted:
        raise KeyboardInterrupt
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        summary = run(args)
    except KeyboardInterrupt:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "interrupted; completed pages are resumable",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 130
    except (EnrichmentError, OSError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
