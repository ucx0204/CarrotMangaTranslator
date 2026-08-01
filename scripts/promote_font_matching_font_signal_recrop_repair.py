#!/usr/bin/env python3
"""Promote final font-signal recrops into a sealed, unlabeled hard delta.

The final-v3 repair artifact proves that each accepted rectangle is one clean,
single-style text block cut directly from an immutable library page.  This
tool turns only those accepted rows into a self-contained hard catalog.  It
does not trust copied pixels: every native crop and review context is
re-derived from the signed library page and compared byte-for-byte with the
final-v3 assets before trainer views are materialized.

The promoted rows deliberately carry no font label, tier, candidate decision,
or ``none`` judgment.  They are marked as font-signal-present manual recrops
and require a new blind primary plus independent secondary font review.  A
parent-exclusion ledger prevents the defective predecessor and its successor
from coexisting in a dynamic master build.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import platform
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

import numpy as np
import PIL
from PIL import Image, ImageOps, UnidentifiedImageError

try:
    import build_font_matching_master as master
except ImportError:  # pragma: no cover - import from repository root
    from scripts import build_font_matching_master as master  # type: ignore[no-redef]

try:
    import postprocess_fontclip_hard_candidates as hard_cv
except ImportError:  # pragma: no cover - import from repository root
    from scripts import (  # type: ignore[no-redef]
        postprocess_fontclip_hard_candidates as hard_cv,
    )


SCHEMA_VERSION = "font-matching-font-signal-recrop-promotion-v1"
HARD_SCHEMA_VERSION = "font-matching-font-signal-recrop-hard-delta-v1"
OWNER = "carrot-manga-translator/font-signal-recrop-promotion"
TOOL_ID = "manga-translator-font-signal-recrop-promoter"
DEFAULT_CATALOG_ID = "fontclip-recrop-font-signal-accepted-v1"
TERMINAL_REVIEW_SCHEMA_VERSION = (
    "font-matching-font-signal-recrop-terminal-resolution-v1"
)
TERMINAL_REVIEW_OWNER = "carrot-manga-translator/font-signal-recrop-terminal-resolution"
TERMINAL_REVIEW_TOOL_ID = "manga-translator-font-signal-recrop-terminal-finalizer"
TERMINAL_REVIEW_MARKER = ".font-matching-font-signal-terminal-resolution-owned.json"
TERMINAL_REVIEW_LEDGER = "terminal-exclusions.jsonl"
TERMINAL_REVIEW_REPORT = "report.json"
TERMINAL_REVIEW_REASON = "high_frequency_art_or_pattern_contamination"
TERMINAL_REVIEW_ALLOWED_IDS = frozenset(
    {
        "fm_511d6cd195edb424c3f3efe7",
        "fm_ef3d9054b5f850ddc134087e",
    }
)
FINAL_SCHEMA_VERSION = "font-matching-font-signal-recrop-repair-final-v3"
FINAL_OWNER = "carrot-manga-translator/font-signal-recrop-repair-final"
FINAL_MARKER = ".font-matching-font-signal-recrop-repair-final-owned.json"
FINAL_ACCEPTED = "accepted-repairs.jsonl"
FINAL_TERMINAL = "terminal-exclusions.jsonl"
FINAL_REPORT = "report.json"
MARKER_FILE = ".font-matching-font-signal-recrop-promotion-owned.json"
MANIFEST_FILE = "manifest.jsonl"
CROSSWALK_FILE = "crosswalk.jsonl"
EXCLUSIONS_FILE = "parent-exclusions.jsonl"
REGISTRY_INPUT_FILE = "registry-successor-input.json"
POLICY_FILE = "provenance-policy.json"
REPORT_FILE = "report.json"
REVIEWED_TERMINAL_FILE = "reviewed-terminal-exclusions.jsonl"
EXPECTED_ACCEPTED = 20
EXPECTED_TERMINAL = 7
ALLOWED_SPLITS = frozenset({"train", "val", "test"})
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
OVERLAY_PARTS = frozenset(master.OVERLAY_PATH_PARTS)
FORBIDDEN_LABEL_KEYS = frozenset(
    {
        "font_label",
        "font_labels",
        "font_tier",
        "font_tiers",
        "font_judgment",
        "none_acceptable",
        "safe_candidates",
        "candidate_tiers",
        "selected_font",
    }
)
SYNTHETIC_KEYS = frozenset(
    {
        "generated",
        "generative",
        "is_synthetic",
        "synthetic",
        "synthetic_style",
    }
)
OVERLAY_KEYS = frozenset(
    {
        "contains_qa_overlay",
        "diagnostic_overlay_written",
        "is_diagnostic_overlay",
        "is_qa_overlay",
        "overlay_baked_into_asset",
        "qa_overlay",
        "qa_overlay_in_training_asset",
    }
)
LETTERBOX_TRANSFORM: dict[str, Any] = {
    "algorithm": "fontclip-letterbox-rgb-v1",
    "canvas_color_rgb": [255, 255, 255],
    "convert_mode": "RGB",
    "operation": "aspect_preserving_letterbox",
    "placement": "center_floor",
    "resize_filter": "lanczos",
    "rounding": "python_round_then_minimum_1px",
    "target_size_px": [224, 224],
}
GLYPH_NORMALIZATION_CONTRACT: dict[str, Any] = {
    "algorithm": "font-signal-border-polarity-glyph-v1",
    "background_estimator": "median_rgb_and_luminance_of_10pct_crop_border_band",
    "candidate_generation": {
        "dark": "luminance <= min(otsu, border_luminance - 8)",
        "light": "luminance >= max(otsu, border_luminance + 8)",
        "color": (
            "delta_e >= 18 and (saturation >= 0.18 or "
            "abs(saturation - border_saturation) >= 0.12)"
        ),
        "color_attachment_radius_px": 2,
        "structural_cleanup": "trusted_hard_cv_clean_structural_lines",
    },
    "polarity": {
        "dark_on_light_min_border_luminance": 160.0,
        "light_on_dark_max_border_luminance": 95.0,
        "mid_background_requires_score_gap": 0.08,
    },
    "normalization": {
        "canvas": "white",
        "ink": (
            "source-derived grayscale contrast magnitude normalized against "
            "the selected border-background polarity"
        ),
        "color_stroke_strength": "max(polarity_contrast, clip(delta_e/100, 0, 1))",
        "tight_crop": True,
        "letterbox": LETTERBOX_TRANSFORM,
        "synthetic_or_generative_pixels": False,
    },
    "automatic_pass_gates": {
        "minimum_pixels": 12,
        "minimum_ink_ratio": 0.01,
        "maximum_ink_ratio": 0.50,
        "minimum_quality_score": 0.70,
        "maximum_component_count": 180,
        "component_count_qa_observation_threshold": 80,
        "high_component_minimum_quality_score": 0.72,
        "high_component_maximum_ink_ratio": 0.30,
        "high_component_minimum_normalized_contrast": 0.60,
        "high_component_maximum_border_contact_ratio": 0.05,
        "art_pattern_minimum_component_count": 80,
        "art_pattern_minimum_tight_bbox_coverage_ratio": 0.90,
        "art_pattern_minimum_border_luminance_p90_p10_span": 120.0,
        "maximum_line_contamination_ratio": 0.20,
        "maximum_large_enclosure_ink_ratio": 0.25,
        "maximum_removed_structural_line_pixels": 0,
        "maximum_border_contact_ratio": 0.28,
        "maximum_border_perimeter_coverage_ratio": 0.65,
        "maximum_corner_contacts": 3,
        "minimum_mean_normalized_contrast": 0.045,
        "maximum_mid_background_luminance_p90_p10_span": 190.0,
        "minimum_tight_axis_px": 2,
    },
    "ambiguous_policy": "review_hold_and_refuse_materialization",
}


class FontSignalPromotionError(ValueError):
    """Raised when promotion would weaken a sealed provenance contract."""


class GlyphNormalizationReviewHold(FontSignalPromotionError):
    """Raised when a crop cannot yield an unambiguous source-derived glyph."""


@dataclass(frozen=True)
class BoundRow:
    row: dict[str, Any]
    line_number: int
    line_bytes_sha256: str
    record_sha256: str


@dataclass(frozen=True)
class FinalAssetSnapshot:
    accepted_payload: bytes
    context_payload: bytes
    source_page_payload: bytes
    accepted_file_sha256: str
    context_file_sha256: str
    source_page_file_sha256: str


@dataclass(frozen=True)
class FinalSnapshot:
    root: Path
    report: dict[str, Any]
    marker: dict[str, Any]
    accepted: Mapping[str, BoundRow]
    terminal: Mapping[str, BoundRow]
    assets: Mapping[str, FinalAssetSnapshot]
    file_hashes: Mapping[str, str]
    marker_file_sha256: str


@dataclass(frozen=True)
class TerminalReviewSnapshot:
    root: Path
    report: dict[str, Any]
    marker: dict[str, Any]
    records: Mapping[str, BoundRow]
    file_hashes: Mapping[str, str]
    marker_file_sha256: str


@dataclass(frozen=True)
class MasterSnapshot:
    root: Path
    manifest: Path
    manifest_sha256: str
    rows: Mapping[str, BoundRow]
    report_sha256: str | None


@dataclass(frozen=True)
class RegistrySnapshot:
    path: Path
    document: dict[str, Any]
    file_sha256: str
    record_sha256: str
    configuration: master.SourceConfiguration
    parent_master_manifest: Path
    frozen_split_map: Path


@dataclass(frozen=True)
class PromotionSnapshot:
    final: FinalSnapshot
    source_master: MasterSnapshot
    registry: RegistrySnapshot
    registry_parent: MasterSnapshot
    library_root: Path
    glyph_report: dict[str, Any]
    terminal_review: TerminalReviewSnapshot | None


@dataclass(frozen=True)
class GlyphNormalization:
    glyph_224: Image.Image
    mask: np.ndarray
    normalized_native: Image.Image
    status: str
    reasons: tuple[str, ...]
    statistics: dict[str, Any]
    transform: dict[str, Any]
    tight_bbox_local_px: tuple[int, int, int, int] | None


def canonical_json(value: Any) -> str:
    return master.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        return (rendered + "\n").encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def jsonl_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    return "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise FontSignalPromotionError(f"could not hash {path}: {error}") from error
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


GLYPH_NORMALIZATION_CONTRACT_SHA256 = sha256_json(GLYPH_NORMALIZATION_CONTRACT)


def pixel_sha256(image: Image.Image) -> str:
    canonical = image
    converted = False
    if canonical.mode not in {"RGB", "RGBA", "L"}:
        canonical = canonical.convert("RGB")
        converted = True
    digest = hashlib.sha256()
    digest.update(canonical.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(f"{canonical.width}x{canonical.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(canonical.tobytes())
    if converted:
        canonical.close()
    return digest.hexdigest()


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(value))
    if "record_sha256" in output:
        raise FontSignalPromotionError("cannot seal an object that already has a seal")
    output["record_sha256"] = sha256_json(output)
    return output


def require_text(value: Any, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise FontSignalPromotionError(f"{location}: expected non-empty text")
    return normalized


def require_sha(value: Any, location: str) -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    if not HEX_SHA256.fullmatch(normalized):
        raise FontSignalPromotionError(f"{location}: expected lowercase SHA-256")
    return normalized


def require_component(value: Any, location: str) -> str:
    normalized = require_text(value, location)
    if not SAFE_COMPONENT.fullmatch(normalized):
        raise FontSignalPromotionError(f"{location}: unsafe identifier")
    return normalized


def require_mapping(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise FontSignalPromotionError(f"{location}: expected an object")
    return dict(value)


def require_bbox(value: Any, location: str) -> tuple[int, int, int, int]:
    if not (
        isinstance(value, list)
        and len(value) == 4
        and all(isinstance(item, int) and not isinstance(item, bool) for item in value)
    ):
        raise FontSignalPromotionError(f"{location}: expected integer xyxy bbox")
    bbox = tuple(value)
    if bbox[0] < 0 or bbox[1] < 0 or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise FontSignalPromotionError(f"{location}: invalid xyxy bbox")
    return bbox  # type: ignore[return-value]


def validate_seal(value: Mapping[str, Any], location: str) -> str:
    expected = require_sha(value.get("record_sha256"), f"{location}.record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_json(core) != expected:
        raise FontSignalPromotionError(f"{location}: record seal mismatch")
    return expected


def safe_relative(value: Any, location: str) -> PurePosixPath:
    text = require_text(value, location)
    if "\\" in text:
        raise FontSignalPromotionError(f"{location}: paths must use POSIX separators")
    posix = PurePosixPath(text)
    windows = PureWindowsPath(text)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
        or not posix.parts
        or any(part in {"", ".", ".."} for part in posix.parts)
    ):
        raise FontSignalPromotionError(f"{location}: unsafe relative path")
    if {part.casefold() for part in posix.parts} & OVERLAY_PARTS:
        raise FontSignalPromotionError(f"{location}: QA/overlay paths are forbidden")
    return posix


def resolve_inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    candidate = root.joinpath(*relative.parts).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise FontSignalPromotionError(f"{location}: path escaped its root") from error
    if candidate.is_symlink():
        raise FontSignalPromotionError(f"{location}: symlinks are forbidden")
    return candidate


def paths_overlap(left: Path, right: Path) -> bool:
    left = left.resolve()
    right = right.resolve()
    try:
        left.relative_to(right)
        return True
    except ValueError:
        pass
    try:
        right.relative_to(left)
        return True
    except ValueError:
        return False


def assert_disjoint(left: Path, right: Path, left_name: str, right_name: str) -> None:
    if paths_overlap(left, right):
        raise FontSignalPromotionError(
            f"{left_name} and {right_name} must be separate, non-nested roots"
        )


def reject_symlink_path(path: Path, location: str) -> None:
    """Reject a symlink at any existing component before resolving a CLI path."""

    current = path.expanduser().absolute()
    while True:
        if current.exists() and current.is_symlink():
            raise FontSignalPromotionError(f"{location} contains a symlink: {current}")
        parent = current.parent
        if parent == current:
            break
        current = parent


def _forbidden_true_flag(value: Any, *, key: str = "") -> bool:
    lowered = key.casefold()
    if lowered in SYNTHETIC_KEYS | OVERLAY_KEYS and value is True:
        return True
    if isinstance(value, Mapping):
        return any(
            _forbidden_true_flag(child, key=str(child_key))
            for child_key, child in value.items()
        )
    if isinstance(value, list):
        return any(_forbidden_true_flag(child, key=key) for child in value)
    return False


def _find_label_leaks(value: Any, *, path: str = "") -> list[str]:
    leaks: list[str] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            lowered = str(key).casefold()
            if lowered in FORBIDDEN_LABEL_KEYS:
                leaks.append(child_path)
            if lowered == "tier" and child not in {None, "", "review_required"}:
                leaks.append(child_path)
            leaks.extend(_find_label_leaks(child, path=child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            leaks.extend(_find_label_leaks(child, path=f"{path}[{index}]"))
    return leaks


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FontSignalPromotionError(f"{location}: invalid JSON: {error}") from error
    return require_mapping(value, location)


def _read_bound_jsonl(
    path: Path, location: str, *, allow_empty: bool = False
) -> list[BoundRow]:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise FontSignalPromotionError(
            f"{location}: could not read: {error}"
        ) from error
    rows: list[BoundRow] = []
    for line_number, physical_line in enumerate(payload.splitlines(keepends=True), 1):
        raw_line = physical_line.rstrip(b"\r\n")
        if not raw_line.strip():
            continue
        try:
            row = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise FontSignalPromotionError(
                f"{location}:{line_number}: invalid JSON: {error}"
            ) from error
        if not isinstance(row, dict):
            raise FontSignalPromotionError(f"{location}:{line_number}: expected object")
        record_sha = sha256_json(row)
        rows.append(
            BoundRow(
                row=row,
                line_number=line_number,
                line_bytes_sha256=sha256_bytes(physical_line),
                record_sha256=record_sha,
            )
        )
    if not rows and not allow_empty:
        raise FontSignalPromotionError(f"{location}: no records")
    return rows


def _unique_rows(
    rows: Sequence[BoundRow], key: str, location: str
) -> dict[str, BoundRow]:
    output: dict[str, BoundRow] = {}
    for bound in rows:
        item_id = require_component(bound.row.get(key), f"{location}.{key}")
        if item_id in output:
            raise FontSignalPromotionError(f"{location}: duplicate {key} {item_id!r}")
        output[item_id] = bound
    return output


def _strict_page_path(
    value: Any, *, work_id: str, chapter_id: str, location: str
) -> PurePosixPath:
    relative = safe_relative(value, location)
    if (
        len(relative.parts) != 6
        or relative.parts[0] != "works"
        or relative.parts[1] != work_id
        or relative.parts[2] != "chapters"
        or relative.parts[3] != chapter_id
        or relative.parts[4] != "pages"
    ):
        raise FontSignalPromotionError(
            f"{location}: expected works/<work>/chapters/<chapter>/pages/<file>"
        )
    return relative


def _decode_rgb(payload: bytes, location: str) -> Image.Image:
    try:
        with Image.open(io.BytesIO(payload)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.load()
    except (OSError, UnidentifiedImageError) as error:
        raise FontSignalPromotionError(f"{location}: image decode failed") from error
    if image.width <= 0 or image.height <= 0:
        image.close()
        raise FontSignalPromotionError(f"{location}: empty image")
    return image


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    converted = image.convert("RGB")
    try:
        converted.save(buffer, format="PNG", optimize=False)
    finally:
        converted.close()
    return buffer.getvalue()


def _letterbox_224(image: Image.Image) -> Image.Image:
    source = image.convert("RGB")
    scale = min(224 / source.width, 224 / source.height)
    size = (
        max(1, round(source.width * scale)),
        max(1, round(source.height * scale)),
    )
    resized = source.resize(size, Image.Resampling.LANCZOS)
    source.close()
    output = Image.new("RGB", (224, 224), (255, 255, 255))
    output.paste(resized, ((224 - resized.width) // 2, (224 - resized.height) // 2))
    resized.close()
    return output


def _mask_sha256(mask: np.ndarray) -> str:
    binary = np.ascontiguousarray(np.asarray(mask, dtype=np.uint8))
    digest = hashlib.sha256()
    digest.update(b"binary-mask-v1\0")
    digest.update(f"{binary.shape[1]}x{binary.shape[0]}".encode("ascii"))
    digest.update(b"\0")
    digest.update(binary.tobytes())
    return digest.hexdigest()


def _mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    left_binary = np.asarray(left, dtype=bool)
    right_binary = np.asarray(right, dtype=bool)
    union = int((left_binary | right_binary).sum())
    if union == 0:
        return 1.0
    return float((left_binary & right_binary).sum()) / union


def _glyph_candidate(
    mask: np.ndarray,
    rgb: np.ndarray,
) -> tuple[np.ndarray, dict[str, Any]]:
    cleaned, cleanup = hard_cv._clean_structural_lines(mask)
    height, width = cleaned.shape
    stats = hard_cv._mask_statistics(
        cleaned,
        rgb,
        roi=(0, 0, width, height),
        cleanup=cleanup,
    )
    return np.ascontiguousarray(cleaned, dtype=bool), stats


def _candidate_is_preliminarily_usable(stats: Mapping[str, Any]) -> bool:
    return (
        int(stats.get("pixels", 0)) >= 12
        and 0.002 <= float(stats.get("ink_ratio", 0.0)) <= 0.60
        and float(stats.get("quality_score", 0.0)) >= 0.35
        and float(stats.get("large_enclosure_ink_ratio", 0.0)) < 0.45
        and float(stats.get("line_contamination_ratio", 0.0)) < 0.65
    )


def _normalization_runtime() -> dict[str, Any]:
    cv2_module = getattr(hard_cv, "cv2", None)
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "pillow": PIL.__version__,
        "connected_components_backend": (
            "opencv_connected_components_with_stats"
            if cv2_module is not None
            else "trusted_python_bfs_fallback"
        ),
        "opencv": getattr(cv2_module, "__version__", None),
        "trusted_hard_cv_algorithm_version": hard_cv.ALGORITHM_VERSION,
        "trusted_hard_cv_source_sha256": sha256_file(Path(hard_cv.__file__).resolve()),
    }


def _normalize_glyph(image: Image.Image) -> GlyphNormalization:
    """Build a fail-closed, source-derived glyph view for FontClip.

    The mask thresholds and structural cleanup are shared with the sealed hard
    candidate postprocessor.  Selection is intentionally different: the crop
    border fixes the expected foreground polarity, so a high-scoring color
    subset cannot silently replace a more complete dark/light stroke mask.
    Every non-white glyph pixel is a deterministic grayscale contrast
    measurement from a selected source pixel; no glyph pixels are invented.
    """

    source = image.convert("RGB")
    try:
        rgb = np.array(source, dtype=np.uint8, copy=True, order="C")
    finally:
        source.close()
    height, width = rgb.shape[:2]
    total = max(1, height * width)
    luminance = hard_cv._luminance(rgb)
    border_luminance = np.asarray(hard_cv._border_values(luminance), dtype=np.float32)
    border_rgb = np.asarray(hard_cv._border_values(rgb), dtype=np.float32)
    background_luminance = float(np.median(border_luminance))
    background_rgb = np.median(border_rgb, axis=0)
    otsu_threshold = int(hard_cv._otsu_threshold(luminance))
    dark_limit = min(float(otsu_threshold), background_luminance - 8.0)
    light_limit = max(float(otsu_threshold), background_luminance + 8.0)

    lab = hard_cv._rgb_to_lab(rgb)
    border_lab = np.asarray(hard_cv._border_values(lab), dtype=np.float32)
    background_lab = np.median(border_lab, axis=0)
    delta_e = np.linalg.norm(lab - background_lab.reshape(1, 1, 3), axis=-1)
    border_delta_e = np.linalg.norm(border_lab - background_lab.reshape(1, 3), axis=-1)
    saturation = hard_cv._saturation(rgb)
    border_saturation = np.asarray(hard_cv._border_values(saturation), dtype=np.float32)
    background_saturation = float(np.median(border_saturation))

    raw_masks = {
        "dark": luminance <= dark_limit,
        "light": luminance >= light_limit,
        "color": (delta_e >= 18.0)
        & ((saturation >= 0.18) | (np.abs(saturation - background_saturation) >= 0.12)),
    }
    candidates: dict[str, np.ndarray] = {}
    candidate_stats: dict[str, dict[str, Any]] = {}
    for name, mask in raw_masks.items():
        candidates[name], candidate_stats[name] = _glyph_candidate(mask, rgb)
    for name, base_name in (
        ("dark_with_touching_color", "dark"),
        ("light_with_touching_color", "light"),
    ):
        attached = hard_cv._attach_touching(
            candidates[base_name],
            candidates["color"],
            radius=2,
        )
        candidates[name], candidate_stats[name] = _glyph_candidate(attached, rgb)

    # Identical masks are not independent evidence.  Retain deterministic
    # names while making the equivalence visible in the audit metadata.
    mask_groups: dict[str, list[str]] = {}
    for name, mask in sorted(candidates.items()):
        mask_groups.setdefault(_mask_sha256(mask), []).append(name)

    selection_reasons: list[str] = []
    ambiguity_reasons: list[str] = []
    if background_luminance >= 160.0:
        polarity = "dark_on_light"
        selected_name = "dark_with_touching_color"
        selection_reasons.append("stable_light_border_requires_dark_foreground")
    elif background_luminance <= 95.0:
        polarity = "light_on_dark"
        selected_name = "light_with_touching_color"
        selection_reasons.append("stable_dark_border_requires_light_foreground")
    else:
        polarity = "mid_background"
        ranked = sorted(
            (
                name
                for name in (
                    "dark_with_touching_color",
                    "light_with_touching_color",
                    "color",
                )
                if _candidate_is_preliminarily_usable(candidate_stats[name])
            ),
            key=lambda name: (
                float(candidate_stats[name]["quality_score"]),
                int(candidate_stats[name]["pixels"]),
                name,
            ),
            reverse=True,
        )
        selected_name = ranked[0] if ranked else "dark_with_touching_color"
        selection_reasons.append("mid_border_ranked_clean_candidates")
        if len(ranked) >= 2:
            first, second = ranked[:2]
            score_gap = abs(
                float(candidate_stats[first]["quality_score"])
                - float(candidate_stats[second]["quality_score"])
            )
            iou = _mask_iou(candidates[first], candidates[second])
            if score_gap < 0.08 and iou < 0.80:
                ambiguity_reasons.append("mid_background_competing_masks_disagree")

    selected_stats = candidate_stats[selected_name]
    if not _candidate_is_preliminarily_usable(selected_stats):
        color_stats = candidate_stats["color"]
        if _candidate_is_preliminarily_usable(color_stats):
            selected_name = "color"
            selected_stats = color_stats
            polarity = "color_contrast"
            selection_reasons.append("polarity_sparse_color_evidence_used")
        else:
            ambiguity_reasons.append("no_usable_polarity_or_color_mask")

    # Completeness wins over a near-scoring strict subset.  This closes the
    # trusted hard-CV score edge case where a color fringe can outrank the
    # complete dark stroke mask.
    selected_mask = candidates[selected_name]
    selected_score = float(selected_stats.get("quality_score", 0.0))
    for other_name in sorted(candidates):
        if other_name == selected_name:
            continue
        other_mask = candidates[other_name]
        selected_pixels = int(selected_mask.sum())
        other_pixels = int(other_mask.sum())
        if selected_pixels == 0 or other_pixels <= selected_pixels:
            continue
        inclusion = float((selected_mask & other_mask).sum()) / selected_pixels
        score_gap = selected_score - float(
            candidate_stats[other_name].get("quality_score", 0.0)
        )
        if (
            inclusion >= 0.95
            and score_gap <= 0.10
            and _candidate_is_preliminarily_usable(candidate_stats[other_name])
        ):
            selected_name = other_name
            selected_mask = other_mask
            selected_stats = candidate_stats[other_name]
            selected_score = float(selected_stats.get("quality_score", 0.0))
            selection_reasons.append("near_scoring_superset_preserved_complete_strokes")

    selected_mask = np.ascontiguousarray(selected_mask, dtype=bool)
    mask_pixels = int(selected_mask.sum())
    ink_ratio = mask_pixels / total
    tight_bbox = hard_cv._mask_bbox(selected_mask)
    tight_bbox_coverage = (
        (tight_bbox[2] - tight_bbox[0]) * (tight_bbox[3] - tight_bbox[1]) / total
        if tight_bbox is not None
        else 0.0
    )

    dark_strength = np.clip(
        (background_luminance - luminance) / max(background_luminance, 1.0),
        0.0,
        1.0,
    )
    light_strength = np.clip(
        (luminance - background_luminance) / max(255.0 - background_luminance, 1.0),
        0.0,
        1.0,
    )
    if polarity == "dark_on_light" or selected_name.startswith("dark"):
        polarity_strength = dark_strength
    elif polarity == "light_on_dark" or selected_name.startswith("light"):
        polarity_strength = light_strength
    else:
        polarity_strength = np.maximum(dark_strength, light_strength)
    normalized_strength = np.maximum(
        polarity_strength,
        np.clip(delta_e / 100.0, 0.0, 1.0),
    )
    normalized_gray = np.clip(
        np.rint(255.0 * (1.0 - normalized_strength)),
        0,
        255,
    ).astype(np.uint8)
    normalized_rgb = np.full((height, width, 3), 255, dtype=np.uint8)
    if mask_pixels:
        normalized_rgb[selected_mask] = normalized_gray[selected_mask, None]
    normalized_native = Image.fromarray(normalized_rgb)

    padded_tight: tuple[int, int, int, int] | None = None
    if tight_bbox is None:
        glyph_224 = Image.new("RGB", (224, 224), (255, 255, 255))
    else:
        x1, y1, x2, y2 = tight_bbox
        padding = max(1, int(round(min(width, height) * 0.01)))
        padded_tight = (
            max(0, x1 - padding),
            max(0, y1 - padding),
            min(width, x2 + padding),
            min(height, y2 + padding),
        )
        tight_image = normalized_native.crop(padded_tight)
        try:
            glyph_224 = _letterbox_224(tight_image)
        finally:
            tight_image.close()

    mean_normalized_contrast = (
        float(normalized_strength[selected_mask].mean()) if mask_pixels else 0.0
    )
    mean_absolute_luminance_contrast = (
        float(np.abs(luminance[selected_mask] - background_luminance).mean() / 255.0)
        if mask_pixels
        else 0.0
    )
    color_pixels = int((selected_mask & raw_masks["color"]).sum())
    border_span = float(
        np.percentile(border_luminance, 90) - np.percentile(border_luminance, 10)
    )
    gate_reasons = list(ambiguity_reasons)
    gates = GLYPH_NORMALIZATION_CONTRACT["automatic_pass_gates"]
    if mask_pixels < int(gates["minimum_pixels"]):
        gate_reasons.append("insufficient_ink_pixels")
    if ink_ratio < float(gates["minimum_ink_ratio"]):
        gate_reasons.append("ink_ratio_too_sparse")
    if ink_ratio > float(gates["maximum_ink_ratio"]):
        gate_reasons.append("ink_ratio_too_dense")
    if float(selected_stats.get("quality_score", 0.0)) < float(
        gates["minimum_quality_score"]
    ):
        gate_reasons.append("mask_quality_score_too_low")
    if int(selected_stats.get("component_count", 0)) > int(
        gates["maximum_component_count"]
    ):
        gate_reasons.append("too_many_ink_components")
    if int(selected_stats.get("component_count", 0)) > int(
        gates["component_count_qa_observation_threshold"]
    ) and not (
        float(selected_stats.get("quality_score", 0.0))
        >= float(gates["high_component_minimum_quality_score"])
        and ink_ratio <= float(gates["high_component_maximum_ink_ratio"])
        and mean_normalized_contrast
        >= float(gates["high_component_minimum_normalized_contrast"])
        and float(selected_stats.get("border_contact_ratio", 0.0))
        <= float(gates["high_component_maximum_border_contact_ratio"])
    ):
        gate_reasons.append("high_component_mask_lacks_supporting_quality")
    if float(selected_stats.get("line_contamination_ratio", 0.0)) > float(
        gates["maximum_line_contamination_ratio"]
    ):
        gate_reasons.append("line_contamination_requires_review")
    if float(selected_stats.get("large_enclosure_ink_ratio", 0.0)) > float(
        gates["maximum_large_enclosure_ink_ratio"]
    ):
        gate_reasons.append("large_enclosure_contamination_requires_review")
    if int(selected_stats.get("cleanup", {}).get("removed_line_pixels", 0)) > int(
        gates["maximum_removed_structural_line_pixels"]
    ):
        gate_reasons.append("structural_line_cleanup_applied_requires_review")
    if float(selected_stats.get("border_contact_ratio", 0.0)) > float(
        gates["maximum_border_contact_ratio"]
    ):
        gate_reasons.append("excessive_mask_border_contact")
    if float(selected_stats.get("crop_border_perimeter_coverage_ratio", 0.0)) > float(
        gates["maximum_border_perimeter_coverage_ratio"]
    ):
        gate_reasons.append("broad_crop_border_coverage")
    if int(selected_stats.get("crop_corner_contact_count", 0)) > int(
        gates["maximum_corner_contacts"]
    ):
        gate_reasons.append("mask_contacts_all_crop_corners")
    if mean_normalized_contrast < float(gates["minimum_mean_normalized_contrast"]):
        gate_reasons.append("normalized_contrast_too_low")
    if 95.0 < background_luminance < 160.0 and border_span > float(
        gates["maximum_mid_background_luminance_p90_p10_span"]
    ):
        gate_reasons.append("unstable_border_background")
    if (
        int(selected_stats.get("component_count", 0))
        >= int(gates["art_pattern_minimum_component_count"])
        and tight_bbox_coverage
        >= float(gates["art_pattern_minimum_tight_bbox_coverage_ratio"])
        and border_span
        >= float(gates["art_pattern_minimum_border_luminance_p90_p10_span"])
    ):
        gate_reasons.append("high_frequency_art_or_pattern_contamination")
    if tight_bbox is None:
        gate_reasons.append("empty_tight_mask")
    elif tight_bbox[2] - tight_bbox[0] < int(
        gates["minimum_tight_axis_px"]
    ) or tight_bbox[3] - tight_bbox[1] < int(gates["minimum_tight_axis_px"]):
        gate_reasons.append("tiny_tight_mask")
    gate_reasons = list(dict.fromkeys(gate_reasons))

    qa_observations: list[str] = []
    if border_span >= float(gates["art_pattern_minimum_border_luminance_p90_p10_span"]):
        qa_observations.append("heterogeneous_border_band")
    if int(selected_stats.get("component_count", 0)) > int(
        gates["component_count_qa_observation_threshold"]
    ):
        qa_observations.append("high_component_count_within_hard_style_gate")

    candidate_summary = {
        name: {
            "mask_sha256": _mask_sha256(candidates[name]),
            "pixels": int(stats["pixels"]),
            "ink_ratio": stats["ink_ratio"],
            "component_count": int(stats["component_count"]),
            "border_contact_ratio": stats["border_contact_ratio"],
            "crop_border_perimeter_coverage_ratio": stats[
                "crop_border_perimeter_coverage_ratio"
            ],
            "crop_corner_contact_count": int(stats["crop_corner_contact_count"]),
            "luminance_contrast": stats["luminance_contrast"],
            "quality_score": stats["quality_score"],
            "cleanup": copy.deepcopy(stats.get("cleanup", {})),
            "selected": name == selected_name,
        }
        for name, stats in sorted(candidate_stats.items())
    }
    statistics = {
        "status": "pass" if not gate_reasons else "review_hold",
        "review_hold_reasons": gate_reasons,
        "source_size_px": [width, height],
        "background": {
            "rgb_median": [round(float(value), 6) for value in background_rgb],
            "luminance_median": round(background_luminance, 6),
            "luminance_p10": round(float(np.percentile(border_luminance, 10)), 6),
            "luminance_p90": round(float(np.percentile(border_luminance, 90)), 6),
            "luminance_p90_p10_span": round(border_span, 6),
            "luminance_mad": round(
                float(np.median(np.abs(border_luminance - background_luminance))),
                6,
            ),
            "saturation_median": round(background_saturation, 8),
            "lab_delta_e_median": round(float(np.median(border_delta_e)), 6),
            "lab_delta_e_p90": round(float(np.percentile(border_delta_e, 90)), 6),
        },
        "thresholds": {
            "otsu_luminance": otsu_threshold,
            "dark_limit": round(dark_limit, 6),
            "light_limit": round(light_limit, 6),
            "lab_delta_e": 18.0,
            "saturation": 0.18,
            "border_saturation_delta": 0.12,
        },
        "selection": {
            "polarity": polarity,
            "selected_candidate": selected_name,
            "reasons": selection_reasons,
            "qa_observations": qa_observations,
            "mask_equivalence_groups": [
                names for _sha, names in sorted(mask_groups.items())
            ],
        },
        "ink": {
            "mask_sha256": _mask_sha256(selected_mask),
            "pixels": mask_pixels,
            "ratio": round(ink_ratio, 8),
            "component_count": int(selected_stats.get("component_count", 0)),
            "color_evidence_pixels": color_pixels,
            "color_evidence_ratio_of_ink": round(color_pixels / max(1, mask_pixels), 8),
            "mean_absolute_luminance_contrast": round(
                mean_absolute_luminance_contrast, 8
            ),
            "mean_normalized_contrast": round(mean_normalized_contrast, 8),
            "mean_delta_e": round(
                float(delta_e[selected_mask].mean()) if mask_pixels else 0.0,
                6,
            ),
            "tight_bbox_local_px": list(tight_bbox or ()),
            "glyph_crop_bbox_local_px": list(padded_tight or ()),
            "tight_bbox_coverage_ratio": round(tight_bbox_coverage, 8),
            "quality_score": selected_stats.get("quality_score", 0.0),
            "border_contact_pixels": int(
                selected_stats.get("border_contact_pixels", 0)
            ),
            "border_contact_ratio": selected_stats.get("border_contact_ratio", 0.0),
            "crop_border_perimeter_coverage_ratio": selected_stats.get(
                "crop_border_perimeter_coverage_ratio", 0.0
            ),
            "crop_corner_contact_count": int(
                selected_stats.get("crop_corner_contact_count", 0)
            ),
            "line_contamination_ratio": selected_stats.get(
                "line_contamination_ratio", 0.0
            ),
            "large_enclosure_ink_ratio": selected_stats.get(
                "large_enclosure_ink_ratio", 0.0
            ),
            "cleanup": copy.deepcopy(selected_stats.get("cleanup", {})),
        },
        "candidates": candidate_summary,
        "automatic_pass_gates": copy.deepcopy(gates),
    }
    transform = {
        "contract": copy.deepcopy(GLYPH_NORMALIZATION_CONTRACT),
        "contract_sha256": GLYPH_NORMALIZATION_CONTRACT_SHA256,
        "runtime": _normalization_runtime(),
        "selected_mask_sha256": statistics["ink"]["mask_sha256"],
        "selected_polarity": polarity,
        "selected_candidate": selected_name,
        "source_pixels_only": True,
        "generated_or_synthetic_pixels": 0,
    }
    return GlyphNormalization(
        glyph_224=glyph_224,
        mask=selected_mask,
        normalized_native=normalized_native,
        status=statistics["status"],
        reasons=tuple(gate_reasons),
        statistics=statistics,
        transform=transform,
        tight_bbox_local_px=tight_bbox,
    )


def _require_glyph_pass(
    normalization: GlyphNormalization,
    sample_id: str,
) -> None:
    if normalization.status != "pass":
        raise GlyphNormalizationReviewHold(
            f"{sample_id}: glyph normalization review hold: "
            + ",".join(normalization.reasons)
        )


def _same_pixels(left: Image.Image, right: Image.Image) -> bool:
    return (
        left.mode == right.mode
        and left.size == right.size
        and left.tobytes() == right.tobytes()
    )


def _managed_files(root: Path, *, marker_name: str = MARKER_FILE) -> dict[str, str]:
    output: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise FontSignalPromotionError(f"output contains symlink: {path}")
        if path.is_file() and path.name != marker_name:
            output[path.relative_to(root).as_posix()] = sha256_file(path)
    return output


def _validate_managed_tree(
    root: Path, marker_name: str, marker: Mapping[str, Any]
) -> dict[str, str]:
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise FontSignalPromotionError("ownership marker lacks managed_files")
    normalized: dict[str, str] = {}
    for raw_relative, raw_sha in managed.items():
        relative = safe_relative(raw_relative, f"marker[{raw_relative!r}]")
        expected = require_sha(raw_sha, f"marker[{raw_relative!r}].sha256")
        path = resolve_inside(root, relative, f"marker[{raw_relative!r}]")
        if not path.is_file() or sha256_file(path) != expected:
            raise FontSignalPromotionError(f"managed artifact drifted: {relative}")
        normalized[relative.as_posix()] = expected
    actual = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    expected_files = {marker_name, *normalized}
    if actual != expected_files:
        raise FontSignalPromotionError(
            "managed inventory differs: "
            f"missing={sorted(expected_files - actual)[:8]} "
            f"unexpected={sorted(actual - expected_files)[:8]}"
        )
    return normalized


def load_final_snapshot(
    final_root: Path,
    library_root: Path,
    *,
    expected_accepted: int,
    expected_terminal: int,
) -> FinalSnapshot:
    if not final_root.is_dir() or final_root.is_symlink():
        raise FontSignalPromotionError(f"invalid final-v3 root: {final_root}")
    marker_path = final_root / FINAL_MARKER
    marker = _read_json(marker_path, "final-v3 marker")
    if (
        marker.get("schema_version") != FINAL_SCHEMA_VERSION
        or marker.get("owner") != FINAL_OWNER
        or marker.get("safe_replace") is not False
        or marker.get("declared_root") != str(final_root)
    ):
        raise FontSignalPromotionError("final-v3 ownership marker is invalid")
    managed = _validate_managed_tree(final_root, FINAL_MARKER, marker)
    report = _read_json(final_root / FINAL_REPORT, "final-v3 report")
    if (
        report.get("schema_version") != FINAL_SCHEMA_VERSION
        or report.get("record_type") != "font_signal_recrop_repair_final_report"
    ):
        raise FontSignalPromotionError("final-v3 report contract is unsupported")
    validate_seal(report, "final-v3 report")
    accepted_rows = _read_bound_jsonl(
        final_root / FINAL_ACCEPTED, "final-v3 accepted repairs"
    )
    terminal_rows = _read_bound_jsonl(
        final_root / FINAL_TERMINAL,
        "final-v3 terminal exclusions",
        allow_empty=expected_terminal == 0,
    )
    accepted = _unique_rows(accepted_rows, "sample_id", "final-v3 accepted repairs")
    terminal = _unique_rows(terminal_rows, "sample_id", "final-v3 terminal exclusions")
    if set(accepted) & set(terminal):
        raise FontSignalPromotionError("accepted and terminal final-v3 IDs overlap")
    if len(accepted) != expected_accepted or len(terminal) != expected_terminal:
        raise FontSignalPromotionError(
            "final-v3 population differs: "
            f"accepted={len(accepted)} terminal={len(terminal)}"
        )
    counts = require_mapping(report.get("counts"), "final-v3 report.counts")
    if (
        counts.get("accepted_repairs") != len(accepted)
        or counts.get("accepted_images") != len(accepted)
        or counts.get("terminal_exclusions") != len(terminal)
        or counts.get("unresolved_or_disagreed") != 0
    ):
        raise FontSignalPromotionError("final-v3 report counts drifted")
    outputs = require_mapping(report.get("outputs"), "final-v3 report.outputs")
    if (
        outputs.get("accepted_repairs") != FINAL_ACCEPTED
        or outputs.get("accepted_repairs_sha256")
        != sha256_file(final_root / FINAL_ACCEPTED)
        or outputs.get("terminal_exclusions") != FINAL_TERMINAL
        or outputs.get("terminal_exclusions_sha256")
        != sha256_file(final_root / FINAL_TERMINAL)
    ):
        raise FontSignalPromotionError("final-v3 report output binding drifted")

    accepted_page_keys: set[tuple[str, tuple[int, int, int, int]]] = set()
    accepted_boxes_by_page: dict[str, list[tuple[int, int, int, int]]] = {}
    accepted_asset_hashes: set[str] = set()
    asset_snapshots: dict[str, FinalAssetSnapshot] = {}
    for sample_id, bound in sorted(accepted.items()):
        row = bound.row
        validate_seal(row, f"final-v3 accepted[{sample_id}]")
        if (
            row.get("schema_version") != FINAL_SCHEMA_VERSION
            or row.get("record_type") != "font_signal_accepted_repair"
            or row.get("status") != "accepted_repair_final"
            or row.get("training_eligible") is not True
            or row.get("accepted_for_downstream_training") is not True
            or row.get("merged_into_existing_dataset") is not False
            or row.get("source_pixels") != "hash_verified_library_page_only"
        ):
            raise FontSignalPromotionError(
                f"final-v3 accepted[{sample_id}]: unsafe status"
            )
        leaks = _find_label_leaks(row)
        if leaks:
            raise FontSignalPromotionError(
                f"final-v3 accepted[{sample_id}]: font label/tier leak {leaks[:4]}"
            )
        if _forbidden_true_flag(row):
            raise FontSignalPromotionError(
                f"final-v3 accepted[{sample_id}]: synthetic/overlay evidence is forbidden"
            )
        orientation = row.get("orientation")
        if orientation not in {"horizontal", "vertical"}:
            raise FontSignalPromotionError(
                f"final-v3 accepted[{sample_id}]: invalid orientation"
            )
        bbox = require_bbox(row.get("accepted_bbox_px"), f"accepted[{sample_id}].bbox")
        accepted_asset = require_mapping(
            row.get("accepted_image"), f"accepted[{sample_id}].accepted_image"
        )
        context_asset = require_mapping(
            row.get("review_context"), f"accepted[{sample_id}].review_context"
        )
        page = require_mapping(
            row.get("source_page"), f"accepted[{sample_id}].source_page"
        )
        if accepted_asset.get("bbox_px") != list(bbox):
            raise FontSignalPromotionError(
                f"accepted[{sample_id}]: accepted bbox aliases drifted"
            )
        for name, descriptor in (
            ("accepted_image", accepted_asset),
            ("review_context", context_asset),
        ):
            if (
                descriptor.get("pixel_source")
                != "direct_hash_verified_library_page_crop"
                or descriptor.get("qa_overlay") is not False
                or descriptor.get("synthetic") is not False
                or descriptor.get("generated") is not False
                or descriptor.get("decoded_mode") != "RGB"
            ):
                raise FontSignalPromotionError(
                    f"accepted[{sample_id}].{name}: not a direct real crop"
                )
        accepted_relative = safe_relative(
            accepted_asset.get("path"), f"accepted[{sample_id}].accepted_image.path"
        )
        context_relative = safe_relative(
            context_asset.get("path"), f"accepted[{sample_id}].review_context.path"
        )
        if accepted_relative.parts[:1] != (
            "accepted-images",
        ) or context_relative.parts[:1] != ("review-context",):
            raise FontSignalPromotionError(
                f"accepted[{sample_id}]: final asset directory contract drifted"
            )
        accepted_path = resolve_inside(
            final_root, accepted_relative, f"accepted[{sample_id}].accepted_image.path"
        )
        context_path = resolve_inside(
            final_root, context_relative, f"accepted[{sample_id}].review_context.path"
        )
        asset_payloads: dict[str, bytes] = {}
        for name, descriptor, path in (
            ("accepted_image", accepted_asset, accepted_path),
            ("review_context", context_asset, context_path),
        ):
            expected_sha = require_sha(
                descriptor.get("file_sha256"),
                f"accepted[{sample_id}].{name}.file_sha256",
            )
            payload = path.read_bytes() if path.is_file() else b""
            if not payload or sha256_bytes(payload) != expected_sha:
                raise FontSignalPromotionError(
                    f"accepted[{sample_id}].{name}: asset hash drifted"
                )
            asset_payloads[name] = payload
        accepted_hash = str(accepted_asset["file_sha256"])
        if accepted_hash in accepted_asset_hashes:
            raise FontSignalPromotionError("duplicate accepted repair pixels")
        accepted_asset_hashes.add(accepted_hash)

        work_id = require_component(
            (
                PurePosixPath(str(page.get("path"))).parts[1]
                if isinstance(page.get("path"), str)
                and len(PurePosixPath(str(page.get("path"))).parts) > 1
                else None
            ),
            f"accepted[{sample_id}].source_page.work_id",
        )
        chapter_id = require_component(
            (
                PurePosixPath(str(page.get("path"))).parts[3]
                if isinstance(page.get("path"), str)
                and len(PurePosixPath(str(page.get("path"))).parts) > 3
                else None
            ),
            f"accepted[{sample_id}].source_page.chapter_id",
        )
        page_relative = _strict_page_path(
            page.get("path"),
            work_id=work_id,
            chapter_id=chapter_id,
            location=f"accepted[{sample_id}].source_page.path",
        )
        if (
            page.get("storage_root") != "library_root"
            or page.get("provenance") != "real_preserved"
            or page.get("decoded_mode") != "RGB"
        ):
            raise FontSignalPromotionError(
                f"accepted[{sample_id}]: source page is not preserved library data"
            )
        page_path = resolve_inside(
            library_root, page_relative, f"accepted[{sample_id}].source_page.path"
        )
        page_payload = page_path.read_bytes() if page_path.is_file() else b""
        page_sha = require_sha(
            page.get("file_sha256"), f"accepted[{sample_id}].source_page.file_sha256"
        )
        if (
            not page_payload
            or sha256_bytes(page_payload) != page_sha
            or page.get("size_bytes") != len(page_payload)
        ):
            raise FontSignalPromotionError(
                f"accepted[{sample_id}]: source page hash/size drifted"
            )
        page_image = _decode_rgb(page_payload, f"accepted[{sample_id}].source_page")
        try:
            if page.get("size_px") != [page_image.width, page_image.height]:
                raise FontSignalPromotionError(
                    f"accepted[{sample_id}]: source page dimensions drifted"
                )
            for name, descriptor in (
                ("accepted_image", accepted_asset),
                ("review_context", context_asset),
            ):
                asset_bbox = require_bbox(
                    descriptor.get("bbox_px"), f"accepted[{sample_id}].{name}.bbox_px"
                )
                if (
                    asset_bbox[2] > page_image.width
                    or asset_bbox[3] > page_image.height
                ):
                    raise FontSignalPromotionError(
                        f"accepted[{sample_id}].{name}: bbox leaves source page"
                    )
                expected_crop = page_image.crop(asset_bbox).convert("RGB")
                expected_payload = _png_bytes(expected_crop)
                actual_crop = _decode_rgb(
                    asset_payloads[name], f"accepted[{sample_id}].{name}"
                )
                try:
                    if (
                        not _same_pixels(expected_crop, actual_crop)
                        or asset_payloads[name] != expected_payload
                    ):
                        raise FontSignalPromotionError(
                            f"accepted[{sample_id}].{name}: bytes/pixels differ from library crop"
                        )
                    if descriptor.get("size_px") != [
                        actual_crop.width,
                        actual_crop.height,
                    ]:
                        raise FontSignalPromotionError(
                            f"accepted[{sample_id}].{name}: dimensions drifted"
                        )
                finally:
                    expected_crop.close()
                    actual_crop.close()
        finally:
            page_image.close()
        asset_snapshots[sample_id] = FinalAssetSnapshot(
            accepted_payload=asset_payloads["accepted_image"],
            context_payload=asset_payloads["review_context"],
            source_page_payload=page_payload,
            accepted_file_sha256=sha256_bytes(asset_payloads["accepted_image"]),
            context_file_sha256=sha256_bytes(asset_payloads["review_context"]),
            source_page_file_sha256=page_sha,
        )
        page_key = (page_sha, bbox)
        if page_key in accepted_page_keys:
            raise FontSignalPromotionError(
                "duplicate source-page crop in accepted repairs"
            )
        accepted_page_keys.add(page_key)
        for prior in accepted_boxes_by_page.setdefault(page_sha, []):
            if max(prior[0], bbox[0]) < min(prior[2], bbox[2]) and max(
                prior[1], bbox[1]
            ) < min(prior[3], bbox[3]):
                raise FontSignalPromotionError("accepted repair bboxes overlap")
        accepted_boxes_by_page[page_sha].append(bbox)

    for sample_id, bound in sorted(terminal.items()):
        row = bound.row
        validate_seal(row, f"final-v3 terminal[{sample_id}]")
        if (
            row.get("schema_version") != FINAL_SCHEMA_VERSION
            or row.get("record_type") != "font_signal_terminal_exclusion"
            or row.get("status") != "terminal_exclusion_final"
            or row.get("training_eligible") is not False
            or row.get("excluded_from_downstream_training") is not True
        ):
            raise FontSignalPromotionError(
                f"final-v3 terminal[{sample_id}]: terminal exclusion drifted"
            )
    return FinalSnapshot(
        root=final_root,
        report=report,
        marker=marker,
        accepted=accepted,
        terminal=terminal,
        assets=asset_snapshots,
        file_hashes=managed,
        marker_file_sha256=sha256_file(marker_path),
    )


def _decode_verified_asset_snapshot(
    final: FinalSnapshot,
    sample_id: str,
) -> tuple[Image.Image, Image.Image]:
    """Decode immutable bytes only after re-proving their sealed page crops."""

    accepted = final.accepted[sample_id].row
    snapshot = final.assets[sample_id]
    accepted_descriptor = require_mapping(
        accepted.get("accepted_image"), f"accepted[{sample_id}].accepted_image"
    )
    context_descriptor = require_mapping(
        accepted.get("review_context"), f"accepted[{sample_id}].review_context"
    )
    page_descriptor = require_mapping(
        accepted.get("source_page"), f"accepted[{sample_id}].source_page"
    )
    expected_bindings = (
        (
            "accepted_image",
            snapshot.accepted_payload,
            snapshot.accepted_file_sha256,
            accepted_descriptor,
        ),
        (
            "review_context",
            snapshot.context_payload,
            snapshot.context_file_sha256,
            context_descriptor,
        ),
        (
            "source_page",
            snapshot.source_page_payload,
            snapshot.source_page_file_sha256,
            page_descriptor,
        ),
    )
    for name, payload, frozen_sha, descriptor in expected_bindings:
        declared_sha = require_sha(
            descriptor.get("file_sha256"),
            f"accepted[{sample_id}].{name}.file_sha256",
        )
        if sha256_bytes(payload) != frozen_sha or declared_sha != frozen_sha:
            raise FontSignalPromotionError(
                f"accepted[{sample_id}].{name}: immutable snapshot hash drifted"
            )
    if page_descriptor.get("size_bytes") != len(snapshot.source_page_payload):
        raise FontSignalPromotionError(
            f"accepted[{sample_id}].source_page: immutable snapshot size drifted"
        )

    page_image = _decode_rgb(
        snapshot.source_page_payload,
        f"accepted[{sample_id}].source_page_snapshot",
    )
    decoded: dict[str, Image.Image] = {}
    try:
        if page_descriptor.get("size_px") != [page_image.width, page_image.height]:
            raise FontSignalPromotionError(
                f"accepted[{sample_id}].source_page: snapshot dimensions drifted"
            )
        for name, payload, descriptor in (
            ("accepted_image", snapshot.accepted_payload, accepted_descriptor),
            ("review_context", snapshot.context_payload, context_descriptor),
        ):
            bbox = require_bbox(
                descriptor.get("bbox_px"), f"accepted[{sample_id}].{name}.bbox_px"
            )
            expected_crop = page_image.crop(bbox).convert("RGB")
            actual_crop: Image.Image | None = _decode_rgb(
                payload, f"accepted[{sample_id}].{name}_snapshot"
            )
            try:
                if (
                    not _same_pixels(expected_crop, actual_crop)
                    or _png_bytes(expected_crop) != payload
                    or descriptor.get("size_px")
                    != [actual_crop.width, actual_crop.height]
                ):
                    raise FontSignalPromotionError(
                        f"accepted[{sample_id}].{name}: snapshot differs from library crop"
                    )
                decoded[name] = actual_crop
                actual_crop = None
            finally:
                expected_crop.close()
                if actual_crop is not None:
                    actual_crop.close()
    except Exception:
        for image in decoded.values():
            image.close()
        raise
    finally:
        page_image.close()
    return decoded["accepted_image"], decoded["review_context"]


def _load_master_snapshot(
    root: Path,
    target_ids: set[str],
    *,
    require_report: bool,
    location: str,
) -> MasterSnapshot:
    manifest = root / "manifest.jsonl" if root.is_dir() else root
    actual_root = manifest.parent
    if not manifest.is_file() or manifest.is_symlink():
        raise FontSignalPromotionError(f"{location}: missing master manifest")
    all_rows = _read_bound_jsonl(manifest, f"{location} manifest")
    selected: dict[str, BoundRow] = {}
    seen_target_counts: Counter[str] = Counter()
    for bound in all_rows:
        raw_id = bound.row.get("id")
        if isinstance(raw_id, str) and raw_id in target_ids:
            seen_target_counts[raw_id] += 1
            if raw_id not in selected:
                selected[raw_id] = bound
    ambiguous = sorted(key for key, count in seen_target_counts.items() if count != 1)
    if ambiguous:
        raise FontSignalPromotionError(
            f"{location}: ambiguous parent IDs {ambiguous[:8]}"
        )
    missing = sorted(target_ids - set(selected))
    if missing:
        raise FontSignalPromotionError(f"{location}: missing parent IDs {missing[:8]}")
    report_sha: str | None = None
    report_path = actual_root / "report.json"
    if require_report:
        report = _read_json(report_path, f"{location} report")
        outputs = require_mapping(report.get("outputs"), f"{location} report.outputs")
        manifest_sha = sha256_file(manifest)
        if outputs.get("master_manifest_sha256") != manifest_sha:
            raise FontSignalPromotionError(f"{location}: report manifest hash drifted")
        statistics = require_mapping(
            report.get("statistics"), f"{location} report.statistics"
        )
        if statistics.get("record_count") != len(all_rows):
            raise FontSignalPromotionError(f"{location}: report record count drifted")
        report_sha = sha256_file(report_path)
    return MasterSnapshot(
        root=actual_root,
        manifest=manifest,
        manifest_sha256=sha256_file(manifest),
        rows=selected,
        report_sha256=report_sha,
    )


def _load_registry(path: Path, source_master: Path) -> RegistrySnapshot:
    try:
        configuration = master.load_catalog_registry(path)
    except master.MasterManifestError as error:
        raise FontSignalPromotionError(f"catalog registry: {error}") from error
    document = _read_json(path, "catalog registry")
    record_sha = validate_seal(document, "catalog registry")
    parent = document.get("parent_master")
    if isinstance(parent, Mapping):
        parent_manifest = (
            Path(
                require_text(parent.get("manifest"), "registry.parent_master.manifest")
            )
            .expanduser()
            .resolve()
        )
        expected_sha = require_sha(
            parent.get("manifest_sha256"), "registry.parent_master.manifest_sha256"
        )
        if (
            not parent_manifest.is_file()
            or sha256_file(parent_manifest) != expected_sha
        ):
            raise FontSignalPromotionError("registry parent master drifted")
    else:
        parent_manifest = source_master.resolve()
    frozen = require_mapping(
        document.get("frozen_split_map"), "registry.frozen_split_map"
    )
    frozen_path = (
        Path(require_text(frozen.get("path"), "registry.frozen_split_map.path"))
        .expanduser()
        .resolve()
    )
    frozen_sha = require_sha(frozen.get("sha256"), "registry.frozen_split_map.sha256")
    if not frozen_path.is_file() or sha256_file(frozen_path) != frozen_sha:
        raise FontSignalPromotionError("registry frozen split map drifted")
    return RegistrySnapshot(
        path=path,
        document=document,
        file_sha256=sha256_file(path),
        record_sha256=record_sha,
        configuration=configuration,
        parent_master_manifest=parent_manifest,
        frozen_split_map=frozen_path,
    )


def _nested(mapping: Mapping[str, Any], *keys: str) -> Any:
    value: Any = mapping
    for key in keys:
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def _validate_parent_pair(
    sample_id: str,
    source: BoundRow,
    registry_parent: BoundRow,
    accepted: BoundRow,
    registry: RegistrySnapshot,
) -> None:
    current = source.row
    frozen = registry_parent.row
    final = accepted.row
    for name, value in (("current", current), ("registry parent", frozen)):
        if value.get("id") != sample_id:
            raise FontSignalPromotionError(f"{sample_id}: {name} ID drifted")
        if value.get("schema_version") != master.MASTER_SCHEMA_VERSION:
            raise FontSignalPromotionError(f"{sample_id}: {name} master schema drifted")
        provenance = require_mapping(
            value.get("provenance"), f"{sample_id}.{name}.provenance"
        )
        if (
            provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
        ):
            raise FontSignalPromotionError(f"{sample_id}: {name} parent is unsafe")
    stable_paths = (
        ("split",),
        ("work", "id"),
        ("chapter", "id"),
        ("page", "id"),
        ("page", "source_page_sha256"),
        ("page", "source_locator", "path"),
        ("provenance", "source_catalog_id"),
        ("provenance", "source_id"),
        ("provenance", "source_line_number"),
        ("provenance", "source_line_sha256"),
    )
    for path in stable_paths:
        if _nested(current, *path) != _nested(frozen, *path):
            raise FontSignalPromotionError(
                f"{sample_id}: current and registry parent differ at {'.'.join(path)}"
            )
    split = require_component(current.get("split"), f"{sample_id}.split")
    if split not in ALLOWED_SPLITS:
        raise FontSignalPromotionError(f"{sample_id}: unsupported split")
    work_id = require_component(_nested(current, "work", "id"), f"{sample_id}.work.id")
    chapter_id = require_component(
        _nested(current, "chapter", "id"), f"{sample_id}.chapter.id"
    )
    page = require_mapping(
        final.get("source_page"), f"accepted[{sample_id}].source_page"
    )
    page_relative = _strict_page_path(
        page.get("path"),
        work_id=work_id,
        chapter_id=chapter_id,
        location=f"accepted[{sample_id}].source_page.path",
    )
    if (
        page_relative.as_posix() != _nested(current, "page", "source_locator", "path")
        or page.get("file_sha256") != _nested(current, "page", "source_page_sha256")
        or page.get("size_px") != _nested(current, "page", "source_locator", "size_px")
    ):
        raise FontSignalPromotionError(f"{sample_id}: final repair source page drifted")
    frozen_map = registry.configuration.frozen_split_map
    if not isinstance(frozen_map, Mapping):
        raise FontSignalPromotionError("registry has no frozen split map")
    assignments = require_mapping(
        frozen_map.get("work_assignments"), "frozen split map.work_assignments"
    )
    if assignments.get(work_id) != split:
        raise FontSignalPromotionError(
            f"{sample_id}: split differs from frozen work assignment"
        )
    source_catalog = str(_nested(frozen, "provenance", "source_catalog_id"))
    source_id = str(_nested(frozen, "provenance", "source_id"))
    catalog = next(
        (
            item
            for item in registry.configuration.catalogs
            if item.catalog_id == source_catalog
        ),
        None,
    )
    if catalog is None:
        raise FontSignalPromotionError(
            f"{sample_id}: parent catalog is absent from registry"
        )
    expected_line = int(_nested(frozen, "provenance", "source_line_number"))
    expected_line_sha = str(_nested(frozen, "provenance", "source_line_sha256"))
    matches = 0
    try:
        with catalog.manifest_path.open("rb") as handle:
            for line_number, raw_line in enumerate(handle, 1):
                if line_number != expected_line:
                    continue
                stripped = raw_line.rstrip(b"\r\n")
                if sha256_bytes(stripped) != expected_line_sha:
                    raise FontSignalPromotionError(
                        f"{sample_id}: parent source line bytes drifted"
                    )
                row = json.loads(stripped)
                if not isinstance(row, Mapping) or row.get("id") != source_id:
                    raise FontSignalPromotionError(
                        f"{sample_id}: parent source identity drifted"
                    )
                matches += 1
                break
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FontSignalPromotionError(
            f"{sample_id}: cannot verify parent source line"
        ) from error
    if matches != 1:
        raise FontSignalPromotionError(
            f"{sample_id}: parent source line is ambiguous/missing"
        )


def _master_id(catalog_id: str, source_id: str) -> str:
    return "fm_" + sha256_bytes(f"{catalog_id}\0{source_id}".encode("utf-8"))[:24]


def _successor_id(sample_id: str, accepted: BoundRow) -> str:
    identity = {
        "schema_version": SCHEMA_VERSION,
        "parent_master_id": sample_id,
        "final_record_sha256": accepted.row.get("record_sha256"),
        "final_line_bytes_sha256": accepted.line_bytes_sha256,
        "source_page_sha256": _nested(accepted.row, "source_page", "file_sha256"),
        "accepted_bbox_px": accepted.row.get("accepted_bbox_px"),
        "accepted_image_sha256": _nested(accepted.row, "accepted_image", "file_sha256"),
        "view_transform": LETTERBOX_TRANSFORM,
        "glyph_normalization_contract_sha256": (GLYPH_NORMALIZATION_CONTRACT_SHA256),
    }
    return "fhsr_" + sha256_json(identity)[:24]


def _write_asset(
    root: Path,
    relative: str,
    payload: bytes,
    *,
    kind: str,
    size: tuple[int, int],
    transform: Mapping[str, Any],
    provenance: str,
) -> dict[str, Any]:
    pure = safe_relative(relative, f"asset[{kind}].path")
    destination = resolve_inside(root, pure, f"asset[{kind}].path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    if destination.is_symlink() or destination.read_bytes() != payload:
        raise FontSignalPromotionError(f"asset[{kind}]: write verification failed")
    return {
        "file_sha256": sha256_bytes(payload),
        "file_size_bytes": len(payload),
        "kind": kind,
        "mode": "RGB",
        "path": pure.as_posix(),
        "provenance": provenance,
        "size_px": [size[0], size[1]],
        "transform": copy.deepcopy(dict(transform)),
    }


def _build_successor(
    *,
    physical_root: Path,
    catalog_id: str,
    final: FinalSnapshot,
    sample_id: str,
    accepted: BoundRow,
    source_parent: BoundRow,
    registry_parent: BoundRow,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    row = accepted.row
    parent = source_parent.row
    frozen_parent = registry_parent.row
    successor_id = _successor_id(sample_id, accepted)
    if successor_id in {sample_id, _nested(parent, "provenance", "source_id")}:
        raise FontSignalPromotionError(
            f"{sample_id}: successor identity overlaps parent"
        )
    split = str(parent["split"])
    accepted_descriptor = require_mapping(
        row.get("accepted_image"), f"accepted[{sample_id}].accepted_image"
    )
    context_descriptor = require_mapping(
        row.get("review_context"), f"accepted[{sample_id}].review_context"
    )
    page_descriptor = require_mapping(
        row.get("source_page"), f"accepted[{sample_id}].source_page"
    )
    asset_snapshot = final.assets[sample_id]
    native_payload = asset_snapshot.accepted_payload
    bbox = copy.deepcopy(row["accepted_bbox_px"])
    native_image, context_image = _decode_verified_asset_snapshot(
        final,
        sample_id,
    )
    raw_224 = _letterbox_224(native_image)
    context_224 = _letterbox_224(context_image)
    normalization = _normalize_glyph(native_image)
    glyph_224 = normalization.glyph_224
    try:
        _require_glyph_pass(normalization, sample_id)
        raw_224_payload = _png_bytes(raw_224)
        glyph_224_payload = _png_bytes(glyph_224)
        context_224_payload = _png_bytes(context_224)
        native_pixel_sha = pixel_sha256(native_image)
        glyph_pixel_sha = pixel_sha256(glyph_224)
        normalized_native_pixel_sha = pixel_sha256(normalization.normalized_native)
        assets = {
            "raw": _write_asset(
                physical_root,
                f"images/raw/{split}/{successor_id}.png",
                native_payload,
                kind="raw",
                size=native_image.size,
                transform={
                    "bbox_px": copy.deepcopy(row["accepted_bbox_px"]),
                    "operation": "byte_exact_final_v3_accepted_library_crop_copy",
                    "source_page_sha256": page_descriptor["file_sha256"],
                },
                provenance="real_preserved",
            ),
            "raw_224": _write_asset(
                physical_root,
                f"images/raw_224/{split}/{successor_id}.png",
                raw_224_payload,
                kind="raw_224",
                size=raw_224.size,
                transform={**LETTERBOX_TRANSFORM, "source": "accepted_raw"},
                provenance="real_deterministic_transform",
            ),
            "context_224": _write_asset(
                physical_root,
                f"images/context_224/{split}/{successor_id}.png",
                context_224_payload,
                kind="context_224",
                size=context_224.size,
                transform={
                    **LETTERBOX_TRANSFORM,
                    "source": "final_v3_review_context_direct_library_crop",
                    "source_bbox_px": copy.deepcopy(context_descriptor["bbox_px"]),
                },
                provenance="real_deterministic_transform",
            ),
            "glyph_224": _write_asset(
                physical_root,
                f"images/glyph_224/{split}/{successor_id}.png",
                glyph_224_payload,
                kind="glyph_224",
                size=glyph_224.size,
                transform={
                    "operation": (
                        "border_polarity_contrast_normalized_masked_tight_crop_"
                        "then_letterbox"
                    ),
                    "source": "accepted_single_style_text_block_real_pixels",
                    "glyph_crop_bbox_local_px": copy.deepcopy(
                        normalization.statistics["ink"]["glyph_crop_bbox_local_px"]
                    ),
                    "normalization_contract_sha256": (
                        GLYPH_NORMALIZATION_CONTRACT_SHA256
                    ),
                    "selected_candidate": normalization.transform["selected_candidate"],
                    "selected_mask_sha256": normalization.transform[
                        "selected_mask_sha256"
                    ],
                    "selected_polarity": normalization.transform["selected_polarity"],
                    "letterbox": copy.deepcopy(LETTERBOX_TRANSFORM),
                    "mask_synthesis": False,
                    "source_derived_pixel_transform": True,
                    "generated_or_synthetic_pixels": 0,
                },
                provenance="real_deterministic_glyph_normalization",
            ),
        }
    finally:
        native_image.close()
        context_image.close()
        raw_224.close()
        glyph_224.close()
        normalization.normalized_native.close()
        context_224.close()

    local_tight_bbox = normalization.tight_bbox_local_px
    if local_tight_bbox is None:  # guarded by _require_glyph_pass
        raise GlyphNormalizationReviewHold(
            f"{sample_id}: glyph normalization produced no tight bbox"
        )
    mask_tight_bbox = [
        bbox[0] + local_tight_bbox[0],
        bbox[1] + local_tight_bbox[1],
        bbox[0] + local_tight_bbox[2],
        bbox[1] + local_tight_bbox[3],
    ]
    glyph_normalization = {
        "status": normalization.status,
        "review_hold_reasons": list(normalization.reasons),
        "contract_sha256": GLYPH_NORMALIZATION_CONTRACT_SHA256,
        "statistics": copy.deepcopy(normalization.statistics),
        "transform": copy.deepcopy(normalization.transform),
        "normalized_native_pixel_sha256": normalized_native_pixel_sha,
        "glyph_224_file_sha256": assets["glyph_224"]["file_sha256"],
        "glyph_224_pixel_sha256": glyph_pixel_sha,
        "source_pixels_only": True,
        "generated_or_synthetic_pixels": 0,
    }
    page_size = copy.deepcopy(page_descriptor["size_px"])
    lineage = [
        {
            "id": sample_id,
            "manual_recrop": False,
            "provenance": "real_master_superseded",
            "registry_parent_master_record_sha256": registry_parent.record_sha256,
            "source_master_record_sha256": source_parent.record_sha256,
            "synthetic": False,
        },
        {
            "id": successor_id,
            "manual_recrop": True,
            "provenance": "real_manual_recrop",
            "tool": TOOL_ID,
            "final_v3_record_sha256": row["record_sha256"],
            "accepted_bbox_px": copy.deepcopy(bbox),
            "source_page_sha256": page_descriptor["file_sha256"],
            "synthetic": False,
        },
    ]
    hard_row: dict[str, Any] = {
        "schema_version": HARD_SCHEMA_VERSION,
        "id": successor_id,
        "adjudication": {
            "exhaustive_visual_review_passed": True,
            "font_label_review_required": True,
            "font_signal_present": True,
            "independent_secondary_required": True,
            "manual_recrop": True,
            "path": "final_v3_double_review_consensus_manual_recrop",
            "priority_rank": 1,
            "schema_version": SCHEMA_VERSION,
            "synthetic": False,
            "tool": TOOL_ID,
        },
        "assets": assets,
        "asset_file_sha256": {
            "clip_image_path": assets["raw_224"]["file_sha256"],
            "image_path": assets["raw"]["file_sha256"],
        },
        "bbox_px": copy.deepcopy(bbox),
        "candidate_metadata": {
            "candidate_evidence": [
                {
                    "accepted_bbox_px": copy.deepcopy(bbox),
                    "acceptance_basis": row["acceptance_basis"],
                    "final_v3_record_sha256": row["record_sha256"],
                    "font_signal_present": True,
                    "manual_recrop": True,
                    "source": "sealed_font_signal_recrop_final_v3",
                }
            ],
            "categories": ["font_signal_present", "manual_recrop", "variant_priority"],
            "font_signal_status": "present",
            "independent_secondary_required": True,
            "primary_category": "font_signal_present",
            "review_priority": "priority_1",
        },
        "chapter_id": _nested(parent, "chapter", "id"),
        "chapter_title": _nested(parent, "chapter", "title"),
        "clip_image_path": assets["raw_224"]["path"],
        "context_224_path": assets["context_224"]["path"],
        "crop_bbox_px": copy.deepcopy(bbox),
        "crop_sha256": native_pixel_sha,
        "crop_size_px": copy.deepcopy(accepted_descriptor["size_px"]),
        "final_bbox_px": copy.deepcopy(bbox),
        "font_label_review": {
            "candidate_labels_inherited": False,
            "none_decision_inherited": False,
            "prior_tiers_inherited": False,
            "priority": "P1",
            "required_stages": ["blind_primary", "blind_independent_secondary"],
            "status": "required",
        },
        "font_signal_present": True,
        "glyph_224_path": assets["glyph_224"]["path"],
        "glyph_normalization": glyph_normalization,
        "glyph_white_composite_sha256": glyph_pixel_sha,
        "image_path": assets["raw"]["path"],
        "label": None,
        "lineage": lineage,
        "manual_recrop": True,
        "mask_tight_bbox_px": mask_tight_bbox,
        "orientation": row["orientation"],
        "page_id": _nested(parent, "page", "id"),
        "page_name": _nested(parent, "page", "name"),
        "page_size_px": page_size,
        "provenance": "real_manual_recrop",
        "quality": {
            "basis": "final_v3_double_review_consensus",
            "font_label_quality_pending": True,
            "status": "pass",
        },
        "raw_224_path": assets["raw_224"]["path"],
        "raw_image_path": assets["raw"]["path"],
        "review": {
            "decision": "pass",
            "font_label_review_completed": False,
            "status": "accepted",
            "visual_review_basis": row["acceptance_basis"],
        },
        "root_real_id": successor_id,
        "source_image_path": page_descriptor["path"],
        "source_page_asset": {
            "file_sha256": page_descriptor["file_sha256"],
            "mode": "RGB",
            "path": page_descriptor["path"],
            "provenance": "real_preserved",
            "size_px": page_size,
            "storage_root": "library_root",
        },
        "source_page_content_signature": {
            "sha256": page_descriptor["file_sha256"],
            "size": page_descriptor["size_bytes"],
        },
        "source_page_sha256": page_descriptor["file_sha256"],
        "split": split,
        "synthetic": False,
        "synthetic_provenance": None,
        "training_eligibility": "after_new_font_label_review_only",
        "variant_group_id": successor_id,
        "work_id": _nested(parent, "work", "id"),
        "work_title": _nested(parent, "work", "title"),
    }
    if _find_label_leaks(hard_row):
        raise FontSignalPromotionError(
            f"{sample_id}: successor unexpectedly leaked labels"
        )
    expected_master_id = _master_id(catalog_id, successor_id)
    crosswalk = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_font_signal_recrop_promotion_crosswalk",
            "parent_master_id": sample_id,
            "parent_source_catalog_id": _nested(
                frozen_parent, "provenance", "source_catalog_id"
            ),
            "parent_source_id": _nested(frozen_parent, "provenance", "source_id"),
            "parent_source_line_number": _nested(
                frozen_parent, "provenance", "source_line_number"
            ),
            "parent_source_line_sha256": _nested(
                frozen_parent, "provenance", "source_line_sha256"
            ),
            "registry_parent_master_line_number": registry_parent.line_number,
            "registry_parent_master_line_bytes_sha256": registry_parent.line_bytes_sha256,
            "registry_parent_master_record_sha256": registry_parent.record_sha256,
            "source_master_line_number": source_parent.line_number,
            "source_master_line_bytes_sha256": source_parent.line_bytes_sha256,
            "source_master_record_sha256": source_parent.record_sha256,
            "final_v3_line_number": accepted.line_number,
            "final_v3_line_bytes_sha256": accepted.line_bytes_sha256,
            "final_v3_record_sha256": row["record_sha256"],
            "accepted_image_sha256": accepted_descriptor["file_sha256"],
            "review_context_sha256": context_descriptor["file_sha256"],
            "source_page_sha256": page_descriptor["file_sha256"],
            "split": split,
            "orientation": row["orientation"],
            "successor_catalog_id": catalog_id,
            "successor_source_id": successor_id,
            "successor_expected_master_id": expected_master_id,
            "font_signal_present": True,
            "font_label_review_required": True,
            "independent_secondary_required": True,
            "old_font_labels_inherited": False,
            "old_font_tiers_inherited": False,
            "old_none_decision_inherited": False,
            "parent_excluded": True,
            "synthetic": False,
        }
    )
    exclusion = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_master_parent_exclusion",
            "parent_master_id": sample_id,
            "parent_master_record_sha256": registry_parent.record_sha256,
            "source_catalog_id": _nested(
                frozen_parent, "provenance", "source_catalog_id"
            ),
            "source_id": _nested(frozen_parent, "provenance", "source_id"),
            "source_line_number": _nested(
                frozen_parent, "provenance", "source_line_number"
            ),
            "source_line_sha256": _nested(
                frozen_parent, "provenance", "source_line_sha256"
            ),
            "successor_catalog_id": catalog_id,
            "successor_source_id": successor_id,
            "successor_expected_master_id": expected_master_id,
            "excluded_from_training": True,
            "excluded_from_font_review": True,
            "prior_final_labels_invalidated": True,
            "crosswalk_record_sha256": crosswalk["record_sha256"],
            "synthetic": False,
        }
    )
    return hard_row, crosswalk, exclusion


def _build_terminal_parent_exclusion(
    *,
    catalog_id: str,
    sample_id: str,
    accepted: BoundRow,
    source_parent: BoundRow,
    registry_parent: BoundRow,
    terminal_review: BoundRow,
) -> dict[str, Any]:
    """Exclude an irreparable parent without creating any replacement pixels."""

    frozen_parent = registry_parent.row
    review = terminal_review.row
    if sample_id not in TERMINAL_REVIEW_ALLOWED_IDS:
        raise FontSignalPromotionError(
            f"{sample_id}: terminal parent exclusion is not approved"
        )
    if (
        review.get("sample_id") != sample_id
        or review.get("reason_code") != TERMINAL_REVIEW_REASON
        or review.get("excluded_from_downstream_training") is not True
        or review.get("generated_or_synthetic_repair_authorized") is not False
    ):
        raise FontSignalPromotionError(
            f"{sample_id}: terminal review semantics drifted before exclusion"
        )
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_master_parent_exclusion",
            "parent_master_id": sample_id,
            "parent_master_record_sha256": registry_parent.record_sha256,
            "source_catalog_id": _nested(
                frozen_parent, "provenance", "source_catalog_id"
            ),
            "source_id": _nested(frozen_parent, "provenance", "source_id"),
            "source_line_number": _nested(
                frozen_parent, "provenance", "source_line_number"
            ),
            "source_line_sha256": _nested(
                frozen_parent, "provenance", "source_line_sha256"
            ),
            "successor_catalog_id": None,
            "successor_source_id": None,
            "successor_expected_master_id": None,
            "terminal_exclusion": True,
            "terminal_category": review["terminal_category"],
            "terminal_reason_code": review["reason_code"],
            "terminal_review_record_sha256": review["record_sha256"],
            "terminal_review_line_bytes_sha256": terminal_review.line_bytes_sha256,
            "final_v3_accepted_record_sha256": accepted.record_sha256,
            "source_master_record_sha256": source_parent.record_sha256,
            "source_master_line_bytes_sha256": source_parent.line_bytes_sha256,
            "replacement_pixels_created": False,
            "replacement_catalog_id_reserved_not_used": catalog_id,
            "excluded_from_training": True,
            "excluded_from_font_review": True,
            "prior_final_labels_invalidated": True,
            "synthetic": False,
        }
    )


def _registry_successor_contract(
    *,
    registry: RegistrySnapshot,
    output_root: Path,
    catalog_id: str,
    successor_registry_output: Path,
    successor_master_output: Path,
    library_root: Path,
    manifest_sha256: str,
    exclusions_sha256: str,
    parent_master_manifest_sha256: str,
    accepted_count: int,
    exclusion_count: int,
) -> dict[str, Any]:
    catalog_args: list[str] = []
    catalogs: list[dict[str, Any]] = []
    declared_catalogs = {
        require_component(
            require_mapping(value, "registry.catalogs[]").get("catalog_id"),
            "registry.catalogs[].catalog_id",
        ): require_mapping(value, "registry.catalogs[]")
        for value in registry.document.get("catalogs", [])
    }
    for item in registry.configuration.catalogs:
        declared_catalog = require_mapping(
            declared_catalogs.get(item.catalog_id),
            f"registry catalog {item.catalog_id}",
        )
        catalog_args.extend(
            ["--catalog", item.catalog_id, item.source_kind, str(item.root)]
        )
        catalogs.append(
            {
                "catalog_id": item.catalog_id,
                "source_kind": item.source_kind,
                "root": str(item.root),
                "manifest_sha256": require_sha(
                    declared_catalog.get("manifest_sha256"),
                    f"registry catalog {item.catalog_id}.manifest_sha256",
                ),
            }
        )
    catalog_args.extend(["--catalog", catalog_id, "hard", str(output_root)])
    catalogs.append(
        {
            "catalog_id": catalog_id,
            "source_kind": "hard",
            "root": str(output_root),
            "manifest_sha256": manifest_sha256,
            "expected_physical_rows": accepted_count,
        }
    )
    ledger_args: list[str] = []
    ledgers: list[dict[str, Any]] = []
    for value in registry.document.get("exclusion_ledgers", []):
        ledger = require_mapping(value, "registry.exclusion_ledgers[]")
        ledger_path = (
            Path(require_text(ledger.get("path"), "registry exclusion path"))
            .expanduser()
            .resolve()
        )
        ledger_args.extend(["--exclusion-ledger", str(ledger_path)])
        ledgers.append(
            {
                "path": str(ledger_path),
                "sha256": require_sha(
                    ledger.get("sha256"), "registry exclusion sha256"
                ),
                "expected_rows": ledger.get("expected_rows"),
            }
        )
    new_ledger = output_root / EXCLUSIONS_FILE
    ledger_args.extend(["--exclusion-ledger", str(new_ledger)])
    ledgers.append(
        {
            "path": str(new_ledger),
            "sha256": exclusions_sha256,
            "expected_rows": exclusion_count,
        }
    )
    registry_command = [
        "python",
        "scripts/build_font_matching_catalog_registry.py",
        "build",
        *catalog_args,
        *ledger_args,
        "--parent-master-manifest",
        str(registry.parent_master_manifest),
        "--frozen-split-map",
        str(registry.frozen_split_map),
        "--output",
        str(successor_registry_output),
    ]
    master_command = [
        "python",
        "scripts/build_font_matching_master.py",
        "build",
        "--catalog-registry",
        str(successor_registry_output),
        "--library-root",
        str(library_root),
        "--verify-assets",
        "--output-dir",
        str(successor_master_output),
    ]
    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_catalog_registry_successor_input",
            "current_registry": {
                "path": str(registry.path),
                "sha256": registry.file_sha256,
                "record_sha256": registry.record_sha256,
            },
            "catalogs": catalogs,
            "exclusion_ledgers": ledgers,
            "parent_master_manifest": str(registry.parent_master_manifest),
            "parent_master_manifest_sha256": require_sha(
                parent_master_manifest_sha256,
                "snapshot.registry_parent.manifest_sha256",
            ),
            "frozen_split_map": str(registry.frozen_split_map),
            "frozen_split_map_sha256": require_sha(
                _nested(registry.document, "frozen_split_map", "sha256"),
                "registry.frozen_split_map.sha256",
            ),
            "successor_registry_output": str(successor_registry_output),
            "successor_master_output": str(successor_master_output),
            "build_registry_command_argv": registry_command,
            "build_master_command_argv": master_command,
            "commands_executed_by_this_promotion": False,
        }
    )


def _load_promotion_snapshot(
    *,
    final_root: Path,
    source_master_root: Path,
    registry_path: Path,
    library_root: Path,
    terminal_review_root: Path | None,
    expected_accepted: int,
    expected_terminal: int,
) -> PromotionSnapshot:
    final = load_final_snapshot(
        final_root,
        library_root,
        expected_accepted=expected_accepted,
        expected_terminal=expected_terminal,
    )
    glyph_report = _glyph_preflight_report(final)
    terminal_review = (
        load_terminal_review_snapshot(
            terminal_review_root,
            final=final,
            glyph_report=glyph_report,
        )
        if terminal_review_root is not None
        else None
    )
    target_ids = set(final.accepted)
    source_master = _load_master_snapshot(
        source_master_root,
        target_ids,
        require_report=True,
        location="source master",
    )
    registry = _load_registry(registry_path, source_master.manifest)
    registry_parent = _load_master_snapshot(
        registry.parent_master_manifest,
        target_ids,
        require_report=False,
        location="registry parent master",
    )
    for sample_id in sorted(target_ids):
        _validate_parent_pair(
            sample_id,
            source_master.rows[sample_id],
            registry_parent.rows[sample_id],
            final.accepted[sample_id],
            registry,
        )
    return PromotionSnapshot(
        final=final,
        source_master=source_master,
        registry=registry,
        registry_parent=registry_parent,
        library_root=library_root,
        glyph_report=glyph_report,
        terminal_review=terminal_review,
    )


def _publication_input_paths(snapshot: PromotionSnapshot) -> list[tuple[Path, str]]:
    inputs = [
        (snapshot.final.root, "final-v3 root"),
        (snapshot.source_master.root, "source master root"),
        (snapshot.source_master.manifest, "source master manifest"),
        (snapshot.library_root, "library root"),
        (snapshot.registry.path, "current registry file"),
        (snapshot.registry_parent.root, "registry parent master root"),
        (snapshot.registry_parent.manifest, "registry parent master manifest"),
        (snapshot.registry.frozen_split_map, "registry frozen split map"),
    ]
    if snapshot.terminal_review is not None:
        inputs.append((snapshot.terminal_review.root, "terminal-review root"))
    for catalog in snapshot.registry.configuration.catalogs:
        inputs.append((catalog.root, f"catalog {catalog.catalog_id} root"))
        inputs.append((catalog.manifest_path, f"catalog {catalog.catalog_id} manifest"))
    for index, value in enumerate(
        snapshot.registry.document.get("exclusion_ledgers", [])
    ):
        ledger = require_mapping(value, f"registry.exclusion_ledgers[{index}]")
        ledger_path = (
            Path(
                require_text(
                    ledger.get("path"),
                    f"registry.exclusion_ledgers[{index}].path",
                )
            )
            .expanduser()
            .resolve()
        )
        inputs.append((ledger_path, f"registry exclusion ledger {index}"))
    return inputs


def _validate_publication_targets(
    snapshot: PromotionSnapshot,
    *,
    output_root: Path,
    successor_registry_output: Path,
    successor_master_output: Path,
    catalog_id: str,
) -> None:
    existing_catalog_ids = {
        catalog.catalog_id for catalog in snapshot.registry.configuration.catalogs
    }
    if catalog_id in existing_catalog_ids:
        raise FontSignalPromotionError(
            f"catalog_id already exists in current registry: {catalog_id}"
        )
    targets = [
        (output_root, "promotion output root"),
        (successor_registry_output, "successor registry output"),
        (successor_master_output, "successor master output"),
    ]
    for path, label in targets:
        if path.exists() or path.is_symlink():
            raise FontSignalPromotionError(f"{label} already exists: {path}")
    for index, (left, left_name) in enumerate(targets):
        for right, right_name in targets[index + 1 :]:
            assert_disjoint(left, right, left_name, right_name)
    for target, target_name in targets:
        for input_path, input_name in _publication_input_paths(snapshot):
            assert_disjoint(target, input_path, target_name, input_name)


def _preflight(
    *,
    final_root: Path,
    source_master_root: Path,
    registry_path: Path,
    library_root: Path,
    terminal_review_root: Path | None,
    output_root: Path,
    successor_registry_output: Path,
    successor_master_output: Path,
    catalog_id: str,
    expected_accepted: int,
    expected_terminal: int,
) -> PromotionSnapshot:
    snapshot = _load_promotion_snapshot(
        final_root=final_root,
        source_master_root=source_master_root,
        registry_path=registry_path,
        library_root=library_root,
        terminal_review_root=terminal_review_root,
        expected_accepted=expected_accepted,
        expected_terminal=expected_terminal,
    )
    _validate_publication_targets(
        snapshot,
        output_root=output_root,
        successor_registry_output=successor_registry_output,
        successor_master_output=successor_master_output,
        catalog_id=catalog_id,
    )
    return snapshot


def _glyph_preflight_report(final: FinalSnapshot) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    for sample_id in sorted(final.accepted):
        accepted = final.accepted[sample_id]
        payload = final.assets[sample_id].accepted_payload
        image, context_image = _decode_verified_asset_snapshot(final, sample_id)
        normalization = _normalize_glyph(image)
        try:
            glyph_payload = _png_bytes(normalization.glyph_224)
            record = {
                "sample_id": sample_id,
                "accepted_bbox_px": copy.deepcopy(accepted.row["accepted_bbox_px"]),
                "accepted_image_file_sha256": sha256_bytes(payload),
                "accepted_image_pixel_sha256": pixel_sha256(image),
                "status": normalization.status,
                "review_hold_reasons": list(normalization.reasons),
                "glyph_224_file_sha256_in_memory": sha256_bytes(glyph_payload),
                "glyph_224_pixel_sha256_in_memory": pixel_sha256(
                    normalization.glyph_224
                ),
                "normalized_native_pixel_sha256_in_memory": pixel_sha256(
                    normalization.normalized_native
                ),
                "statistics": copy.deepcopy(normalization.statistics),
            }
        finally:
            image.close()
            context_image.close()
            normalization.glyph_224.close()
            normalization.normalized_native.close()
        records.append(record)

    passed = sum(record["status"] == "pass" for record in records)
    holds = len(records) - passed

    def metric_bounds(*path: str) -> dict[str, float]:
        values = [float(_nested(record, "statistics", *path)) for record in records]
        return {
            "minimum": round(min(values), 8),
            "maximum": round(max(values), 8),
        }

    return seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_signal_glyph_normalization_read_only_preflight",
            "tool": TOOL_ID,
            "completed": holds == 0,
            "read_only": True,
            "output_root_created": False,
            "normalization_contract": copy.deepcopy(GLYPH_NORMALIZATION_CONTRACT),
            "normalization_contract_sha256": (GLYPH_NORMALIZATION_CONTRACT_SHA256),
            "runtime": _normalization_runtime(),
            "counts": {
                "accepted_checked": len(records),
                "glyph_normalization_pass": passed,
                "glyph_normalization_review_hold": holds,
            },
            "gate_ranges": {
                "ink_ratio": metric_bounds("ink", "ratio"),
                "component_count": metric_bounds("ink", "component_count"),
                "quality_score": metric_bounds("ink", "quality_score"),
                "mean_normalized_contrast": metric_bounds(
                    "ink", "mean_normalized_contrast"
                ),
                "border_contact_ratio": metric_bounds("ink", "border_contact_ratio"),
                "border_perimeter_coverage_ratio": metric_bounds(
                    "ink", "crop_border_perimeter_coverage_ratio"
                ),
                "tight_bbox_coverage_ratio": metric_bounds(
                    "ink", "tight_bbox_coverage_ratio"
                ),
                "border_luminance_p90_p10_span": metric_bounds(
                    "background", "luminance_p90_p10_span"
                ),
            },
            "records": records,
        }
    )


def _glyph_records_by_id(glyph_report: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    raw_records = glyph_report.get("records")
    if not isinstance(raw_records, list):
        raise FontSignalPromotionError("glyph preflight records are missing")
    records: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(raw_records):
        record = require_mapping(value, f"glyph preflight.records[{index}]")
        sample_id = require_component(
            record.get("sample_id"), f"glyph preflight.records[{index}].sample_id"
        )
        if sample_id in records:
            raise FontSignalPromotionError("glyph preflight repeats a sample ID")
        records[sample_id] = record
    return records


def terminal_review_record_core(
    final: FinalSnapshot,
    *,
    sample_id: str,
    glyph_record: Mapping[str, Any],
    reviewer: str,
) -> dict[str, Any]:
    """Return the only accepted human terminal-resolution record shape.

    Invoking the terminal-finalizer with both exact IDs is the explicit human
    acknowledgement.  The record itself is deterministic and binds that
    acknowledgement to the immutable accepted crop, its wider review context,
    the preserved source page, and the current fail-closed glyph gate result.
    """

    sample_id = require_component(sample_id, "terminal review.sample_id")
    reviewer = require_component(reviewer, "terminal review.reviewer")
    if sample_id not in TERMINAL_REVIEW_ALLOWED_IDS:
        raise FontSignalPromotionError(
            f"terminal review is forbidden for unapproved ID {sample_id!r}"
        )
    accepted = final.accepted.get(sample_id)
    asset = final.assets.get(sample_id)
    if accepted is None or asset is None:
        raise FontSignalPromotionError(
            f"terminal review ID is absent from final-v3 accepted repairs: {sample_id}"
        )
    if glyph_record.get("sample_id") != sample_id:
        raise FontSignalPromotionError(
            f"{sample_id}: glyph preflight record identity drifted"
        )
    reasons = glyph_record.get("review_hold_reasons")
    if glyph_record.get("status") != "review_hold" or reasons != [
        TERMINAL_REVIEW_REASON
    ]:
        raise FontSignalPromotionError(
            f"{sample_id}: terminal review requires the exact irreducible art hold"
        )
    row = accepted.row
    context_descriptor = require_mapping(
        row.get("review_context"), f"accepted[{sample_id}].review_context"
    )
    page_descriptor = require_mapping(
        row.get("source_page"), f"accepted[{sample_id}].source_page"
    )
    accepted_image, context_image = _decode_verified_asset_snapshot(final, sample_id)
    try:
        accepted_pixel_sha = pixel_sha256(accepted_image)
        context_pixel_sha = pixel_sha256(context_image)
    finally:
        accepted_image.close()
        context_image.close()
    if glyph_record.get("accepted_image_pixel_sha256") != accepted_pixel_sha:
        raise FontSignalPromotionError(
            f"{sample_id}: glyph preflight accepted-pixel binding drifted"
        )
    return {
        "schema_version": TERMINAL_REVIEW_SCHEMA_VERSION,
        "record_type": "font_signal_recrop_human_terminal_exclusion",
        "sample_id": sample_id,
        "status": "terminal_exclusion_final",
        "decision": "exclude_from_core_training_without_replacement",
        "terminal_category": "irreducible_source_art_contamination",
        "reason_code": TERMINAL_REVIEW_REASON,
        "reviewer": reviewer,
        "human_review_basis": (
            "direct_original_scale_review_of_accepted_crop_context_and_source_page"
        ),
        "tighter_rectangle_outcome": (
            "cuts_complete_glyphs_or_retains_screentone_speedline_person_art"
        ),
        "source_derived_mask_override_authorized": False,
        "generated_or_synthetic_repair_authorized": False,
        "accepted_for_downstream_training": False,
        "excluded_from_downstream_training": True,
        "excluded_from_font_review": True,
        "terminal_resolution_scope": "these_exact_two_ids_only",
        "source_pixels_added": 0,
        "source_artifact_mutated": False,
        "bindings": {
            "final_v3_marker_sha256": final.marker_file_sha256,
            "final_v3_report_file_sha256": final.file_hashes[FINAL_REPORT],
            "final_v3_report_record_sha256": final.report["record_sha256"],
            "final_v3_accepted_file_sha256": final.file_hashes[FINAL_ACCEPTED],
            "final_v3_terminal_file_sha256": final.file_hashes[FINAL_TERMINAL],
            "final_v3_accepted_line_number": accepted.line_number,
            "final_v3_accepted_line_bytes_sha256": accepted.line_bytes_sha256,
            "final_v3_accepted_record_sha256": accepted.record_sha256,
            "accepted_bbox_px": copy.deepcopy(row["accepted_bbox_px"]),
            "accepted_image_file_sha256": asset.accepted_file_sha256,
            "accepted_image_pixel_sha256": accepted_pixel_sha,
            "review_context_bbox_px": copy.deepcopy(context_descriptor["bbox_px"]),
            "review_context_file_sha256": asset.context_file_sha256,
            "review_context_pixel_sha256": context_pixel_sha,
            "source_page_path": page_descriptor["path"],
            "source_page_file_sha256": asset.source_page_file_sha256,
            "source_page_size_bytes": page_descriptor["size_bytes"],
            "source_page_size_px": copy.deepcopy(page_descriptor["size_px"]),
            "glyph_normalization_contract_sha256": (
                GLYPH_NORMALIZATION_CONTRACT_SHA256
            ),
            "glyph_preflight_status": glyph_record["status"],
            "glyph_preflight_review_hold_reasons": copy.deepcopy(reasons),
            "glyph_preflight_statistics_sha256": sha256_json(
                require_mapping(
                    glyph_record.get("statistics"),
                    f"glyph preflight[{sample_id}].statistics",
                )
            ),
        },
    }


def load_terminal_review_snapshot(
    root: Path,
    *,
    final: FinalSnapshot,
    glyph_report: Mapping[str, Any],
) -> TerminalReviewSnapshot:
    if not root.is_dir() or root.is_symlink():
        raise FontSignalPromotionError(f"invalid terminal-review root: {root}")
    marker_path = root / TERMINAL_REVIEW_MARKER
    marker = _read_json(marker_path, "terminal-review marker")
    if (
        marker.get("schema_version") != TERMINAL_REVIEW_SCHEMA_VERSION
        or marker.get("owner") != TERMINAL_REVIEW_OWNER
        or marker.get("tool") != TERMINAL_REVIEW_TOOL_ID
        or marker.get("completed") is not True
        or marker.get("immutable") is not True
        or marker.get("safe_replace") is not False
        or marker.get("declared_root") != str(root)
    ):
        raise FontSignalPromotionError("terminal-review ownership marker is invalid")
    managed = _validate_managed_tree(root, TERMINAL_REVIEW_MARKER, marker)
    if set(managed) != {TERMINAL_REVIEW_LEDGER, TERMINAL_REVIEW_REPORT}:
        raise FontSignalPromotionError("terminal-review managed inventory drifted")
    ledger_rows = _read_bound_jsonl(
        root / TERMINAL_REVIEW_LEDGER, "terminal-review ledger"
    )
    records = _unique_rows(ledger_rows, "sample_id", "terminal-review ledger")
    if set(records) != set(TERMINAL_REVIEW_ALLOWED_IDS):
        raise FontSignalPromotionError(
            "terminal-review ledger must contain exactly the two approved IDs"
        )
    glyph_records = _glyph_records_by_id(glyph_report)
    if set(glyph_records) != set(final.accepted):
        raise FontSignalPromotionError(
            "glyph preflight population differs from final-v3 accepted repairs"
        )
    for sample_id, bound in sorted(records.items()):
        validate_seal(bound.row, f"terminal-review[{sample_id}]")
        reviewer = require_component(
            bound.row.get("reviewer"), f"terminal-review[{sample_id}].reviewer"
        )
        expected = terminal_review_record_core(
            final,
            sample_id=sample_id,
            glyph_record=glyph_records[sample_id],
            reviewer=reviewer,
        )
        actual = {
            key: value for key, value in bound.row.items() if key != "record_sha256"
        }
        if actual != expected:
            raise FontSignalPromotionError(
                f"terminal-review[{sample_id}]: source/context/reason binding drifted"
            )
    report = _read_json(root / TERMINAL_REVIEW_REPORT, "terminal-review report")
    if (
        report.get("schema_version") != TERMINAL_REVIEW_SCHEMA_VERSION
        or report.get("record_type") != "font_signal_recrop_terminal_resolution_report"
        or report.get("tool") != TERMINAL_REVIEW_TOOL_ID
        or report.get("completed") is not True
    ):
        raise FontSignalPromotionError("terminal-review report contract is unsupported")
    validate_seal(report, "terminal-review report")
    counts = require_mapping(report.get("counts"), "terminal-review report.counts")
    inputs = require_mapping(report.get("inputs"), "terminal-review report.inputs")
    outputs = require_mapping(report.get("outputs"), "terminal-review report.outputs")
    contracts = require_mapping(
        report.get("contracts"), "terminal-review report.contracts"
    )
    safety = require_mapping(report.get("safety"), "terminal-review report.safety")
    reviewers = {bound.row.get("reviewer") for bound in records.values()}
    expected_finalizer_path = Path(__file__).with_name(
        "finalize_font_matching_font_signal_terminal_exclusions_v1.py"
    )
    if (
        counts.get("final_v3_accepted_checked") != len(final.accepted)
        or counts.get("glyph_normalization_pass") != len(final.accepted) - len(records)
        or counts.get("human_terminal_exclusions") != len(records)
        or counts.get("unresolved_review_holds") != 0
        or report.get("terminal_ids") != sorted(records)
        or reviewers != {report.get("reviewer")}
        or inputs.get("builder_source_sha256") != sha256_file(expected_finalizer_path)
        or inputs.get("promotion_contract_source_sha256")
        != sha256_file(Path(__file__).resolve())
        or inputs.get("final_v3_marker_sha256") != final.marker_file_sha256
        or inputs.get("final_v3_report_sha256") != final.file_hashes[FINAL_REPORT]
        or inputs.get("final_v3_accepted_sha256") != final.file_hashes[FINAL_ACCEPTED]
        or inputs.get("final_v3_terminal_sha256") != final.file_hashes[FINAL_TERMINAL]
        or inputs.get("glyph_preflight_record_sha256")
        != glyph_report.get("record_sha256")
        or outputs.get(TERMINAL_REVIEW_LEDGER)
        != sha256_file(root / TERMINAL_REVIEW_LEDGER)
        or outputs.get("root") != str(root)
        or contracts.get("allowed_terminal_ids") != sorted(TERMINAL_REVIEW_ALLOWED_IDS)
        or contracts.get("allowed_reason") != TERMINAL_REVIEW_REASON
        or contracts.get("all_other_glyph_gates_must_pass") is not True
        or contracts.get("accepted_crop_context_and_source_page_hash_bound") is not True
        or contracts.get("terminal_parent_exclusion_required_during_promotion")
        is not True
        or contracts.get("source_derived_mask_override_allowed") is not False
        or contracts.get("generated_or_synthetic_repair_allowed") is not False
        or safety.get("final_v3_modified") is not False
        or safety.get("library_modified") is not False
        or safety.get("assets_written") != 0
        or safety.get("replacement_pixels_created") != 0
        or safety.get("generated_or_synthetic_pixels") != 0
        or safety.get("qa_overlay_pixels") != 0
    ):
        raise FontSignalPromotionError("terminal-review report binding drifted")
    return TerminalReviewSnapshot(
        root=root,
        report=report,
        marker=marker,
        records=records,
        file_hashes=managed,
        marker_file_sha256=sha256_file(marker_path),
    )


def _resolved_promotion_ids(snapshot: PromotionSnapshot) -> tuple[set[str], set[str]]:
    glyph_records = _glyph_records_by_id(snapshot.glyph_report)
    if set(glyph_records) != set(snapshot.final.accepted):
        raise FontSignalPromotionError(
            "glyph preflight population differs from final-v3 accepted repairs"
        )
    holds = {
        sample_id
        for sample_id, record in glyph_records.items()
        if record.get("status") != "pass"
    }
    reviewed = (
        set(snapshot.terminal_review.records) if snapshot.terminal_review else set()
    )
    if holds != reviewed:
        raise GlyphNormalizationReviewHold(
            "glyph normalization holds are not exactly covered by the sealed "
            f"terminal review: holds={sorted(holds)} reviewed={sorted(reviewed)}"
        )
    if reviewed and reviewed != set(TERMINAL_REVIEW_ALLOWED_IDS):
        raise FontSignalPromotionError(
            "terminal review attempted to exclude an unapproved population"
        )
    eligible = set(snapshot.final.accepted) - reviewed
    if not eligible:
        raise FontSignalPromotionError("terminal resolution leaves no promotable rows")
    return eligible, reviewed


def _promotion_preflight_report(snapshot: PromotionSnapshot) -> dict[str, Any]:
    eligible, reviewed = _resolved_promotion_ids(snapshot)
    core = {
        key: copy.deepcopy(value)
        for key, value in snapshot.glyph_report.items()
        if key != "record_sha256"
    }
    counts = require_mapping(core.get("counts"), "glyph preflight.counts")
    counts["human_terminal_exclusions"] = len(reviewed)
    counts["promotable_after_terminal_resolution"] = len(eligible)
    counts["unresolved_review_holds"] = 0
    core["counts"] = counts
    core["completed"] = True
    core["terminal_resolution"] = {
        "applied": bool(reviewed),
        "terminal_ids": sorted(reviewed),
        "only_exact_approved_ids_allowed": True,
        "terminal_review_root": (
            str(snapshot.terminal_review.root) if snapshot.terminal_review else None
        ),
        "terminal_review_marker_sha256": (
            snapshot.terminal_review.marker_file_sha256
            if snapshot.terminal_review
            else None
        ),
        "terminal_review_ledger_sha256": (
            snapshot.terminal_review.file_hashes[TERMINAL_REVIEW_LEDGER]
            if snapshot.terminal_review
            else None
        ),
        "generated_or_synthetic_pixels": 0,
    }
    return seal(core)


def _promotion_snapshot_binding(snapshot: PromotionSnapshot) -> dict[str, Any]:
    return {
        "final_marker_sha256": snapshot.final.marker_file_sha256,
        "final_report_sha256": snapshot.final.file_hashes[FINAL_REPORT],
        "final_accepted_sha256": snapshot.final.file_hashes[FINAL_ACCEPTED],
        "final_terminal_sha256": snapshot.final.file_hashes[FINAL_TERMINAL],
        "source_master_manifest_sha256": snapshot.source_master.manifest_sha256,
        "source_master_report_sha256": snapshot.source_master.report_sha256,
        "registry_sha256": snapshot.registry.file_sha256,
        "registry_record_sha256": snapshot.registry.record_sha256,
        "registry_parent_manifest_sha256": snapshot.registry_parent.manifest_sha256,
        "frozen_split_map_sha256": sha256_file(snapshot.registry.frozen_split_map),
        "glyph_preflight_record_sha256": snapshot.glyph_report["record_sha256"],
        "terminal_review_marker_sha256": (
            snapshot.terminal_review.marker_file_sha256
            if snapshot.terminal_review
            else None
        ),
        "terminal_review_ledger_sha256": (
            snapshot.terminal_review.file_hashes[TERMINAL_REVIEW_LEDGER]
            if snapshot.terminal_review
            else None
        ),
        "terminal_review_report_sha256": (
            snapshot.terminal_review.file_hashes[TERMINAL_REVIEW_REPORT]
            if snapshot.terminal_review
            else None
        ),
    }


def _write_tree(
    *,
    snapshot: PromotionSnapshot,
    physical_root: Path,
    declared_root: Path,
    catalog_id: str,
    successor_registry_output: Path,
    successor_master_output: Path,
) -> dict[str, Any]:
    final = snapshot.final
    source_master = snapshot.source_master
    registry = snapshot.registry
    registry_parent = snapshot.registry_parent
    library_root = snapshot.library_root
    final_root = final.root
    all_target_ids = set(final.accepted)
    promoted_ids, terminal_ids = _resolved_promotion_ids(snapshot)
    for sample_id in sorted(all_target_ids):
        _validate_parent_pair(
            sample_id,
            source_master.rows[sample_id],
            registry_parent.rows[sample_id],
            final.accepted[sample_id],
            registry,
        )
    physical_root.mkdir(parents=True, exist_ok=False)
    manifest: list[dict[str, Any]] = []
    crosswalk: list[dict[str, Any]] = []
    exclusions: list[dict[str, Any]] = []
    for sample_id in sorted(promoted_ids):
        hard_row, crosswalk_row, exclusion = _build_successor(
            physical_root=physical_root,
            catalog_id=catalog_id,
            final=final,
            sample_id=sample_id,
            accepted=final.accepted[sample_id],
            source_parent=source_master.rows[sample_id],
            registry_parent=registry_parent.rows[sample_id],
        )
        manifest.append(hard_row)
        crosswalk.append(crosswalk_row)
        exclusions.append(exclusion)
    reviewed_terminal_rows: list[dict[str, Any]] = []
    if terminal_ids:
        if snapshot.terminal_review is None:
            raise FontSignalPromotionError("terminal IDs lack a sealed review artifact")
        for sample_id in sorted(terminal_ids):
            terminal_review = snapshot.terminal_review.records[sample_id]
            reviewed_terminal_rows.append(copy.deepcopy(terminal_review.row))
            exclusions.append(
                _build_terminal_parent_exclusion(
                    catalog_id=catalog_id,
                    sample_id=sample_id,
                    accepted=final.accepted[sample_id],
                    source_parent=source_master.rows[sample_id],
                    registry_parent=registry_parent.rows[sample_id],
                    terminal_review=terminal_review,
                )
            )
    if len({row["id"] for row in manifest}) != len(manifest):
        raise FontSignalPromotionError("duplicate successor source IDs")
    if len({row["crop_sha256"] for row in manifest}) != len(manifest):
        raise FontSignalPromotionError("duplicate successor crop pixels")
    if {row["parent_master_id"] for row in crosswalk} & {row["id"] for row in manifest}:
        raise FontSignalPromotionError("parent/successor ID overlap")
    (physical_root / MANIFEST_FILE).write_bytes(jsonl_bytes(manifest))
    (physical_root / CROSSWALK_FILE).write_bytes(jsonl_bytes(crosswalk))
    (physical_root / EXCLUSIONS_FILE).write_bytes(jsonl_bytes(exclusions))
    (physical_root / REVIEWED_TERMINAL_FILE).write_bytes(
        jsonl_bytes(reviewed_terminal_rows)
    )
    manifest_sha = sha256_file(physical_root / MANIFEST_FILE)
    exclusions_sha = sha256_file(physical_root / EXCLUSIONS_FILE)
    registry_input = _registry_successor_contract(
        registry=registry,
        output_root=declared_root,
        catalog_id=catalog_id,
        successor_registry_output=successor_registry_output,
        successor_master_output=successor_master_output,
        library_root=library_root,
        manifest_sha256=manifest_sha,
        exclusions_sha256=exclusions_sha,
        parent_master_manifest_sha256=registry_parent.manifest_sha256,
        accepted_count=len(manifest),
        exclusion_count=len(exclusions),
    )
    (physical_root / REGISTRY_INPUT_FILE).write_bytes(
        json_bytes(registry_input, pretty=True)
    )
    policy = {
        "schema_version": SCHEMA_VERSION,
        "tool": TOOL_ID,
        "catalog_id": catalog_id,
        "accepted_source": FINAL_SCHEMA_VERSION,
        "source_pixels": "hash_verified_library_page_crops_only",
        "raw_native_copy": "byte_exact_final_v3_accepted_crop_after_library_rederivation",
        "trainer_views": {
            "raw_224": {**LETTERBOX_TRANSFORM, "source": "accepted_raw"},
            "context_224": {
                **LETTERBOX_TRANSFORM,
                "source": "final_v3_review_context_direct_library_crop",
            },
            "glyph_224": {
                "source": "accepted_single_style_text_block_real_pixels",
                "operation": (
                    "border_polarity_contrast_normalized_masked_tight_crop_"
                    "then_letterbox"
                ),
                "normalization_contract": copy.deepcopy(GLYPH_NORMALIZATION_CONTRACT),
                "normalization_contract_sha256": (GLYPH_NORMALIZATION_CONTRACT_SHA256),
                "mask_synthesis": False,
                "source_derived_pixel_transform": True,
                "generated_or_synthetic_pixels": 0,
            },
        },
        "font_signal_present": True,
        "font_labels_inherited": False,
        "font_tiers_inherited": False,
        "none_decisions_inherited": False,
        "blind_primary_review_required": True,
        "independent_secondary_review_required": True,
        "priority": "P1",
        "synthetic_allowed": False,
        "qa_overlays_allowed": False,
        "every_promoted_parent_excluded": True,
        "every_human_terminal_parent_excluded": True,
        "human_terminal_exclusion_count": len(reviewed_terminal_rows),
        "terminal_exclusion_replacement_pixels": 0,
    }
    (physical_root / POLICY_FILE).write_bytes(json_bytes(policy, pretty=True))
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_font_signal_recrop_promotion_report",
            "tool": TOOL_ID,
            "catalog_id": catalog_id,
            "completed": True,
            "counts": {
                "final_v3_accepted": len(final.accepted),
                "final_v3_terminal_exclusions_bound_not_promoted": len(final.terminal),
                "promoted_successors": len(manifest),
                "parents_excluded": len(exclusions),
                "human_reviewed_terminal_exclusions": len(reviewed_terminal_rows),
                "unresolved_glyph_review_holds": 0,
                "raw_native_assets": len(manifest),
                "raw_224_assets": len(manifest),
                "context_224_assets": len(manifest),
                "glyph_224_assets": len(manifest),
                "glyph_normalization_pass": sum(
                    _nested(row, "glyph_normalization", "status") == "pass"
                    for row in manifest
                ),
                "glyph_normalization_review_hold": sum(
                    _nested(row, "glyph_normalization", "status") != "pass"
                    for row in manifest
                ),
                "font_labels_inherited": 0,
                "font_tiers_inherited": 0,
                "none_decisions_inherited": 0,
                "synthetic_assets": 0,
                "qa_overlay_assets": 0,
            },
            "inputs": {
                "builder_source_sha256": sha256_file(Path(__file__).resolve()),
                "final_v3_root": str(final_root),
                "final_v3_marker_sha256": final.marker_file_sha256,
                "final_v3_report_sha256": final.file_hashes[FINAL_REPORT],
                "final_v3_report_record_sha256": final.report["record_sha256"],
                "final_v3_accepted_sha256": final.file_hashes[FINAL_ACCEPTED],
                "final_v3_terminal_sha256": final.file_hashes[FINAL_TERMINAL],
                "source_master_manifest": str(source_master.manifest),
                "source_master_manifest_sha256": source_master.manifest_sha256,
                "source_master_report_sha256": source_master.report_sha256,
                "registry_path": str(registry.path),
                "registry_sha256": registry.file_sha256,
                "registry_record_sha256": registry.record_sha256,
                "registry_parent_master_manifest": str(registry_parent.manifest),
                "registry_parent_master_manifest_sha256": registry_parent.manifest_sha256,
                "library_root": str(library_root),
                "terminal_review_root": (
                    str(snapshot.terminal_review.root)
                    if snapshot.terminal_review
                    else None
                ),
                "terminal_review_marker_sha256": (
                    snapshot.terminal_review.marker_file_sha256
                    if snapshot.terminal_review
                    else None
                ),
                "terminal_review_ledger_sha256": (
                    snapshot.terminal_review.file_hashes[TERMINAL_REVIEW_LEDGER]
                    if snapshot.terminal_review
                    else None
                ),
                "terminal_review_report_sha256": (
                    snapshot.terminal_review.file_hashes[TERMINAL_REVIEW_REPORT]
                    if snapshot.terminal_review
                    else None
                ),
            },
            "outputs": {
                "root": str(declared_root),
                MANIFEST_FILE: manifest_sha,
                CROSSWALK_FILE: sha256_file(physical_root / CROSSWALK_FILE),
                EXCLUSIONS_FILE: exclusions_sha,
                REGISTRY_INPUT_FILE: sha256_file(physical_root / REGISTRY_INPUT_FILE),
                POLICY_FILE: sha256_file(physical_root / POLICY_FILE),
                REVIEWED_TERMINAL_FILE: sha256_file(
                    physical_root / REVIEWED_TERMINAL_FILE
                ),
            },
            "contracts": {
                "parent_and_successor_may_coexist": False,
                "parent_exclusion_ledger_required": True,
                "successors_unlabeled": True,
                "successors_review_required": True,
                "mandatory_independent_secondary": True,
                "glyph_normalization_fail_closed": True,
                "glyph_normalization_contract_sha256": (
                    GLYPH_NORMALIZATION_CONTRACT_SHA256
                ),
                "terminal_exclusions_exact_id_allowlist": sorted(
                    TERMINAL_REVIEW_ALLOWED_IDS
                ),
                "terminal_exclusions_require_human_source_context_hash_binding": True,
                "terminal_parent_exclusion_ledger_required": True,
                "registry_successor_not_built_by_this_tool": True,
            },
            "safety": {
                "source_pages_modified": False,
                "final_v3_modified": False,
                "source_master_modified": False,
                "current_registry_modified": False,
                "external_catalogs_modified": False,
                "hardlinks_created": 0,
                "generated_or_synthetic_pixels": 0,
                "glyph_pixels_source_derived_only": True,
                "terminal_replacement_pixels": 0,
                "qa_overlay_pixels": 0,
                "all_copies_rehashed": True,
                "all_views_deterministically_rebuilt": True,
            },
        }
    )
    (physical_root / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
    marker = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "tool": TOOL_ID,
        "catalog_id": catalog_id,
        "completed": True,
        "immutable": True,
        "safe_replace": False,
        "declared_root": str(declared_root),
        "managed_files": _managed_files(physical_root),
    }
    (physical_root / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
    return report


def validate_tree(root: Path, *, verify_assets: bool = True) -> dict[str, Any]:
    marker = _read_json(root / MARKER_FILE, "promotion marker")
    if (
        marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("tool") != TOOL_ID
        or marker.get("completed") is not True
        or marker.get("immutable") is not True
        or marker.get("safe_replace") is not False
        or marker.get("declared_root") != str(root.resolve())
    ):
        raise FontSignalPromotionError("promotion marker is invalid")
    catalog_id = require_component(marker.get("catalog_id"), "promotion catalog_id")
    _validate_managed_tree(root, MARKER_FILE, marker)
    manifest_rows = _read_bound_jsonl(root / MANIFEST_FILE, "promotion manifest")
    crosswalk_rows = _read_bound_jsonl(root / CROSSWALK_FILE, "promotion crosswalk")
    exclusion_rows = _read_bound_jsonl(root / EXCLUSIONS_FILE, "promotion exclusions")
    reviewed_terminal_rows = _read_bound_jsonl(
        root / REVIEWED_TERMINAL_FILE,
        "promotion reviewed terminal exclusions",
        allow_empty=True,
    )
    manifest = _unique_rows(manifest_rows, "id", "promotion manifest")
    crosswalk = _unique_rows(crosswalk_rows, "parent_master_id", "promotion crosswalk")
    exclusions = _unique_rows(
        exclusion_rows, "parent_master_id", "promotion exclusions"
    )
    reviewed_terminal = _unique_rows(
        reviewed_terminal_rows,
        "sample_id",
        "promotion reviewed terminal exclusions",
    )
    if reviewed_terminal and set(reviewed_terminal) != set(TERMINAL_REVIEW_ALLOWED_IDS):
        raise FontSignalPromotionError(
            "promotion terminal exclusions differ from the exact approved IDs"
        )
    if set(crosswalk) & set(reviewed_terminal):
        raise FontSignalPromotionError(
            "a parent cannot be both promoted and terminal-excluded"
        )
    if set(exclusions) != set(crosswalk) | set(reviewed_terminal) or len(
        manifest
    ) != len(crosswalk):
        raise FontSignalPromotionError(
            "manifest/crosswalk/exclusion populations differ"
        )
    for sample_id, bound in crosswalk.items():
        validate_seal(bound.row, f"crosswalk[{sample_id}]")
        exclusion = exclusions[sample_id].row
        validate_seal(exclusion, f"exclusion[{sample_id}]")
        successor_id = str(bound.row.get("successor_source_id"))
        if successor_id not in manifest:
            raise FontSignalPromotionError(f"{sample_id}: successor is absent")
        if (
            bound.row.get("old_font_labels_inherited") is not False
            or bound.row.get("old_font_tiers_inherited") is not False
            or bound.row.get("old_none_decision_inherited") is not False
            or bound.row.get("font_label_review_required") is not True
            or bound.row.get("independent_secondary_required") is not True
            or exclusion.get("excluded_from_training") is not True
            or exclusion.get("excluded_from_font_review") is not True
            or exclusion.get("parent_master_record_sha256")
            != bound.row.get("registry_parent_master_record_sha256")
        ):
            raise FontSignalPromotionError(
                f"{sample_id}: review/exclusion contract drifted"
            )
        if bound.row.get("parent_master_id") == bound.row.get(
            "successor_expected_master_id"
        ):
            raise FontSignalPromotionError(
                f"{sample_id}: parent/successor master overlap"
            )
    for sample_id, bound in reviewed_terminal.items():
        validate_seal(bound.row, f"reviewed-terminal[{sample_id}]")
        exclusion = exclusions[sample_id].row
        validate_seal(exclusion, f"terminal-exclusion[{sample_id}]")
        if (
            bound.row.get("status") != "terminal_exclusion_final"
            or bound.row.get("decision")
            != "exclude_from_core_training_without_replacement"
            or bound.row.get("reason_code") != TERMINAL_REVIEW_REASON
            or bound.row.get("excluded_from_downstream_training") is not True
            or bound.row.get("generated_or_synthetic_repair_authorized") is not False
            or bound.row.get("source_derived_mask_override_authorized") is not False
            or bound.row.get("terminal_resolution_scope") != "these_exact_two_ids_only"
            or bound.row.get("source_pixels_added") != 0
            or bound.row.get("source_artifact_mutated") is not False
            or exclusion.get("terminal_exclusion") is not True
            or exclusion.get("terminal_reason_code") != TERMINAL_REVIEW_REASON
            or exclusion.get("terminal_review_record_sha256")
            != bound.row.get("record_sha256")
            or exclusion.get("terminal_review_line_bytes_sha256")
            != bound.line_bytes_sha256
            or exclusion.get("successor_catalog_id") is not None
            or exclusion.get("successor_source_id") is not None
            or exclusion.get("successor_expected_master_id") is not None
            or exclusion.get("replacement_pixels_created") is not False
            or exclusion.get("excluded_from_training") is not True
            or exclusion.get("excluded_from_font_review") is not True
            or exclusion.get("synthetic") is not False
        ):
            raise FontSignalPromotionError(
                f"{sample_id}: terminal exclusion contract drifted"
            )
    for successor_id, bound in manifest.items():
        row = bound.row
        if (
            row.get("label") is not None
            or row.get("synthetic") is not False
            or row.get("synthetic_provenance") is not None
            or row.get("manual_recrop") is not True
            or row.get("font_signal_present") is not True
            or _nested(row, "font_label_review", "status") != "required"
            or _nested(row, "font_label_review", "required_stages")
            != ["blind_primary", "blind_independent_secondary"]
        ):
            raise FontSignalPromotionError(f"{successor_id}: unsafe hard-row semantics")
        leaks = _find_label_leaks(row)
        if leaks:
            raise FontSignalPromotionError(
                f"{successor_id}: font label leak {leaks[:4]}"
            )
        if _forbidden_true_flag(row):
            raise FontSignalPromotionError(f"{successor_id}: overlay/synthetic flag")
        for kind in ("raw", "raw_224", "context_224", "glyph_224"):
            descriptor = require_mapping(
                _nested(row, "assets", kind), f"{successor_id}.assets.{kind}"
            )
            relative = safe_relative(
                descriptor.get("path"), f"{successor_id}.assets.{kind}.path"
            )
            path = resolve_inside(root, relative, f"{successor_id}.assets.{kind}.path")
            expected = require_sha(
                descriptor.get("file_sha256"),
                f"{successor_id}.assets.{kind}.file_sha256",
            )
            if not path.is_file() or sha256_file(path) != expected:
                raise FontSignalPromotionError(f"{successor_id}: {kind} asset drifted")
            decoded = _decode_rgb(path.read_bytes(), f"{successor_id}.assets.{kind}")
            try:
                expected_size = descriptor.get("size_px")
                if expected_size != [decoded.width, decoded.height]:
                    raise FontSignalPromotionError(
                        f"{successor_id}: {kind} size drifted"
                    )
                if kind != "raw" and decoded.size != (224, 224):
                    raise FontSignalPromotionError(
                        f"{successor_id}: {kind} is not 224x224"
                    )
            finally:
                decoded.close()
        raw_descriptor = require_mapping(
            _nested(row, "assets", "raw"), f"{successor_id}.assets.raw"
        )
        raw_path = resolve_inside(
            root,
            safe_relative(
                raw_descriptor.get("path"),
                f"{successor_id}.assets.raw.path",
            ),
            f"{successor_id}.assets.raw.path",
        )
        raw_image = _decode_rgb(raw_path.read_bytes(), f"{successor_id}.assets.raw")
        normalization = _normalize_glyph(raw_image)
        try:
            _require_glyph_pass(normalization, successor_id)
            declared_normalization = require_mapping(
                row.get("glyph_normalization"),
                f"{successor_id}.glyph_normalization",
            )
            glyph_descriptor = require_mapping(
                _nested(row, "assets", "glyph_224"),
                f"{successor_id}.assets.glyph_224",
            )
            expected_payload = _png_bytes(normalization.glyph_224)
            expected_glyph_file_sha = sha256_bytes(expected_payload)
            expected_glyph_pixel_sha = pixel_sha256(normalization.glyph_224)
            expected_native_pixel_sha = pixel_sha256(normalization.normalized_native)
            local_tight = normalization.tight_bbox_local_px
            if local_tight is None:
                raise FontSignalPromotionError(
                    f"{successor_id}: recomputed glyph mask is empty"
                )
            bbox = row.get("bbox_px")
            if not (
                isinstance(bbox, list)
                and len(bbox) == 4
                and all(isinstance(value, int) for value in bbox)
            ):
                raise FontSignalPromotionError(
                    f"{successor_id}: invalid successor bbox"
                )
            expected_tight_page = [
                bbox[0] + local_tight[0],
                bbox[1] + local_tight[1],
                bbox[0] + local_tight[2],
                bbox[1] + local_tight[3],
            ]
            if (
                declared_normalization.get("status") != "pass"
                or declared_normalization.get("review_hold_reasons") != []
                or declared_normalization.get("contract_sha256")
                != GLYPH_NORMALIZATION_CONTRACT_SHA256
                or declared_normalization.get("statistics") != normalization.statistics
                or declared_normalization.get("transform") != normalization.transform
                or declared_normalization.get("normalized_native_pixel_sha256")
                != expected_native_pixel_sha
                or declared_normalization.get("glyph_224_file_sha256")
                != expected_glyph_file_sha
                or declared_normalization.get("glyph_224_pixel_sha256")
                != expected_glyph_pixel_sha
                or declared_normalization.get("source_pixels_only") is not True
                or declared_normalization.get("generated_or_synthetic_pixels") != 0
                or glyph_descriptor.get("file_sha256") != expected_glyph_file_sha
                or row.get("glyph_white_composite_sha256") != expected_glyph_pixel_sha
                or row.get("mask_tight_bbox_px") != expected_tight_page
                or row.get("clip_image_path")
                != _nested(row, "assets", "raw_224", "path")
                or row.get("raw_224_path") != _nested(row, "assets", "raw_224", "path")
                or row.get("glyph_224_path") != glyph_descriptor.get("path")
            ):
                raise FontSignalPromotionError(
                    f"{successor_id}: glyph normalization contract drifted"
                )
        finally:
            raw_image.close()
            normalization.glyph_224.close()
            normalization.normalized_native.close()
    try:
        catalog_read = master.read_catalog(
            master.SourceCatalog(catalog_id, "hard", root),
            verify_assets=verify_assets,
        )
    except (OSError, master.MasterManifestError) as error:
        raise FontSignalPromotionError(
            f"hard delta is not master-ingestible: {error}"
        ) from error
    expected_master_ids = {
        str(bound.row["successor_expected_master_id"]) for bound in crosswalk.values()
    }
    if {str(row["id"]) for row in catalog_read.records} != expected_master_ids:
        raise FontSignalPromotionError("master ID forecast differs from hard catalog")
    registry_input = _read_json(root / REGISTRY_INPUT_FILE, "registry successor input")
    validate_seal(registry_input, "registry successor input")
    if (
        registry_input.get("commands_executed_by_this_promotion") is not False
        or not isinstance(registry_input.get("build_registry_command_argv"), list)
        or not isinstance(registry_input.get("build_master_command_argv"), list)
    ):
        raise FontSignalPromotionError("registry successor command contract drifted")
    report = _read_json(root / REPORT_FILE, "promotion report")
    validate_seal(report, "promotion report")
    counts = require_mapping(report.get("counts"), "promotion report.counts")
    outputs = require_mapping(report.get("outputs"), "promotion report.outputs")
    if (
        counts.get("promoted_successors") != len(manifest)
        or counts.get("parents_excluded") != len(exclusions)
        or counts.get("human_reviewed_terminal_exclusions") != len(reviewed_terminal)
        or counts.get("unresolved_glyph_review_holds") != 0
        or counts.get("glyph_normalization_pass") != len(manifest)
        or counts.get("glyph_normalization_review_hold") != 0
        or counts.get("font_labels_inherited") != 0
        or counts.get("font_tiers_inherited") != 0
        or counts.get("none_decisions_inherited") != 0
    ):
        raise FontSignalPromotionError("promotion report counts drifted")
    for name in (
        MANIFEST_FILE,
        CROSSWALK_FILE,
        EXCLUSIONS_FILE,
        REGISTRY_INPUT_FILE,
        POLICY_FILE,
        REVIEWED_TERMINAL_FILE,
    ):
        if outputs.get(name) != sha256_file(root / name):
            raise FontSignalPromotionError(f"promotion report hash drifted: {name}")
    return report


def _compare_trees(expected: Path, actual: Path) -> None:
    expected_files = {
        path.relative_to(expected).as_posix(): path.read_bytes()
        for path in expected.rglob("*")
        if path.is_file()
    }
    actual_files = {
        path.relative_to(actual).as_posix(): path.read_bytes()
        for path in actual.rglob("*")
        if path.is_file()
    }
    if expected_files.keys() != actual_files.keys():
        raise FontSignalPromotionError("deterministic rebuild inventory differs")
    changed = [
        name for name in expected_files if expected_files[name] != actual_files[name]
    ]
    if changed:
        raise FontSignalPromotionError(f"deterministic rebuild differs: {changed[:8]}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate", "preflight"))
    parser.add_argument("--final-root", type=Path, required=True)
    parser.add_argument("--source-master-root", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument(
        "--terminal-exclusion-review-root",
        type=Path,
        help=(
            "sealed human terminal-resolution artifact; only the two hard-coded "
            "irreducible art holds are accepted"
        ),
    )
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--catalog-id", default=DEFAULT_CATALOG_ID)
    parser.add_argument("--successor-registry-output", type=Path)
    parser.add_argument("--successor-master-output", type=Path)
    parser.add_argument("--expected-accepted", type=int, default=EXPECTED_ACCEPTED)
    parser.add_argument("--expected-terminal", type=int, default=EXPECTED_TERMINAL)
    parser.add_argument("--no-verify-assets", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.expected_accepted < 1 or args.expected_terminal < 0:
        raise FontSignalPromotionError("expected counts must be non-negative")
    for raw_path, location in (
        (args.final_root, "final-v3 root"),
        (args.source_master_root, "source master root"),
        (args.catalog_registry, "catalog registry"),
        (args.library_root, "library root"),
        (args.output_root, "promotion output root"),
    ):
        reject_symlink_path(raw_path, location)
    if args.terminal_exclusion_review_root is not None:
        reject_symlink_path(args.terminal_exclusion_review_root, "terminal-review root")
    if args.successor_registry_output is not None:
        reject_symlink_path(args.successor_registry_output, "successor registry output")
    if args.successor_master_output is not None:
        reject_symlink_path(args.successor_master_output, "successor master output")
    final_root = args.final_root.expanduser().resolve()
    source_master_root = args.source_master_root.expanduser().resolve()
    registry_path = args.catalog_registry.expanduser().resolve()
    library_root = args.library_root.expanduser().resolve()
    terminal_review_root = (
        args.terminal_exclusion_review_root.expanduser().resolve()
        if args.terminal_exclusion_review_root is not None
        else None
    )
    output_root = args.output_root.expanduser().resolve()
    catalog_id = require_component(args.catalog_id, "catalog_id")
    successor_registry_output = (
        args.successor_registry_output.expanduser().resolve()
        if args.successor_registry_output is not None
        else output_root.parent / "font-matching-catalog-registry-v3.json"
    )
    successor_master_output = (
        args.successor_master_output.expanduser().resolve()
        if args.successor_master_output is not None
        else output_root.parent / "font-matching-master-v3"
    )
    exit_code = 0
    if args.command == "build":
        snapshot = _preflight(
            final_root=final_root,
            source_master_root=source_master_root,
            registry_path=registry_path,
            library_root=library_root,
            terminal_review_root=terminal_review_root,
            output_root=output_root,
            successor_registry_output=successor_registry_output,
            successor_master_output=successor_master_output,
            catalog_id=catalog_id,
            expected_accepted=args.expected_accepted,
            expected_terminal=args.expected_terminal,
        )
        _promotion_preflight_report(snapshot)
        _validate_publication_targets(
            snapshot,
            output_root=output_root,
            successor_registry_output=successor_registry_output,
            successor_master_output=successor_master_output,
            catalog_id=catalog_id,
        )
        output_root.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{output_root.name}.tmp-", dir=output_root.parent)
        )
        shutil.rmtree(temporary)
        try:
            report = _write_tree(
                snapshot=snapshot,
                physical_root=temporary,
                declared_root=output_root,
                catalog_id=catalog_id,
                successor_registry_output=successor_registry_output,
                successor_master_output=successor_master_output,
            )
            if snapshot.terminal_review is not None:
                revalidated = _load_promotion_snapshot(
                    final_root=final_root,
                    source_master_root=source_master_root,
                    registry_path=registry_path,
                    library_root=library_root,
                    terminal_review_root=terminal_review_root,
                    expected_accepted=args.expected_accepted,
                    expected_terminal=args.expected_terminal,
                )
                if _promotion_snapshot_binding(revalidated) != (
                    _promotion_snapshot_binding(snapshot)
                ):
                    raise FontSignalPromotionError(
                        "promotion inputs changed after terminal-review preflight"
                    )
                _resolved_promotion_ids(revalidated)
            _validate_publication_targets(
                snapshot,
                output_root=output_root,
                successor_registry_output=successor_registry_output,
                successor_master_output=successor_master_output,
                catalog_id=catalog_id,
            )
            temporary.replace(output_root)
            validate_tree(output_root, verify_assets=not args.no_verify_assets)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    elif args.command == "validate":
        report = validate_tree(output_root, verify_assets=not args.no_verify_assets)
        snapshot = _load_promotion_snapshot(
            final_root=final_root,
            source_master_root=source_master_root,
            registry_path=registry_path,
            library_root=library_root,
            terminal_review_root=terminal_review_root,
            expected_accepted=args.expected_accepted,
            expected_terminal=args.expected_terminal,
        )
        temporary = Path(tempfile.mkdtemp(prefix="font-signal-promote-validate-"))
        shutil.rmtree(temporary)
        try:
            _write_tree(
                snapshot=snapshot,
                physical_root=temporary,
                declared_root=output_root,
                catalog_id=catalog_id,
                successor_registry_output=successor_registry_output,
                successor_master_output=successor_master_output,
            )
            _compare_trees(output_root, temporary)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    else:
        snapshot = _preflight(
            final_root=final_root,
            source_master_root=source_master_root,
            registry_path=registry_path,
            library_root=library_root,
            terminal_review_root=terminal_review_root,
            output_root=output_root,
            successor_registry_output=successor_registry_output,
            successor_master_output=successor_master_output,
            catalog_id=catalog_id,
            expected_accepted=args.expected_accepted,
            expected_terminal=args.expected_terminal,
        )
        try:
            report = _promotion_preflight_report(snapshot)
        except GlyphNormalizationReviewHold:
            report = snapshot.glyph_report
            exit_code = 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
