#!/usr/bin/env python3
"""Build balanced, manga-noisy synthetic training views for all 22 Korean fonts.

The generator follows the useful parts of FontVLM-style augmented synthetic
similarity while staying specific to this application: real library-derived
background texture, Korean translation text, effect-sound-heavy sampling,
outline/shadow/inverse treatments, horizontal and vertical layout, and three
views matching the runtime crop contract.

Every font receives the same role distribution.  Role and genre therefore
cannot become shortcuts for font identity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

try:
    import font_matching_catalog_assets as catalog_assets
except ImportError:  # pragma: no cover - import from repository root
    from scripts import font_matching_catalog_assets as catalog_assets  # type: ignore[no-redef]


SCHEMA_VERSION = "manga-font-synthetic-v1"
REPORT_SCHEMA_VERSION = "manga-font-synthetic-report-v1"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
HANGUL_RE = re.compile(r"[가-힣]")
SOURCE_SCRIPT_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")

ROLE_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("dialogue", 0.16),
    ("narration", 0.08),
    ("thought", 0.07),
    ("aside_balloon_edge", 0.09),
    ("emphasis_dialogue", 0.10),
    ("shout", 0.10),
    ("sfx_impact", 0.11),
    ("sfx_motion", 0.08),
    ("sfx_ambient", 0.07),
    ("sfx_emotion", 0.07),
    ("sfx_comic", 0.05),
    ("sign_ui_title", 0.02),
)
VARIANT_ROLES = frozenset(
    {
        "aside_balloon_edge",
        "emphasis_dialogue",
        "shout",
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
        "sign_ui_title",
    }
)
SFX_TEXTS: Mapping[str, tuple[str, ...]] = {
    "sfx_impact": (
        "쾅!!",
        "콰앙!",
        "쿵",
        "퍽!",
        "콱",
        "와장창",
        "쿠궁",
        "두둥!",
        "철컥",
        "팟!",
        "콰직",
        "쾅쾅",
    ),
    "sfx_motion": (
        "휘익-",
        "슥",
        "휙!",
        "타다닥",
        "사박",
        "스윽",
        "부웅",
        "홱",
        "촤악",
        "후다닥",
    ),
    "sfx_ambient": (
        "스산...",
        "웅성웅성",
        "고요...",
        "주룩",
        "쏴아",
        "부스럭",
        "사각사각",
        "째깍",
        "우우웅",
    ),
    "sfx_emotion": (
        "두근 두근",
        "흠칫",
        "울컥",
        "화들짝",
        "부들부들",
        "움찔",
        "찌릿",
        "흑흑",
        "헤헤",
    ),
    "sfx_comic": (
        "삐질...",
        "데굴",
        "띠용",
        "머엉",
        "시무룩",
        "에헷",
        "힐끔",
        "쭈뼛",
    ),
}
FALLBACK_TEXTS: Mapping[str, tuple[str, ...]] = {
    "dialogue": (
        "지금 가는 거야?",
        "그럴 리가 없잖아.",
        "잠깐만 기다려 줘.",
        "난 아직 포기하지 않았어.",
        "정말 괜찮은 거지?",
        "오늘은 여기까지 하자.",
    ),
    "narration": (
        "그날 밤의 기록.",
        "이것은 오래전 이야기다.",
        "운명은 조용히 움직였다.",
        "그리고 다음 날 아침.",
    ),
    "thought": (
        "설마, 들킨 건가?",
        "이대로는 안 돼.",
        "조금만 더 생각하자.",
        "왜 이렇게 두근거리지?",
    ),
    "aside_balloon_edge": (
        "저기, 잠깐...",
        "아무것도 아니야.",
        "그게 말이지...",
        "사실은 나도 몰라.",
    ),
    "emphasis_dialogue": (
        "절대로 안 돼!",
        "이번만큼은 진심이야.",
        "그 말을 믿으라고?",
        "내가 직접 끝내겠어!",
    ),
    "shout": (
        "멈춰!!",
        "당장 비켜!",
        "말도 안 돼!",
        "이쪽으로 와!",
        "절대 놓치지 마!",
    ),
    "sign_ui_title": (
        "왕도 중앙 광장",
        "제3 훈련장",
        "긴급 임무",
        "다음 이야기",
        "마법 상점",
    ),
}


class SyntheticBuildError(ValueError):
    """Raised when synthetic generation cannot preserve its contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_sha256(value: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise SyntheticBuildError(f"{path}:{line_number}: expected object")
            yield value


def _clean_korean_text(value: str) -> str | None:
    text = re.sub(r"\s+", " ", value.strip().strip('"`'))
    text = re.sub(r"\\n", " ", text)
    if not HANGUL_RE.search(text) or SOURCE_SCRIPT_RE.search(text):
        return None
    if len(text) < 2 or len(text) > 42:
        return None
    if text.count("[") + text.count("]") > 2:
        return None
    return text


def collect_translation_texts(library_root: Path) -> dict[str, list[str]]:
    pools: dict[str, set[str]] = {role: set(values) for role, values in FALLBACK_TEXTS.items()}
    for role, values in SFX_TEXTS.items():
        pools.setdefault(role, set()).update(values)
    pattern = "works/*/chapters/*/runs/*/pages/*/attempt-*/result.json"
    for path in library_root.glob(pattern):
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        output = value.get("outputText") if isinstance(value, Mapping) else None
        if not isinstance(output, str):
            continue
        for block in re.split(r"\n\s*\n", output):
            match = re.search(r"(?mi)^\s*ko\s*:\s*(.+?)\s*$", block)
            if match is None:
                continue
            cleaned = _clean_korean_text(match.group(1))
            if cleaned is None:
                continue
            role_match = re.search(
                r"(?mi)^\s*(?:textRole|type)\s*:\s*([\w_-]+)\s*$", block
            )
            raw_role = role_match.group(1).casefold() if role_match else "dialogue"
            if raw_role in {"sound", "sfx", "effect", "sound_effect"}:
                role = "sfx_comic"
            elif raw_role in {"narration", "narrator"}:
                role = "narration"
            elif raw_role in {"name", "title", "sign", "ui"}:
                role = "sign_ui_title"
            else:
                role = "dialogue"
            pools.setdefault(role, set()).add(cleaned)
    # Ensure variant roles never silently fall back to ordinary-only content.
    pools.setdefault("thought", set()).update(FALLBACK_TEXTS["thought"])
    pools.setdefault("aside_balloon_edge", set()).update(
        FALLBACK_TEXTS["aside_balloon_edge"]
    )
    pools.setdefault("emphasis_dialogue", set()).update(
        FALLBACK_TEXTS["emphasis_dialogue"]
    )
    pools.setdefault("shout", set()).update(FALLBACK_TEXTS["shout"])
    return {key: sorted(values) for key, values in pools.items() if values}


def load_font_faces(catalog_path: Path, project_root: Path) -> list[dict[str, Any]]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8-sig"))
    families = catalog.get("families")
    if not isinstance(families, list) or len(families) != 22:
        raise SyntheticBuildError("font catalog must contain exactly 22 families")
    output: list[dict[str, Any]] = []
    for family in families:
        resolutions = family.get("production_style_resolution")
        faces = family.get("faces")
        if not isinstance(resolutions, list) or not isinstance(faces, list):
            raise SyntheticBuildError("font family lacks face resolution")
        selected = next(
            (
                row
                for row in resolutions
                if row.get("requested_weight") == 400
                and row.get("requested_style") == "normal"
            ),
            None,
        )
        if selected is None:
            raise SyntheticBuildError(f"{family.get('font_id')}: no 400-normal face")
        face = next(
            (row for row in faces if row.get("face_id") == selected.get("selected_face_id")),
            None,
        )
        if face is None:
            raise SyntheticBuildError(f"{family.get('font_id')}: selected face missing")
        font_path = (project_root / str(face["file"])).resolve()
        if not font_path.is_file() or sha256_file(font_path) != face.get("sha256"):
            raise SyntheticBuildError(f"{family.get('font_id')}: font asset drifted")
        output.append(
            {
                "font_id": str(family["font_id"]),
                "font_label": str(family["label"]),
                "font_path": font_path,
                "font_sha256": str(face["sha256"]),
            }
        )
    return output


def reservoir_background_rows(
    master_manifest: Path, *, count: int, seed: int
) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    reservoir: list[dict[str, Any]] = []
    seen = 0
    for row in iter_jsonl(master_manifest):
        if row.get("split") != "train":
            continue
        seen += 1
        compact = {"id": row.get("id"), "views": row.get("views")}
        if len(reservoir) < count:
            reservoir.append(compact)
        else:
            replace_at = rng.randrange(seen)
            if replace_at < count:
                reservoir[replace_at] = compact
    if not reservoir:
        raise SyntheticBuildError("no train backgrounds found")
    return reservoir


def load_backgrounds(
    *,
    rows: Sequence[Mapping[str, Any]],
    resolver: catalog_assets.CatalogAssetResolver,
) -> list[Image.Image]:
    output: list[Image.Image] = []
    for row in rows:
        sample = {"sample_id": str(row["id"]), "source": {"views": row["views"]}}
        with resolver.resolve_sample_view(sample, "context_224") as resolved:
            output.append(resolved.image.convert("RGB"))
    return output


def choose_role(rng: random.Random) -> str:
    value = rng.random()
    cumulative = 0.0
    for role, weight in ROLE_WEIGHTS:
        cumulative += weight
        if value <= cumulative:
            return role
    return ROLE_WEIGHTS[-1][0]


def constrain_text_for_crop(
    text: str, *, role: str, orientation: str, rng: random.Random
) -> str:
    """Keep glyphs legible at 224px instead of shrinking long prose to a line."""

    if role.startswith("sfx_"):
        limit = 9 if orientation == "horizontal" else 7
    elif role in VARIANT_ROLES:
        limit = 13 if orientation == "horizontal" else 8
    else:
        limit = 18 if orientation == "horizontal" else 9
    normalized = re.sub(r"\s+", " ", text.strip())
    if len(normalized) <= limit:
        return normalized
    clauses = [part.strip() for part in re.split(r"(?<=[.!?…])\s+|[,;]\s*", normalized)]
    eligible = [part for part in clauses if 2 <= len(part) <= limit]
    if eligible:
        return rng.choice(eligible)
    start_max = max(0, len(normalized) - limit)
    start = rng.randint(0, start_max) if start_max else 0
    fragment = normalized[start : start + limit].strip()
    return fragment if len(fragment) >= 2 else normalized[:limit]


def _split_for_index(index: int, total: int) -> str:
    # Stable 86.7/6.7/6.6 split for the default 600 examples per font.
    fraction = (index + 0.5) / total
    if fraction < 0.8666667:
        return "train"
    if fraction < 0.9333334:
        return "val"
    return "test"


def _fit_font(font_path: Path, text: str, orientation: str, target: tuple[int, int]) -> ImageFont.FreeTypeFont:
    low, high = 24, 104
    selected = ImageFont.truetype(str(font_path), low)
    while low <= high:
        middle = (low + high) // 2
        candidate = ImageFont.truetype(str(font_path), middle)
        probe = Image.new("L", (8, 8))
        draw = ImageDraw.Draw(probe)
        if orientation == "horizontal":
            bbox = draw.textbbox((0, 0), text, font=candidate, stroke_width=3)
            width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        else:
            boxes = [draw.textbbox((0, 0), char, font=candidate, stroke_width=3) for char in text]
            width = max((box[2] - box[0] for box in boxes), default=1)
            height = sum(max(1, box[3] - box[1]) for box in boxes) + max(0, len(text) - 1) * 2
        if width <= target[0] and height <= target[1]:
            selected = candidate
            low = middle + 1
        else:
            high = middle - 1
    return selected


def _draw_horizontal(
    mask: Image.Image,
    *,
    text: str,
    font: ImageFont.FreeTypeFont,
    stroke_width: int,
    rng: random.Random,
) -> None:
    draw = ImageDraw.Draw(mask)
    spacing = rng.randint(-2, 5)
    widths = [draw.textlength(char, font=font) for char in text]
    total = sum(widths) + spacing * max(0, len(text) - 1)
    x = (mask.width - total) / 2
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    y = (mask.height - (bbox[3] - bbox[1])) / 2 - bbox[1]
    for char, width in zip(text, widths):
        draw.text(
            (round(x), round(y)),
            char,
            fill=255,
            font=font,
            stroke_width=stroke_width,
            stroke_fill=255,
        )
        x += width + spacing


def _draw_vertical(
    mask: Image.Image,
    *,
    text: str,
    font: ImageFont.FreeTypeFont,
    stroke_width: int,
    rng: random.Random,
) -> None:
    draw = ImageDraw.Draw(mask)
    chars = list(text.replace(" ", ""))
    spacing = rng.randint(0, 6)
    boxes = [draw.textbbox((0, 0), char, font=font, stroke_width=stroke_width) for char in chars]
    heights = [max(1, box[3] - box[1]) for box in boxes]
    total = sum(heights) + spacing * max(0, len(chars) - 1)
    y = (mask.height - total) / 2
    for char, box, height in zip(chars, boxes, heights):
        width = box[2] - box[0]
        x = (mask.width - width) / 2 - box[0]
        draw.text(
            (round(x), round(y - box[1])),
            char,
            fill=255,
            font=font,
            stroke_width=stroke_width,
            stroke_fill=255,
        )
        y += height + spacing


def render_mask(
    *,
    font_path: Path,
    text: str,
    orientation: str,
    rng: random.Random,
    role: str,
) -> tuple[Image.Image, dict[str, Any]]:
    canvas = Image.new("L", (512, 384 if orientation == "horizontal" else 640), 0)
    max_width = 430 if orientation == "horizontal" else 180
    max_height = 210 if orientation == "horizontal" else 560
    font = _fit_font(font_path, text, orientation, (max_width, max_height))
    stroke_width = rng.choices((0, 1, 2, 3, 4), weights=(25, 20, 24, 20, 11))[0]
    if orientation == "horizontal":
        _draw_horizontal(
            canvas, text=text, font=font, stroke_width=stroke_width, rng=rng
        )
    else:
        _draw_vertical(
            canvas, text=text, font=font, stroke_width=stroke_width, rng=rng
        )

    slant = rng.uniform(-0.18, 0.18) if role in VARIANT_ROLES else rng.uniform(-0.07, 0.07)
    if abs(slant) > 0.01:
        shift = abs(slant) * canvas.height
        canvas = canvas.transform(
            (canvas.width + round(shift), canvas.height),
            Image.Transform.AFFINE,
            (1, slant, -min(0.0, slant * canvas.height), 0, 1, 0),
            resample=Image.Resampling.BICUBIC,
        )
    angle_limit = 15 if role in VARIANT_ROLES else 4
    angle = rng.uniform(-angle_limit, angle_limit)
    if abs(angle) > 0.2:
        canvas = canvas.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    bbox = canvas.getbbox()
    if bbox is None:
        raise SyntheticBuildError("font rendered an empty mask")
    pad = rng.randint(6, 24)
    bbox = (
        max(0, bbox[0] - pad),
        max(0, bbox[1] - pad),
        min(canvas.width, bbox[2] + pad),
        min(canvas.height, bbox[3] + pad),
    )
    cropped = canvas.crop(bbox)
    return cropped, {
        "angle_degrees": round(angle, 4),
        "font_size_px": int(font.size),
        "slant": round(slant, 5),
        "stroke_width_px": stroke_width,
    }


def _paper_background(rng: random.Random) -> Image.Image:
    base = np.full((224, 224, 3), rng.randint(232, 255), dtype=np.float32)
    noise = np.random.default_rng(rng.getrandbits(64)).normal(0.0, rng.uniform(1.5, 9.0), base.shape[:2])
    base += noise[:, :, None]
    return Image.fromarray(np.uint8(np.clip(base, 0, 255)))


def make_background(rng: random.Random, real_backgrounds: Sequence[Image.Image]) -> tuple[Image.Image, str]:
    choice = rng.random()
    if choice < 0.34 or not real_backgrounds:
        return Image.new("RGB", (224, 224), (255, 255, 255)), "white"
    if choice < 0.62:
        return _paper_background(rng), "paper_noise"
    source = rng.choice(real_backgrounds)
    background = ImageOps.fit(source, (224, 224), method=Image.Resampling.LANCZOS)
    background = background.filter(ImageFilter.GaussianBlur(rng.uniform(3.0, 10.0)))
    background = ImageEnhance.Contrast(background).enhance(rng.uniform(0.22, 0.58))
    background = ImageEnhance.Brightness(background).enhance(rng.uniform(0.85, 1.2))
    if rng.random() < 0.75:
        gray = ImageOps.grayscale(background)
        background = Image.merge("RGB", (gray, gray, gray))
    return background, "real_library_blurred"


def letterbox(image: Image.Image, *, fill: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    source = image.convert("RGB")
    scale = min(224 / source.width, 224 / source.height)
    resized = source.resize(
        (max(1, round(source.width * scale)), max(1, round(source.height * scale))),
        Image.Resampling.LANCZOS,
    )
    output = Image.new("RGB", (224, 224), fill)
    output.paste(resized, ((224 - resized.width) // 2, (224 - resized.height) // 2))
    source.close()
    resized.close()
    return output


def make_views(
    *,
    mask: Image.Image,
    rng: random.Random,
    real_backgrounds: Sequence[Image.Image],
) -> tuple[dict[str, Image.Image], dict[str, Any]]:
    max_axis = rng.randint(112, 202)
    scale = min(max_axis / max(mask.width, mask.height), 1.5)
    rendered_mask = mask.resize(
        (max(1, round(mask.width * scale)), max(1, round(mask.height * scale))),
        Image.Resampling.LANCZOS,
    )
    glyph_white = Image.new("RGB", rendered_mask.size, (255, 255, 255))
    glyph_white.paste((0, 0, 0), mask=rendered_mask)
    glyph = letterbox(glyph_white)

    context, background_kind = make_background(rng, real_backgrounds)
    inverse = rng.random() < 0.14
    colored = rng.random() < 0.16
    fill = (
        (255, 255, 255)
        if inverse
        else (
            (rng.randint(10, 130), rng.randint(10, 130), rng.randint(10, 130))
            if colored
            else (rng.randint(0, 36),) * 3
        )
    )
    outline_color = (0, 0, 0) if inverse else (255, 255, 255)

    # Inverse text is only meaningful when its white glyphs sit on a dark
    # field.  Leaving a white inverse glyph on the overwhelmingly light manga
    # backgrounds creates an all-white training view, which teaches nothing
    # about the font.  Darkening retains the source texture while guaranteeing
    # a usable foreground/background contrast; the optional balloon below is
    # also rendered dark for the same reason.
    if inverse:
        darkened = ImageEnhance.Brightness(context).enhance(rng.uniform(0.10, 0.32))
        context.close()
        context = darkened

    placement_x = rng.randint(4, max(4, 220 - rendered_mask.width))
    placement_y = rng.randint(4, max(4, 220 - rendered_mask.height))
    if rng.random() < 0.55:
        balloon = Image.new("L", (224, 224), 0)
        draw = ImageDraw.Draw(balloon)
        margin = rng.randint(5, 18)
        draw.ellipse(
            (
                max(0, placement_x - margin),
                max(0, placement_y - margin),
                min(223, placement_x + rendered_mask.width + margin),
                min(223, placement_y + rendered_mask.height + margin),
            ),
            fill=rng.randint(0, 62) if inverse else rng.randint(190, 255),
        )
        balloon_fill = Image.new(
            "RGB",
            (224, 224),
            ((rng.randint(0, 38),) * 3) if inverse else (255, 255, 255),
        )
        context = Image.composite(balloon_fill, context, balloon)
        balloon_fill.close()
        balloon.close()

    shadow_kind = "none"
    if rng.random() < 0.38:
        shadow_kind = "soft" if rng.random() < 0.55 else "hard"
        shadow_mask = rendered_mask
        if shadow_kind == "soft":
            shadow_mask = rendered_mask.filter(ImageFilter.GaussianBlur(rng.uniform(1.0, 3.5)))
        context.paste(
            (0, 0, 0),
            (placement_x + rng.randint(2, 7), placement_y + rng.randint(2, 7)),
            shadow_mask,
        )

    # A dilated mask gives an independent outline treatment without changing
    # the font glyph's interior identity.
    outline_width = rng.choices((0, 1, 2, 3, 4, 5), weights=(36, 15, 18, 14, 10, 7))[0]
    if outline_width:
        size = outline_width * 2 + 1
        outlined = rendered_mask.filter(ImageFilter.MaxFilter(size))
        context.paste(outline_color, (placement_x, placement_y), outlined)
        outlined.close()
    context.paste(fill, (placement_x, placement_y), rendered_mask)

    margin = rng.randint(2, 18)
    crop_box = (
        max(0, placement_x - margin),
        max(0, placement_y - margin),
        min(224, placement_x + rendered_mask.width + margin),
        min(224, placement_y + rendered_mask.height + margin),
    )
    raw = letterbox(context.crop(crop_box))
    if rng.random() < 0.30:
        raw = ImageEnhance.Contrast(raw).enhance(rng.uniform(0.65, 1.55))
    if rng.random() < 0.20:
        raw = raw.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.0)))
    views = {"raw_224": raw, "context_224": context, "glyph_224": glyph}
    metadata = {
        "background": background_kind,
        "fill_rgb": list(fill),
        "inverse": inverse,
        "outline_width_px": outline_width,
        "shadow": shadow_kind,
    }
    glyph_white.close()
    rendered_mask.close()
    return views, metadata


def save_png(path: Path, image: Image.Image) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        image.save(temporary, format="PNG", compress_level=1)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "byte_size": path.stat().st_size,
        "path": path.as_posix(),
        "sha256": sha256_file(path),
        "size_px": [image.width, image.height],
    }


