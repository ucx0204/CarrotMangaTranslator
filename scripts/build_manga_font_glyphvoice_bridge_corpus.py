#!/usr/bin/env python3
"""Build the glyph-verified cross-script corpus for MangaFont GlyphVoice.

This builder deliberately separates three kinds of evidence:

* a cross-script bridge is a Japanese/Korean sentence pair rendered by the
  exact same physical font face;
* a Japanese-only or Korean-only face contributes within-script font-instance
  supervision, never an invented cross-script label;
* a face whose cmap lies (missing outline, .notdef reuse, or blank raster) is
  excluded at the individual glyph level.

Every bridge pair gets its own review PNG containing exactly one Japanese
sentence and one Korean candidate sentence.  Contact sheets are not produced.
The output is training-only and carries no evaluation or production authority.
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
import stat
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTCollection, TTFont
from PIL import Image, ImageDraw, ImageFont


SOURCE_SCHEMA_VERSION = "manga-font-glyphvoice-font-sources-v1"
CORPUS_SCHEMA_VERSION = "manga-font-glyphvoice-bridge-corpus-v1"
OWNER = "carrot-manga-translator/manga-font-glyphvoice-bridge-corpus-v1"
SOURCE_RECORD_TYPE = "manga_font_glyphvoice_font_sources"
FACE_RECORD_TYPE = "manga_font_glyphvoice_face"
SAMPLE_RECORD_TYPE = "manga_font_glyphvoice_sentence_sample"
PAIR_RECORD_TYPE = "manga_font_glyphvoice_bridge_pair"
MANIFEST_RECORD_TYPE = "manga_font_glyphvoice_bridge_corpus_manifest"
REPORT_RECORD_TYPE = "manga_font_glyphvoice_bridge_corpus_report"

FACES_FILE = "faces.jsonl"
SAMPLES_FILE = "samples.jsonl"
PAIRS_FILE = "bridge-pairs.jsonl"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
MARKER_FILE = ".manga-font-glyphvoice-bridge-corpus-v1-owned.json"
ASSET_DIR = "assets"
ROOT_INVENTORY = frozenset(
    {
        FACES_FILE,
        SAMPLES_FILE,
        PAIRS_FILE,
        MANIFEST_FILE,
        REPORT_FILE,
        MARKER_FILE,
        ASSET_DIR,
    }
)
FONT_EXTENSIONS = frozenset({".ttf", ".ttc", ".otf", ".otc"})
ALLOWED_LICENSES = frozenset({"OFL-1.1", "Apache-2.0"})
VALID_SPLITS = frozenset({"train", "validation", "test"})
VALID_CATEGORIES = frozenset(
    {
        "cross_script_bridge",
        "japanese_only",
        "korean_only",
        "cross_script_partial_excluded",
        "insufficient_script_coverage",
    }
)
SAFE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

SENTENCE_PAIRS: tuple[tuple[str, str, str], ...] = (
    ("p01", "これは本当です。", "이건 정말이야."),
    ("p02", "君を守りたい。", "너를 지키고 싶어."),
    ("p03", "静かに話して。", "조용히 말해 줘."),
    ("p04", "もう大丈夫だよ。", "이제 괜찮아."),
    ("p05", "世界が変わった。", "세상이 변했어."),
    ("p06", "私を信じて。", "나를 믿어 줘."),
    ("p07", "何が起きたの？", "무슨 일이 있었어?"),
    ("p08", "一緒に帰ろう。", "같이 돌아가자."),
)
JP_PROBE_TEXT = "".join(pair[1] for pair in SENTENCE_PAIRS)
KO_PROBE_TEXT = "".join(pair[2] for pair in SENTENCE_PAIRS)
JP_PROBE_CHARS = tuple(
    dict.fromkeys(character for character in JP_PROBE_TEXT if not character.isspace())
)
KO_PROBE_CHARS = tuple(
    dict.fromkeys(character for character in KO_PROBE_TEXT if not character.isspace())
)
MIN_SUPPORTED_SENTENCES = 2

EXPECTED_AUTHORITY = {
    "automatic_label_promotion_allowed": False,
    "calibration_eligible": False,
    "evaluation_eligible": False,
    "human_gold": False,
    "production_use_allowed": False,
    "training_eligible": True,
    "training_only": True,
}
EXPECTED_VISUAL_REVIEW_CONTRACT = {
    "candidate_count_per_image": 1,
    "contact_sheets_forbidden": True,
    "context": "clean_synthetic_cross_script_bridge",
    "image_unit": "one_japanese_sentence_vs_one_korean_candidate_sentence",
    "manual_or_ai_review_required_before_model_promotion": True,
}


class GlyphVoiceCorpusError(ValueError):
    """Raised when a font source or sealed corpus drifts."""


@dataclass(frozen=True)
class SourceFace:
    source_id: str
    family_id: str
    label: str
    locale_hint: str
    font_path: Path
    font_file: str
    font_sha256: str
    face_index: int
    license_id: str
    license_text_file: str
    license_text_sha256: str
    source_url: str

    @property
    def face_id(self) -> str:
        return f"{self.source_id}-face{self.face_index}"


@dataclass(frozen=True)
class GlyphEvidence:
    character: str
    codepoint: str
    glyph_name: str | None
    valid: bool
    rejection_reason: str | None
    outline_sha256: str | None
    raster_sha256: str | None
    raster_ink_pixels: int
    raster_size_px: tuple[int, int] | None

    def to_record(self) -> dict[str, Any]:
        return {
            "character": self.character,
            "codepoint": self.codepoint,
            "glyph_name": self.glyph_name,
            "outline_sha256": self.outline_sha256,
            "raster_ink_pixels": self.raster_ink_pixels,
            "raster_sha256": self.raster_sha256,
            "raster_size_px": list(self.raster_size_px)
            if self.raster_size_px
            else None,
            "rejection_reason": self.rejection_reason,
            "valid": self.valid,
        }


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    expected = record.get("record_sha256")
    if not isinstance(expected, str) or SHA256_RE.fullmatch(expected) is None:
        raise GlyphVoiceCorpusError(f"{location}: invalid record seal")
    body = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(body).encode("utf-8")) != expected:
        raise GlyphVoiceCorpusError(f"{location}: record seal drifted")


def _is_link_or_reparse(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _path_or_ancestor_is_link_or_reparse(path: Path) -> bool:
    return any(_is_link_or_reparse(value) for value in (path, *path.parents))


def _assert_regular_file(path: Path, location: str) -> None:
    if _path_or_ancestor_is_link_or_reparse(path.absolute()):
        raise GlyphVoiceCorpusError(f"{location}: linked/reparse path is forbidden")
    if not path.is_file() or path.stat().st_size < 1:
        raise GlyphVoiceCorpusError(f"{location}: missing regular file")


def _safe_id(value: Any, location: str) -> str:
    if not isinstance(value, str) or SAFE_ID_RE.fullmatch(value) is None:
        raise GlyphVoiceCorpusError(f"{location}: unsafe identifier")
    return value


def _safe_relative_path(value: Any, location: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise GlyphVoiceCorpusError(f"{location}: expected relative path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts or "." in relative.parts:
        raise GlyphVoiceCorpusError(f"{location}: unsafe relative path")
    if any("\\" in part or ":" in part or not part for part in relative.parts):
        raise GlyphVoiceCorpusError(f"{location}: unsafe relative path")
    return relative


def _resolve_repo_file(repo_root: Path, value: Any, location: str) -> Path:
    relative = _safe_relative_path(value, location)
    candidate = repo_root.joinpath(*relative.parts)
    _assert_regular_file(candidate, location)
    resolved_root = repo_root.resolve()
    resolved = candidate.resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise GlyphVoiceCorpusError(f"{location}: path escaped repository") from error
    return resolved


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    _assert_regular_file(path, location)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GlyphVoiceCorpusError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise GlyphVoiceCorpusError(f"{location}: expected object")
    return value


def _read_canonical_jsonl(path: Path, location: str) -> list[Mapping[str, Any]]:
    _assert_regular_file(path, location)
    payload = path.read_bytes()
    if payload and not payload.endswith(b"\n"):
        raise GlyphVoiceCorpusError(f"{location}: final newline required")
    result: list[Mapping[str, Any]] = []
    for index, raw in enumerate(payload.splitlines(), start=1):
        try:
            decoded = raw.decode("utf-8")
            value = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GlyphVoiceCorpusError(f"{location}:{index}: invalid JSON") from error
        if not isinstance(value, Mapping) or decoded != canonical_json(value):
            raise GlyphVoiceCorpusError(f"{location}:{index}: noncanonical JSONL")
        validate_record_seal(value, f"{location}:{index}")
        result.append(value)
    return result


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    payload = b"".join((canonical_json(row) + "\n").encode("utf-8") for row in rows)
    path.write_bytes(payload)


def _descriptor(
    path: Path, *, relative_to: Path, row_count: int | None = None
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.relative_to(relative_to).as_posix(),
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _producer_descriptor(repo_root: Path) -> dict[str, Any]:
    path = Path(__file__).resolve()
    try:
        relative = path.relative_to(repo_root.resolve()).as_posix()
    except ValueError as error:
        raise GlyphVoiceCorpusError("producer is outside repository") from error
    return {
        "byte_size": path.stat().st_size,
        "file": relative,
        "sha256": sha256_file(path),
    }


def _verify_producer(repo_root: Path, descriptor: Mapping[str, Any]) -> None:
    path = _resolve_repo_file(repo_root, descriptor.get("file"), "producer.file")
    if descriptor.get("byte_size") != path.stat().st_size or descriptor.get(
        "sha256"
    ) != sha256_file(path):
        raise GlyphVoiceCorpusError("producer binding drifted")


def _face_count(path: Path) -> int:
    if path.suffix.lower() not in {".ttc", ".otc"}:
        return 1
    collection = TTCollection(str(path), lazy=True)
    try:
        return len(collection.fonts)
    finally:
        collection.close()


@contextmanager
def _open_font(path: Path, face_index: int) -> Iterator[TTFont]:
    font = TTFont(str(path), fontNumber=face_index, lazy=False, recalcBBoxes=False)
    try:
        yield font
    finally:
        font.close()


def _font_name(font: TTFont, name_id: int) -> str | None:
    if "name" not in font:
        return None
    values: list[str] = []
    for record in font["name"].names:
        if record.nameID != name_id:
            continue
        try:
            text = record.toUnicode().strip()
        except Exception:  # pragma: no cover - corrupt third-party name records
            continue
        if text:
            values.append(text)
    return (
        sorted(set(values), key=lambda item: (len(item), item))[0] if values else None
    )


def _normalize_pen_value(value: Any) -> Any:
    if isinstance(value, tuple):
        return [_normalize_pen_value(item) for item in value]
    if isinstance(value, list):
        return [_normalize_pen_value(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise GlyphVoiceCorpusError("nonfinite glyph outline coordinate")
        return round(value, 6)
    return value


def _outline_sha(glyph_set: Any, glyph_name: str) -> tuple[str | None, int]:
    try:
        glyph = glyph_set[glyph_name]
        pen = DecomposingRecordingPen(glyph_set, skipMissingComponents=True)
        glyph.draw(pen)
    except Exception:
        return None, 0
    operations = _normalize_pen_value(pen.value)
    if not operations:
        return None, 0
    return sha256_bytes(canonical_json(operations).encode("utf-8")), len(operations)


def _render_single_glyph(
    path: Path, face_index: int, character: str, *, size: int = 144
) -> tuple[str | None, int, tuple[int, int] | None]:
    try:
        font = ImageFont.truetype(str(path), size=size, index=face_index)
        bbox = font.getbbox(character, stroke_width=0)
    except (OSError, ValueError):
        return None, 0, None
    width = max(1, bbox[2] - bbox[0])
    height = max(1, bbox[3] - bbox[1])
    if width <= 1 or height <= 1 or width > size * 4 or height > size * 4:
        return None, 0, None
    canvas = Image.new("L", (width + 24, height + 24), 0)
    draw = ImageDraw.Draw(canvas)
    draw.text((12 - bbox[0], 12 - bbox[1]), character, font=font, fill=255)
    ink_box = canvas.getbbox()
    if ink_box is None:
        canvas.close()
        return None, 0, None
    cropped = canvas.crop(ink_box)
    canvas.close()
    try:
        payload = bytes(cropped.getdata())
        ink = sum(1 for value in payload if value > 8)
        if ink < 4:
            return None, ink, cropped.size
        digest = sha256_bytes(
            cropped.width.to_bytes(4, "little")
            + cropped.height.to_bytes(4, "little")
            + payload
        )
        return digest, ink, cropped.size
    finally:
        cropped.close()


def inspect_glyphs(
    source: SourceFace, characters: Sequence[str]
) -> dict[str, GlyphEvidence]:
    with _open_font(source.font_path, source.face_index) as font:
        cmap = font.getBestCmap() or {}
        glyph_set = font.getGlyphSet()
        notdef_sha, _ = (
            _outline_sha(glyph_set, ".notdef") if ".notdef" in glyph_set else (None, 0)
        )
        result: dict[str, GlyphEvidence] = {}
        for character in characters:
            codepoint = ord(character)
            glyph_name = cmap.get(codepoint)
            reason: str | None = None
            outline_sha: str | None = None
            raster_sha: str | None = None
            ink = 0
            raster_size: tuple[int, int] | None = None
            if glyph_name is None:
                reason = "cmap_missing"
            elif glyph_name == ".notdef":
                reason = "cmap_maps_to_notdef"
            else:
                outline_sha, operation_count = _outline_sha(glyph_set, glyph_name)
                if outline_sha is None or operation_count == 0:
                    reason = "outline_empty_or_unreadable"
                elif notdef_sha is not None and outline_sha == notdef_sha:
                    reason = "outline_matches_notdef"
                else:
                    raster_sha, ink, raster_size = _render_single_glyph(
                        source.font_path, source.face_index, character
                    )
                    if raster_sha is None:
                        reason = "raster_blank_or_unreadable"
            result[character] = GlyphEvidence(
                character=character,
                codepoint=f"U+{codepoint:04X}",
                glyph_name=glyph_name,
                valid=reason is None,
                rejection_reason=reason,
                outline_sha256=outline_sha,
                raster_sha256=raster_sha,
                raster_ink_pixels=ink,
                raster_size_px=raster_size,
            )
        return result


def _sentence_supported(text: str, evidence: Mapping[str, GlyphEvidence]) -> bool:
    return all(
        character.isspace()
        or evidence.get(
            character,
            GlyphEvidence(
                character, "", None, False, "missing_probe", None, None, 0, None
            ),
        ).valid
        for character in text
    )


def _fit_font(
    path: Path, face_index: int, text: str, max_size: int, box: tuple[int, int]
) -> ImageFont.FreeTypeFont:
    low, high = 12, max_size
    selected = ImageFont.truetype(str(path), size=low, index=face_index)
    while low <= high:
        middle = (low + high) // 2
        candidate = ImageFont.truetype(str(path), size=middle, index=face_index)
        bbox = candidate.getbbox(text)
        if bbox[2] - bbox[0] <= box[0] and bbox[3] - bbox[1] <= box[1]:
            selected = candidate
            low = middle + 1
        else:
            high = middle - 1
    return selected


def _render_sentence_asset(
    source: SourceFace, text: str, destination: Path
) -> dict[str, Any]:
    canvas = Image.new("L", (768, 224), 255)
    draw = ImageDraw.Draw(canvas)
    font = _fit_font(source.font_path, source.face_index, text, 128, (704, 156))
    bbox = font.getbbox(text)
    x = 384 - (bbox[0] + bbox[2]) // 2
    y = 112 - (bbox[1] + bbox[3]) // 2
    draw.text((x, y), text, font=font, fill=0)
    if canvas.getextrema() == (255, 255):
        canvas.close()
        raise GlyphVoiceCorpusError(f"blank sentence render for {source.face_id}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)
    pixel_sha = sha256_bytes(bytes(canvas.getdata()))
    canvas.close()
    return {
        "byte_size": destination.stat().st_size,
        "file": destination.as_posix(),
        "mode": "L",
        "pixel_sha256": pixel_sha,
        "sha256": sha256_file(destination),
        "size_px": [768, 224],
    }


def _label_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "malgun.ttf",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
    )
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size=size)
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size=size)
    except OSError:  # pragma: no cover - minimal headless fallback
        return ImageFont.load_default()


def _render_review_asset(
    source: SourceFace,
    japanese: str,
    korean: str,
    destination: Path,
) -> dict[str, Any]:
    canvas = Image.new("RGB", (1600, 620), "white")
    draw = ImageDraw.Draw(canvas)
    label = _label_font(28)
    jp_font = _fit_font(source.font_path, source.face_index, japanese, 116, (1450, 150))
    ko_font = _fit_font(source.font_path, source.face_index, korean, 116, (1450, 150))
    draw.rounded_rectangle(
        (24, 24, 1576, 292), radius=20, outline=(40, 92, 158), width=4
    )
    draw.rounded_rectangle(
        (24, 328, 1576, 596), radius=20, outline=(184, 74, 59), width=4
    )
    draw.text((52, 42), f"일본어 원문 · {source.label}", font=label, fill=(40, 92, 158))
    draw.text(
        (52, 346),
        f"한국어 후보 · 같은 face {source.label}",
        font=label,
        fill=(184, 74, 59),
    )
    jp_box = jp_font.getbbox(japanese)
    ko_box = ko_font.getbbox(korean)
    draw.text(
        (70, 182 - (jp_box[1] + jp_box[3]) // 2), japanese, font=jp_font, fill="black"
    )
    draw.text(
        (70, 486 - (ko_box[1] + ko_box[3]) // 2), korean, font=ko_font, fill="black"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)
    pixel_sha = sha256_bytes(canvas.tobytes())
    canvas.close()
    return {
        "byte_size": destination.stat().st_size,
        "file": destination.as_posix(),
        "mode": "RGB",
        "pixel_sha256": pixel_sha,
        "sha256": sha256_file(destination),
        "size_px": [1600, 620],
    }


def _split_families(family_ids: Iterable[str], seed: str) -> dict[str, str]:
    unique = sorted(
        set(family_ids),
        key=lambda value: hashlib.sha256(f"{seed}\0{value}".encode()).hexdigest(),
    )
    count = len(unique)
    if count == 0:
        return {}
    if count == 1:
        counts = (1, 0, 0)
    elif count == 2:
        counts = (1, 1, 0)
    else:
        validation = max(1, round(count * 0.1))
        test = max(1, round(count * 0.1))
        while validation + test >= count:
            if test >= validation and test > 1:
                test -= 1
            elif validation > 1:
                validation -= 1
            else:
                break
        counts = (count - validation - test, validation, test)
    train, validation, _ = counts
    return {
        family_id: "train"
        if index < train
        else "validation"
        if index < train + validation
        else "test"
        for index, family_id in enumerate(unique)
    }


def _stratified_family_splits(
    inspected: Sequence[Mapping[str, Any]], seed: str
) -> tuple[dict[str, str], dict[str, str]]:
    """Split each supervision category while keeping every family indivisible."""

    family_categories: dict[str, set[str]] = defaultdict(set)
    eligible = {"cross_script_bridge", "japanese_only", "korean_only"}
    for entry in inspected:
        category = str(entry["category"])
        if category in eligible:
            source = entry["source"]
            assert isinstance(source, SourceFace)
            family_categories[source.family_id].add(category)
    family_strata: dict[str, str] = {}
    for family_id, categories in family_categories.items():
        if "cross_script_bridge" in categories:
            family_strata[family_id] = "cross_script_bridge"
        elif len(categories) == 1:
            family_strata[family_id] = next(iter(categories))
        else:
            # A family with separate JP-only and KO-only faces is still not an
            # exact bridge, but must stay together to prevent family leakage.
            family_strata[family_id] = "cross_script_partial_excluded"
    split_map: dict[str, str] = {}
    for stratum in sorted(set(family_strata.values())):
        families = [
            family_id
            for family_id, family_stratum in family_strata.items()
            if family_stratum == stratum
        ]
        split_map.update(_split_families(families, f"{seed}\0{stratum}"))
    return split_map, family_strata


def _face_signature(
    evidence: Mapping[str, GlyphEvidence], characters: Sequence[str]
) -> str:
    values = [
        [
            character,
            evidence[character].outline_sha256,
            evidence[character].raster_sha256,
        ]
        for character in characters
        if evidence[character].valid
    ]
    return sha256_bytes(canonical_json(values).encode("utf-8"))


def _read_source_manifest(
    source_manifest: Path, repo_root: Path
) -> tuple[Mapping[str, Any], list[SourceFace]]:
    document = _read_json(source_manifest, "source manifest")
    validate_record_seal(document, "source manifest")
    if (
        document.get("schema_version") != SOURCE_SCHEMA_VERSION
        or document.get("record_type") != SOURCE_RECORD_TYPE
    ):
        raise GlyphVoiceCorpusError("unsupported source manifest")
    producer = document.get("producer")
    if not isinstance(producer, Mapping):
        raise GlyphVoiceCorpusError("source manifest producer missing")
    _verify_producer(repo_root, producer)
    rows = document.get("sources")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)) or not rows:
        raise GlyphVoiceCorpusError("source manifest has no sources")
    result: list[SourceFace] = []
    identities: set[tuple[str, int]] = set()
    for index, raw in enumerate(rows):
        if not isinstance(raw, Mapping):
            raise GlyphVoiceCorpusError(f"source[{index}]: expected object")
        source_id = _safe_id(raw.get("source_id"), f"source[{index}].source_id")
        family_id = _safe_id(raw.get("family_id"), f"source[{index}].family_id")
        font_path = _resolve_repo_file(
            repo_root, raw.get("font_file"), f"source[{index}].font_file"
        )
        face_index = raw.get("face_index")
        if (
            isinstance(face_index, bool)
            or not isinstance(face_index, int)
            or face_index < 0
            or face_index >= _face_count(font_path)
        ):
            raise GlyphVoiceCorpusError(f"source[{index}].face_index invalid")
        if (source_id, face_index) in identities:
            raise GlyphVoiceCorpusError("duplicate source face identity")
        identities.add((source_id, face_index))
        expected_font_sha = raw.get("font_sha256")
        if expected_font_sha != sha256_file(font_path):
            raise GlyphVoiceCorpusError(f"source[{index}]: font hash drifted")
        license_record = raw.get("license")
        if not isinstance(license_record, Mapping):
            raise GlyphVoiceCorpusError(f"source[{index}]: license missing")
        license_id = license_record.get("id")
        if (
            license_id not in ALLOWED_LICENSES
            or license_record.get("training_allowed") is not True
        ):
            raise GlyphVoiceCorpusError(
                f"source[{index}]: license is not training-allowed"
            )
        license_path = _resolve_repo_file(
            repo_root,
            license_record.get("text_file"),
            f"source[{index}].license.text_file",
        )
        license_sha = license_record.get("text_sha256")
        if license_sha != sha256_file(license_path):
            raise GlyphVoiceCorpusError(f"source[{index}]: license hash drifted")
        label = raw.get("label")
        locale_hint = raw.get("locale_hint")
        source_url = license_record.get("source_url")
        if not all(
            isinstance(value, str) and value
            for value in (label, locale_hint, source_url)
        ):
            raise GlyphVoiceCorpusError(f"source[{index}]: text metadata invalid")
        result.append(
            SourceFace(
                source_id=source_id,
                family_id=family_id,
                label=label,
                locale_hint=locale_hint,
                font_path=font_path,
                font_file=str(raw["font_file"]),
                font_sha256=expected_font_sha,
                face_index=face_index,
                license_id=license_id,
                license_text_file=str(license_record["text_file"]),
                license_text_sha256=license_sha,
                source_url=source_url,
            )
        )
    if len({(row.font_sha256, row.face_index) for row in result}) != len(result):
        raise GlyphVoiceCorpusError("duplicate physical font face")
    return document, sorted(result, key=lambda item: item.face_id)


def _third_party_sources(repo_root: Path) -> list[dict[str, Any]]:
    manifest_path = repo_root / "third_party" / "fonts" / "manifest.json"
    document = _read_json(manifest_path, "third-party font manifest")
    rows: list[dict[str, Any]] = []

    def license_for(font_id: str, declared: str | None = None) -> dict[str, Any]:
        license_dir = repo_root / "third_party" / "fonts" / font_id
        candidates = [license_dir / "OFL.txt", license_dir / "LICENSE.txt"]
        matches = [path for path in candidates if path.is_file()]
        if len(matches) != 1:
            raise GlyphVoiceCorpusError(f"{font_id}: expected exactly one license file")
        path = matches[0]
        license_id = declared or ("OFL-1.1" if path.name == "OFL.txt" else "Apache-2.0")
        if license_id not in ALLOWED_LICENSES:
            raise GlyphVoiceCorpusError(f"{font_id}: unsupported license")
        return {
            "id": license_id,
            "source_url": "third_party/fonts/README.md",
            "text_file": path.relative_to(repo_root).as_posix(),
            "text_sha256": sha256_file(path),
            "training_allowed": True,
        }

    for entry in document.get("fonts", []):
        if not isinstance(entry, Mapping):
            raise GlyphVoiceCorpusError("third-party generic font row invalid")
        font_id = _safe_id(entry.get("id"), "third-party font id")
        font_file = str(entry.get("file"))
        font_path = _resolve_repo_file(
            repo_root, font_file, f"third-party[{font_id}].file"
        )
        if entry.get("sha256") != sha256_file(font_path):
            raise GlyphVoiceCorpusError(f"{font_id}: third-party hash drifted")
        for face_index in range(_face_count(font_path)):
            rows.append(
                {
                    "face_index": face_index,
                    "family_id": font_id,
                    "font_file": font_file,
                    "font_sha256": sha256_file(font_path),
                    "label": str(entry.get("family")),
                    "license": license_for(font_id),
                    "locale_hint": str(entry.get("locale")),
                    "source_id": font_id
                    if face_index == 0
                    else f"{font_id}-{face_index}",
                }
            )
    for entry in document.get("koreanFonts", []):
        if not isinstance(entry, Mapping):
            raise GlyphVoiceCorpusError("third-party Korean font row invalid")
        font_id = _safe_id(entry.get("id"), "third-party Korean font id")
        faces = list(entry.get("faces", [])) + list(
            entry.get("additionalBundledFaces", [])
        )
        for order, face in enumerate(faces):
            if not isinstance(face, Mapping):
                raise GlyphVoiceCorpusError(f"{font_id}: invalid face")
            font_file = str(face.get("file"))
            font_path = _resolve_repo_file(
                repo_root, font_file, f"third-party[{font_id}].face"
            )
            if face.get("sha256") != sha256_file(font_path):
                raise GlyphVoiceCorpusError(f"{font_id}: face hash drifted")
            for face_index in range(_face_count(font_path)):
                suffix = f"-{order}" if len(faces) > 1 else ""
                rows.append(
                    {
                        "face_index": face_index,
                        "family_id": font_id,
                        "font_file": font_file,
                        "font_sha256": sha256_file(font_path),
                        "label": str(entry.get("family")),
                        "license": license_for(font_id, str(entry.get("license"))),
                        "locale_hint": "ko",
                        "source_id": f"{font_id}{suffix}"
                        if face_index == 0
                        else f"{font_id}{suffix}-{face_index}",
                    }
                )
    return sorted(
        rows, key=lambda row: (row["family_id"], row["source_id"], row["face_index"])
    )


def inventory_third_party(*, output: Path, repo_root: Path) -> Mapping[str, Any]:
    target = output.expanduser().absolute()
    if target.exists() or _is_link_or_reparse(target):
        raise GlyphVoiceCorpusError("source manifest output already exists")
    if _path_or_ancestor_is_link_or_reparse(target.parent):
        raise GlyphVoiceCorpusError("source manifest output parent is linked")
    target.parent.mkdir(parents=True, exist_ok=True)
    third_party_manifest = repo_root / "third_party" / "fonts" / "manifest.json"
    notice = repo_root / "third_party" / "fonts" / "README.md"
    sources = _third_party_sources(repo_root)
    record = seal_record(
        {
            "authority": EXPECTED_AUTHORITY,
            "counts": {
                "family_count": len({row["family_id"] for row in sources}),
                "face_count": len(sources),
            },
            "inputs": {
                "notice": _descriptor(notice, relative_to=repo_root),
                "third_party_manifest": _descriptor(
                    third_party_manifest, relative_to=repo_root
                ),
            },
            "producer": _producer_descriptor(repo_root),
            "record_type": SOURCE_RECORD_TYPE,
            "schema_version": SOURCE_SCHEMA_VERSION,
            "sources": sources,
        }
    )
    target.write_bytes(json_bytes(record, pretty=True))
    return {"face_count": len(sources), "output": str(target), "status": "built"}


def _classify_face(jp_supported: Sequence[str], ko_supported: Sequence[str]) -> str:
    jp_ok = len(jp_supported) >= MIN_SUPPORTED_SENTENCES
    ko_ok = len(ko_supported) >= MIN_SUPPORTED_SENTENCES
    if jp_ok and ko_ok:
        paired = set(jp_supported) & set(ko_supported)
        return (
            "cross_script_bridge"
            if len(paired) >= MIN_SUPPORTED_SENTENCES
            else "cross_script_partial_excluded"
        )
    if jp_ok:
        return "japanese_only"
    if ko_ok:
        return "korean_only"
    return "insufficient_script_coverage"


def build_corpus(
    *, source_manifest: Path, output_dir: Path, repo_root: Path, split_seed: str
) -> Mapping[str, Any]:
    source_document, sources = _read_source_manifest(source_manifest, repo_root)
    target = output_dir.expanduser().absolute()
    if target.exists() or _is_link_or_reparse(target):
        raise GlyphVoiceCorpusError("output directory already exists")
    if _path_or_ancestor_is_link_or_reparse(target.parent):
        raise GlyphVoiceCorpusError("output parent is linked")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        (staging / ASSET_DIR).mkdir()
        inspected: list[dict[str, Any]] = []
        all_chars = tuple(dict.fromkeys((*JP_PROBE_CHARS, *KO_PROBE_CHARS)))
        for source in sources:
            evidence = inspect_glyphs(source, all_chars)
            jp_supported = [
                pair_id
                for pair_id, jp, _ in SENTENCE_PAIRS
                if _sentence_supported(jp, evidence)
            ]
            ko_supported = [
                pair_id
                for pair_id, _, ko in SENTENCE_PAIRS
                if _sentence_supported(ko, evidence)
            ]
            category = _classify_face(jp_supported, ko_supported)
            with _open_font(source.font_path, source.face_index) as font:
                names = {
                    "family": _font_name(font, 1),
                    "subfamily": _font_name(font, 2),
                    "full": _font_name(font, 4),
                    "postscript": _font_name(font, 6),
                }
                axes = []
                if "fvar" in font:
                    axes = [
                        {
                            "axis": axis.axisTag,
                            "default": float(axis.defaultValue),
                            "maximum": float(axis.maxValue),
                            "minimum": float(axis.minValue),
                        }
                        for axis in font["fvar"].axes
                    ]
            inspected.append(
                {
                    "category": category,
                    "evidence": evidence,
                    "jp_supported": jp_supported,
                    "ko_supported": ko_supported,
                    "metadata": {"names": names, "variable_axes": axes},
                    "source": source,
                }
            )

        split_map, family_strata = _stratified_family_splits(inspected, split_seed)
        full_signatures: dict[str, list[str]] = defaultdict(list)
        for entry in inspected:
            if entry["category"] == "cross_script_bridge":
                evidence = entry["evidence"]
                signature = _face_signature(evidence, all_chars)
                entry["bridge_signature_sha256"] = signature
                full_signatures[signature].append(entry["source"].face_id)

        face_rows: list[dict[str, Any]] = []
        sample_rows: list[dict[str, Any]] = []
        pair_rows: list[dict[str, Any]] = []
        asset_paths: list[Path] = []
        sample_by_key: dict[tuple[str, str, str], Mapping[str, Any]] = {}

        for entry in inspected:
            source: SourceFace = entry["source"]
            evidence: Mapping[str, GlyphEvidence] = entry["evidence"]
            category = entry["category"]
            split = split_map.get(source.family_id)
            duplicate_faces = sorted(
                full_signatures.get(entry.get("bridge_signature_sha256", ""), [])
            )
            deduplicated_bridge = (
                category == "cross_script_bridge"
                and duplicate_faces
                and source.face_id != duplicate_faces[0]
            )
            effective_category = (
                "cross_script_partial_excluded" if deduplicated_bridge else category
            )
            face_core = {
                "authority": EXPECTED_AUTHORITY,
                "bridge_duplicate_of": duplicate_faces[0]
                if deduplicated_bridge
                else None,
                "bridge_signature_sha256": entry.get("bridge_signature_sha256"),
                "category": effective_category,
                "face_id": source.face_id,
                "family_id": source.family_id,
                "font": {
                    "byte_size": source.font_path.stat().st_size,
                    "face_index": source.face_index,
                    "file": source.font_file,
                    "sha256": source.font_sha256,
                },
                "glyph_evidence": {
                    "japanese": [
                        evidence[character].to_record() for character in JP_PROBE_CHARS
                    ],
                    "korean": [
                        evidence[character].to_record() for character in KO_PROBE_CHARS
                    ],
                },
                "label": source.label,
                "license": {
                    "id": source.license_id,
                    "source_url": source.source_url,
                    "text_file": source.license_text_file,
                    "text_sha256": source.license_text_sha256,
                    "training_allowed": True,
                },
                "locale_hint": source.locale_hint,
                "metadata": entry["metadata"],
                "record_type": FACE_RECORD_TYPE,
                "schema_version": CORPUS_SCHEMA_VERSION,
                "sentence_support": {
                    "japanese_pair_ids": entry["jp_supported"],
                    "korean_pair_ids": entry["ko_supported"],
                },
                "source_id": source.source_id,
                "split": split,
            }
            face_rows.append(seal_record(face_core))

            if effective_category not in {
                "cross_script_bridge",
                "japanese_only",
                "korean_only",
            }:
                continue
            for pair_id, japanese, korean in SENTENCE_PAIRS:
                for script, text, supported in (
                    ("japanese", japanese, pair_id in entry["jp_supported"]),
                    ("korean", korean, pair_id in entry["ko_supported"]),
                ):
                    if not supported:
                        continue
                    sample_id = f"{source.face_id}-{pair_id}-{script}"
                    relative_asset = (
                        PurePosixPath(ASSET_DIR) / "sentences" / f"{sample_id}.png"
                    )
                    absolute_asset = staging.joinpath(*relative_asset.parts)
                    descriptor = _render_sentence_asset(source, text, absolute_asset)
                    descriptor["file"] = relative_asset.as_posix()
                    asset_paths.append(absolute_asset)
                    row = seal_record(
                        {
                            "asset": descriptor,
                            "authority": EXPECTED_AUTHORITY,
                            "category": effective_category,
                            "face_id": source.face_id,
                            "family_id": source.family_id,
                            "pair_id": pair_id,
                            "record_type": SAMPLE_RECORD_TYPE,
                            "sample_id": sample_id,
                            "schema_version": CORPUS_SCHEMA_VERSION,
                            "script": script,
                            "split": split,
                            "text": text,
                        }
                    )
                    sample_rows.append(row)
                    sample_by_key[(source.face_id, pair_id, script)] = row

            if effective_category == "cross_script_bridge":
                for pair_id, japanese, korean in SENTENCE_PAIRS:
                    jp_key = (source.face_id, pair_id, "japanese")
                    ko_key = (source.face_id, pair_id, "korean")
                    if jp_key not in sample_by_key or ko_key not in sample_by_key:
                        continue
                    bridge_id = f"{source.face_id}-{pair_id}"
                    relative_review = (
                        PurePosixPath(ASSET_DIR) / "reviews" / f"{bridge_id}.png"
                    )
                    absolute_review = staging.joinpath(*relative_review.parts)
                    review = _render_review_asset(
                        source, japanese, korean, absolute_review
                    )
                    review["file"] = relative_review.as_posix()
                    asset_paths.append(absolute_review)
                    pair_rows.append(
                        seal_record(
                            {
                                "authority": EXPECTED_AUTHORITY,
                                "bridge_id": bridge_id,
                                "candidate": {
                                    "record_sha256": sample_by_key[ko_key][
                                        "record_sha256"
                                    ],
                                    "sample_id": sample_by_key[ko_key]["sample_id"],
                                    "text": korean,
                                },
                                "exact_same_physical_face": True,
                                "face_id": source.face_id,
                                "family_id": source.family_id,
                                "pair_id": pair_id,
                                "record_type": PAIR_RECORD_TYPE,
                                "review_asset": review,
                                "schema_version": CORPUS_SCHEMA_VERSION,
                                "source": {
                                    "record_sha256": sample_by_key[jp_key][
                                        "record_sha256"
                                    ],
                                    "sample_id": sample_by_key[jp_key]["sample_id"],
                                    "text": japanese,
                                },
                                "split": split,
                                "visual_review_contract": EXPECTED_VISUAL_REVIEW_CONTRACT,
                            }
                        )
                    )

        face_rows.sort(key=lambda row: str(row["face_id"]))
        sample_rows.sort(key=lambda row: str(row["sample_id"]))
        pair_rows.sort(key=lambda row: str(row["bridge_id"]))
        _write_jsonl(staging / FACES_FILE, face_rows)
        _write_jsonl(staging / SAMPLES_FILE, sample_rows)
        _write_jsonl(staging / PAIRS_FILE, pair_rows)

        asset_inventory = [
            _descriptor(path, relative_to=staging)
            for path in sorted(
                asset_paths, key=lambda value: value.relative_to(staging).as_posix()
            )
        ]
        category_counts = Counter(str(row["category"]) for row in face_rows)
        split_counts = Counter(
            str(row["split"]) for row in face_rows if row["split"] is not None
        )
        manifest = seal_record(
            {
                "artifacts": {
                    FACES_FILE: _descriptor(
                        staging / FACES_FILE,
                        relative_to=staging,
                        row_count=len(face_rows),
                    ),
                    PAIRS_FILE: _descriptor(
                        staging / PAIRS_FILE,
                        relative_to=staging,
                        row_count=len(pair_rows),
                    ),
                    SAMPLES_FILE: _descriptor(
                        staging / SAMPLES_FILE,
                        relative_to=staging,
                        row_count=len(sample_rows),
                    ),
                    "asset_inventory": asset_inventory,
                    "asset_inventory_sha256": sha256_bytes(
                        canonical_json(asset_inventory).encode("utf-8")
                    ),
                },
                "authority": EXPECTED_AUTHORITY,
                "counts": {
                    "asset_count": len(asset_inventory),
                    "bridge_pair_count": len(pair_rows),
                    "category_face_counts": dict(sorted(category_counts.items())),
                    "face_count": len(face_rows),
                    "family_count": len({row["family_id"] for row in face_rows}),
                    "sentence_sample_count": len(sample_rows),
                    "split_face_counts": dict(sorted(split_counts.items())),
                },
                "glyph_validation": {
                    "cmap_only_is_sufficient": False,
                    "notdef_outline_rejected": True,
                    "outline_required": True,
                    "probe_pair_ids": [pair[0] for pair in SENTENCE_PAIRS],
                    "raster_nonempty_required": True,
                    "same_face_bridge_only": True,
                },
                "producer": _producer_descriptor(repo_root),
                "record_type": MANIFEST_RECORD_TYPE,
                "schema_version": CORPUS_SCHEMA_VERSION,
                "source_manifest": {
                    "file": source_manifest.resolve()
                    .relative_to(repo_root.resolve())
                    .as_posix(),
                    "record_sha256": source_document["record_sha256"],
                    "sha256": sha256_file(source_manifest),
                },
                "split": {
                    "family_disjoint": True,
                    "family_strata": dict(sorted(family_strata.items())),
                    "seed": split_seed,
                    "stratified_by_supervision_category": True,
                    "values": sorted(VALID_SPLITS),
                },
                "visual_review_contract": EXPECTED_VISUAL_REVIEW_CONTRACT,
            }
        )
        (staging / MANIFEST_FILE).write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "artifacts": {
                    FACES_FILE: sha256_file(staging / FACES_FILE),
                    MANIFEST_FILE: sha256_file(staging / MANIFEST_FILE),
                    PAIRS_FILE: sha256_file(staging / PAIRS_FILE),
                    SAMPLES_FILE: sha256_file(staging / SAMPLES_FILE),
                },
                "counts": manifest["counts"],
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": REPORT_RECORD_TYPE,
                "schema_version": CORPUS_SCHEMA_VERSION,
                "status": "built_training_only_glyph_verified_corpus",
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    FACES_FILE: sha256_file(staging / FACES_FILE),
                    MANIFEST_FILE: sha256_file(staging / MANIFEST_FILE),
                    PAIRS_FILE: sha256_file(staging / PAIRS_FILE),
                    REPORT_FILE: sha256_file(staging / REPORT_FILE),
                    SAMPLES_FILE: sha256_file(staging / SAMPLES_FILE),
                    "asset_inventory_sha256": manifest["artifacts"][
                        "asset_inventory_sha256"
                    ],
                },
                "owner": OWNER,
                "safe_replace": False,
                "schema_version": CORPUS_SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        staging.rename(target)
        return validate_corpus(target, repo_root=repo_root)
    except BaseException:
        if staging.exists() and not _is_link_or_reparse(staging):
            shutil.rmtree(staging)
        raise


def _verify_artifact(root: Path, descriptor: Mapping[str, Any], location: str) -> Path:
    relative = _safe_relative_path(descriptor.get("file"), f"{location}.file")
    path = root.joinpath(*relative.parts)
    _assert_regular_file(path, location)
    if descriptor.get("byte_size") != path.stat().st_size or descriptor.get(
        "sha256"
    ) != sha256_file(path):
        raise GlyphVoiceCorpusError(f"{location}: descriptor drifted")
    return path


def validate_corpus(output_dir: Path, *, repo_root: Path) -> Mapping[str, Any]:
    expanded = output_dir.expanduser().absolute()
    if _path_or_ancestor_is_link_or_reparse(expanded):
        raise GlyphVoiceCorpusError("output directory is linked")
    root = expanded.resolve()
    if not root.is_dir() or {path.name for path in root.iterdir()} != ROOT_INVENTORY:
        raise GlyphVoiceCorpusError("output root inventory drifted")
    for child in root.rglob("*"):
        if _is_link_or_reparse(child):
            raise GlyphVoiceCorpusError("output contains linked/reparse content")
    marker = _read_json(root / MARKER_FILE, "marker")
    manifest = _read_json(root / MANIFEST_FILE, "manifest")
    report = _read_json(root / REPORT_FILE, "report")
    for record, location in (
        (marker, "marker"),
        (manifest, "manifest"),
        (report, "report"),
    ):
        validate_record_seal(record, location)
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not False
        or marker.get("schema_version") != CORPUS_SCHEMA_VERSION
    ):
        raise GlyphVoiceCorpusError("marker contract drifted")
    if (
        manifest.get("schema_version") != CORPUS_SCHEMA_VERSION
        or manifest.get("record_type") != MANIFEST_RECORD_TYPE
    ):
        raise GlyphVoiceCorpusError("manifest contract drifted")
    if report.get("record_type") != REPORT_RECORD_TYPE or report.get(
        "manifest_record_sha256"
    ) != manifest.get("record_sha256"):
        raise GlyphVoiceCorpusError("report binding drifted")
    if (
        manifest.get("authority") != EXPECTED_AUTHORITY
        or manifest.get("visual_review_contract") != EXPECTED_VISUAL_REVIEW_CONTRACT
    ):
        raise GlyphVoiceCorpusError("authority or review contract drifted")
    producer = manifest.get("producer")
    if not isinstance(producer, Mapping):
        raise GlyphVoiceCorpusError("producer missing")
    _verify_producer(repo_root, producer)
    source_binding = manifest.get("source_manifest")
    if not isinstance(source_binding, Mapping):
        raise GlyphVoiceCorpusError("source manifest binding missing")
    source_path = _resolve_repo_file(
        repo_root, source_binding.get("file"), "source_manifest.file"
    )
    source_document, _ = _read_source_manifest(source_path, repo_root)
    if source_binding.get("sha256") != sha256_file(source_path) or source_binding.get(
        "record_sha256"
    ) != source_document.get("record_sha256"):
        raise GlyphVoiceCorpusError("source manifest binding drifted")
    faces = _read_canonical_jsonl(root / FACES_FILE, "faces")
    samples = _read_canonical_jsonl(root / SAMPLES_FILE, "samples")
    pairs = _read_canonical_jsonl(root / PAIRS_FILE, "pairs")
    if any(
        row.get("record_type") != FACE_RECORD_TYPE
        or row.get("schema_version") != CORPUS_SCHEMA_VERSION
        for row in faces
    ):
        raise GlyphVoiceCorpusError("face row contract drifted")
    if any(
        row.get("record_type") != SAMPLE_RECORD_TYPE
        or row.get("schema_version") != CORPUS_SCHEMA_VERSION
        for row in samples
    ):
        raise GlyphVoiceCorpusError("sample row contract drifted")
    if any(
        row.get("record_type") != PAIR_RECORD_TYPE
        or row.get("schema_version") != CORPUS_SCHEMA_VERSION
        for row in pairs
    ):
        raise GlyphVoiceCorpusError("pair row contract drifted")
    family_splits: dict[str, set[str]] = defaultdict(set)
    family_categories: dict[str, set[str]] = defaultdict(set)
    face_ids: set[str] = set()
    for row in faces:
        face_id = _safe_id(row.get("face_id"), "face.face_id")
        if face_id in face_ids or row.get("category") not in VALID_CATEGORIES:
            raise GlyphVoiceCorpusError("face identity/category drifted")
        face_ids.add(face_id)
        split = row.get("split")
        category = str(row.get("category"))
        family_id = str(row.get("family_id"))
        if category in {"cross_script_bridge", "japanese_only", "korean_only"}:
            family_categories[family_id].add(category)
        if split is not None:
            if split not in VALID_SPLITS:
                raise GlyphVoiceCorpusError("face split drifted")
            family_splits[family_id].add(str(split))
    if any(len(values) != 1 for values in family_splits.values()):
        raise GlyphVoiceCorpusError("font family leaked across splits")
    expected_family_strata: dict[str, str] = {}
    for family_id, categories in family_categories.items():
        if "cross_script_bridge" in categories:
            expected_family_strata[family_id] = "cross_script_bridge"
        elif len(categories) == 1:
            expected_family_strata[family_id] = next(iter(categories))
        else:
            expected_family_strata[family_id] = "cross_script_partial_excluded"
    split_contract = manifest.get("split")
    if (
        not isinstance(split_contract, Mapping)
        or split_contract.get("family_disjoint") is not True
        or split_contract.get("stratified_by_supervision_category") is not True
        or split_contract.get("values") != sorted(VALID_SPLITS)
        or split_contract.get("family_strata")
        != dict(sorted(expected_family_strata.items()))
    ):
        raise GlyphVoiceCorpusError("family split contract drifted")
    for stratum in sorted(set(expected_family_strata.values())):
        families = [
            family_id
            for family_id, value in expected_family_strata.items()
            if value == stratum
        ]
        actual_splits = {next(iter(family_splits[family_id])) for family_id in families}
        if len(families) >= 3 and actual_splits != VALID_SPLITS:
            raise GlyphVoiceCorpusError(
                f"supervision stratum lacks train/validation/test: {stratum}"
            )
    sample_by_id = {str(row.get("sample_id")): row for row in samples}
    if len(sample_by_id) != len(samples):
        raise GlyphVoiceCorpusError("duplicate sample id")
    expected_asset_paths: set[str] = set()
    for row in samples:
        asset = row.get("asset")
        if not isinstance(asset, Mapping):
            raise GlyphVoiceCorpusError("sample asset missing")
        path = _verify_artifact(root, asset, "sample.asset")
        expected_asset_paths.add(path.relative_to(root).as_posix())
    bridge_ids: set[str] = set()
    for row in pairs:
        bridge_id = _safe_id(row.get("bridge_id"), "pair.bridge_id")
        if (
            bridge_id in bridge_ids
            or row.get("exact_same_physical_face") is not True
            or row.get("visual_review_contract") != EXPECTED_VISUAL_REVIEW_CONTRACT
        ):
            raise GlyphVoiceCorpusError("bridge pair contract drifted")
        bridge_ids.add(bridge_id)
        source = row.get("source")
        candidate = row.get("candidate")
        if not isinstance(source, Mapping) or not isinstance(candidate, Mapping):
            raise GlyphVoiceCorpusError("bridge sample binding missing")
        source_row = sample_by_id.get(str(source.get("sample_id")))
        candidate_row = sample_by_id.get(str(candidate.get("sample_id")))
        if (
            source_row is None
            or candidate_row is None
            or source_row.get("script") != "japanese"
            or candidate_row.get("script") != "korean"
        ):
            raise GlyphVoiceCorpusError("bridge language binding drifted")
        if source.get("record_sha256") != source_row.get(
            "record_sha256"
        ) or candidate.get("record_sha256") != candidate_row.get("record_sha256"):
            raise GlyphVoiceCorpusError("bridge sample seal binding drifted")
        if source_row.get("face_id") != candidate_row.get("face_id") or source_row.get(
            "face_id"
        ) != row.get("face_id"):
            raise GlyphVoiceCorpusError("bridge is not the same physical face")
        review = row.get("review_asset")
        if not isinstance(review, Mapping):
            raise GlyphVoiceCorpusError("review asset missing")
        path = _verify_artifact(root, review, "pair.review_asset")
        expected_asset_paths.add(path.relative_to(root).as_posix())
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, Mapping):
        raise GlyphVoiceCorpusError("manifest artifacts missing")
    for filename, rows in (
        (FACES_FILE, faces),
        (SAMPLES_FILE, samples),
        (PAIRS_FILE, pairs),
    ):
        descriptor = artifacts.get(filename)
        if not isinstance(descriptor, Mapping):
            raise GlyphVoiceCorpusError(f"manifest descriptor missing: {filename}")
        path = _verify_artifact(root, descriptor, f"manifest.{filename}")
        if descriptor.get("row_count") != len(rows) or path.name != filename:
            raise GlyphVoiceCorpusError(f"manifest row count drifted: {filename}")
    asset_inventory = artifacts.get("asset_inventory")
    if not isinstance(asset_inventory, Sequence) or isinstance(
        asset_inventory, (str, bytes)
    ):
        raise GlyphVoiceCorpusError("asset inventory missing")
    inventory_paths: set[str] = set()
    for descriptor in asset_inventory:
        if not isinstance(descriptor, Mapping):
            raise GlyphVoiceCorpusError("asset inventory row invalid")
        path = _verify_artifact(root, descriptor, "asset_inventory")
        inventory_paths.add(path.relative_to(root).as_posix())
    physical_assets = {
        path.relative_to(root).as_posix()
        for path in (root / ASSET_DIR).rglob("*")
        if path.is_file()
    }
    if (
        inventory_paths != expected_asset_paths
        or physical_assets != expected_asset_paths
    ):
        raise GlyphVoiceCorpusError("asset inventory drifted")
    if artifacts.get("asset_inventory_sha256") != sha256_bytes(
        canonical_json(list(asset_inventory)).encode("utf-8")
    ):
        raise GlyphVoiceCorpusError("asset inventory seal drifted")
    counts = manifest.get("counts")
    if (
        not isinstance(counts, Mapping)
        or counts.get("face_count") != len(faces)
        or counts.get("sentence_sample_count") != len(samples)
        or counts.get("bridge_pair_count") != len(pairs)
        or counts.get("asset_count") != len(expected_asset_paths)
    ):
        raise GlyphVoiceCorpusError("manifest counts drifted")
    marker_artifacts = marker.get("artifacts")
    if not isinstance(marker_artifacts, Mapping):
        raise GlyphVoiceCorpusError("marker artifacts missing")
    expected_marker = {
        FACES_FILE: sha256_file(root / FACES_FILE),
        MANIFEST_FILE: sha256_file(root / MANIFEST_FILE),
        PAIRS_FILE: sha256_file(root / PAIRS_FILE),
        REPORT_FILE: sha256_file(root / REPORT_FILE),
        SAMPLES_FILE: sha256_file(root / SAMPLES_FILE),
        "asset_inventory_sha256": artifacts["asset_inventory_sha256"],
    }
    if dict(marker_artifacts) != expected_marker:
        raise GlyphVoiceCorpusError("marker binding drifted")
    return {
        "asset_count": len(expected_asset_paths),
        "bridge_pair_count": len(pairs),
        "face_count": len(faces),
        "family_count": len({row["family_id"] for row in faces}),
        "sentence_sample_count": len(samples),
        "status": "validated_training_only_glyph_verified_corpus",
    }


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory = subparsers.add_parser(
        "inventory-third-party", help="seal the repository OFL/Apache font inventory"
    )
    inventory.add_argument("--output", type=Path, required=True)
    build = subparsers.add_parser(
        "build", help="build glyph-verified sentence assets and 1:1 reviews"
    )
    build.add_argument("--source-manifest", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--split-seed", default="20260821")
    validate = subparsers.add_parser(
        "validate", help="strictly validate an existing corpus"
    )
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = _default_repo_root()
    if args.command == "inventory-third-party":
        result = inventory_third_party(output=args.output, repo_root=repo_root)
    elif args.command == "build":
        result = build_corpus(
            source_manifest=args.source_manifest,
            output_dir=args.output_dir,
            repo_root=repo_root,
            split_seed=args.split_seed,
        )
    else:
        result = validate_corpus(args.output_dir, repo_root=repo_root)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