def build(args: argparse.Namespace) -> int:
    project_root = args.project_root.resolve()
    output_root = args.output_dir.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_dir = output_root / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    fonts = load_font_faces(args.font_catalog.resolve(), project_root)
    text_pools = collect_translation_texts(args.library_root.resolve())
    resolver = catalog_assets.CatalogAssetResolver(args.catalog_registry.resolve())
    background_rows = reservoir_background_rows(
        args.master_manifest.resolve(), count=args.background_count, seed=args.seed
    )
    backgrounds = load_backgrounds(rows=background_rows, resolver=resolver)
    role_counts: Counter[str] = Counter()
    split_counts: Counter[str] = Counter()
    background_counts: Counter[str] = Counter()
    merged_rows: list[dict[str, Any]] = []
    try:
        for font_index, font in enumerate(fonts):
            font_id = font["font_id"]
            shard_path = manifest_dir / f"{font_id}.jsonl"
            if shard_path.is_file():
                rows = list(iter_jsonl(shard_path))
                if len(rows) != args.samples_per_font or any(
                    row.get("font_id") != font_id for row in rows
                ):
                    raise SyntheticBuildError(f"stale partial shard: {shard_path}")
                merged_rows.extend(rows)
                for row in rows:
                    role_counts[str(row["role"])] += 1
                    split_counts[str(row["split"])] += 1
                    background_counts[str(row["augmentation"]["background"])] += 1
                print(f"font {font_index + 1}/{len(fonts)} {font_id}: reuse", flush=True)
                continue
            shard_rows: list[dict[str, Any]] = []
            for local_index in range(args.samples_per_font):
                sample_seed = int.from_bytes(
                    hashlib.sha256(
                        f"{args.seed}:{font_id}:{local_index}".encode("utf-8")
                    ).digest()[:8],
                    "big",
                )
                rng = random.Random(sample_seed)
                role = choose_role(rng)
                pool = text_pools.get(role) or text_pools.get("dialogue")
                if not pool:
                    raise SyntheticBuildError(f"no text pool for {role}")
                text = rng.choice(pool)
                if role.startswith("sfx_") and role in SFX_TEXTS and rng.random() < 0.8:
                    text = rng.choice(SFX_TEXTS[role])
                orientation = (
                    "vertical"
                    if rng.random() < (0.42 if role in VARIANT_ROLES else 0.25)
                    else "horizontal"
                )
                text = constrain_text_for_crop(
                    text, role=role, orientation=orientation, rng=rng
                )
                mask, geometry = render_mask(
                    font_path=font["font_path"],
                    text=text,
                    orientation=orientation,
                    rng=rng,
                    role=role,
                )
                try:
                    views, treatment = make_views(
                        mask=mask, rng=rng, real_backgrounds=backgrounds
                    )
                finally:
                    mask.close()
                split = _split_for_index(local_index, args.samples_per_font)
                sample_id = "mfs_" + hashlib.sha256(
                    f"{font_id}:{local_index}:{sample_seed}".encode("utf-8")
                ).hexdigest()[:24]
                view_records = {}
                try:
                    for view_name, image in views.items():
                        relative = Path("images") / split / font_id / f"{sample_id}-{view_name}.png"
                        record = save_png(output_root / relative, image)
                        record["path"] = relative.as_posix()
                        view_records[view_name] = record
                finally:
                    for image in views.values():
                        image.close()
                core = {
                    "augmentation": {**geometry, **treatment},
                    "font_id": font_id,
                    "font_label": font["font_label"],
                    "font_sha256": font["font_sha256"],
                    "orientation": orientation,
                    "role": role,
                    "sample_id": sample_id,
                    "schema_version": SCHEMA_VERSION,
                    "seed": sample_seed,
                    "split": split,
                    "synthetic": True,
                    "text": text,
                    "variant_role": role in VARIANT_ROLES,
                    "views": view_records,
                }
                core["record_sha256"] = record_sha256(core)
                shard_rows.append(core)
                role_counts[role] += 1
                split_counts[split] += 1
                background_counts[treatment["background"]] += 1
            payload = b"".join(
                (canonical_json(row) + "\n").encode("utf-8") for row in shard_rows
            )
            atomic_write(shard_path, payload)
            merged_rows.extend(shard_rows)
            print(
                f"font {font_index + 1}/{len(fonts)} {font_id}: {len(shard_rows)}",
                flush=True,
            )
    finally:
        for background in backgrounds:
            background.close()

    merged_rows.sort(key=lambda row: (str(row["split"]), str(row["sample_id"])))
    manifest_path = output_root / "manifest.jsonl"
    manifest_payload = b"".join(
        (canonical_json(row) + "\n").encode("utf-8") for row in merged_rows
    )
    atomic_write(manifest_path, manifest_payload)
    report = {
        "background_counts": dict(sorted(background_counts.items())),
        "background_source_count": len(background_rows),
        "bindings": {
            "catalog_registry_sha256": sha256_file(args.catalog_registry),
            "font_catalog_sha256": sha256_file(args.font_catalog),
            "master_manifest_sha256": sha256_file(args.master_manifest),
        },
        "candidate_count": len(fonts),
        "candidate_ids": [font["font_id"] for font in fonts],
        "manifest": manifest_path.name,
        "manifest_sha256": sha256_file(manifest_path),
        "record_count": len(merged_rows),
        "role_counts": dict(sorted(role_counts.items())),
        "samples_per_font": args.samples_per_font,
        "schema_version": REPORT_SCHEMA_VERSION,
        "split_counts": dict(sorted(split_counts.items())),
        "text_pool_counts": {key: len(value) for key, value in sorted(text_pools.items())},
        "variant_fraction": sum(
            count for role, count in role_counts.items() if role in VARIANT_ROLES
        )
        / max(1, len(merged_rows)),
    }
    report["record_sha256"] = record_sha256(report)
    atomic_write(
        output_root / "report.json",
        (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        ),
    )
    print(canonical_json({"completed": True, "records": len(merged_rows)}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--font-catalog", type=Path, required=True)
    parser.add_argument("--master-manifest", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--samples-per-font", type=int, default=600)
    parser.add_argument("--background-count", type=int, default=512)
    parser.add_argument("--seed", type=int, default=20260803)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.samples_per_font < 15:
        raise SyntheticBuildError("samples-per-font must be at least 15")
    if args.background_count < 1:
        raise SyntheticBuildError("background-count must be positive")
    return build(args)


if __name__ == "__main__":
    raise SystemExit(main())
