#!/usr/bin/env python3
"""Download and seal an open-font source pack for MangaFont GlyphVoice.

The pack contains one representative face from every current open Japanese
and Korean Google Fonts family, plus the full Korean-language OTF weight sets
of Noto Sans/Serif CJK.  Google Fonts families are monolingual evidence unless
the downstream glyph validator proves otherwise.  Noto CJK files are merely
bridge *candidates* until the same validator verifies every sentence glyph.

All upstream commits, metadata, license texts, font bytes, and source rows are
sealed.  Existing repository fonts can be merged from a previously generated
GlyphVoice source manifest.  No font is paired across scripts in this step.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath
from typing import Any

import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


SOURCE_SCHEMA_VERSION = "manga-font-glyphvoice-font-sources-v1"
PACK_SCHEMA_VERSION = "manga-font-glyphvoice-ofl-source-pack-v2"
SOURCE_RECORD_TYPE = "manga_font_glyphvoice_font_sources"
REPORT_RECORD_TYPE = "manga_font_glyphvoice_ofl_source_pack_report"
OWNER = "carrot-manga-translator/manga-font-glyphvoice-ofl-source-pack-v2"
SOURCE_FILE = "source-manifest.json"
REPORT_FILE = "report.json"
MARKER_FILE = ".manga-font-glyphvoice-ofl-source-pack-v2-owned.json"
UPSTREAM_DIR = "upstream"
ROOT_INVENTORY = frozenset({SOURCE_FILE, REPORT_FILE, MARKER_FILE, UPSTREAM_DIR})
GOOGLE_METADATA_URL = "https://fonts.google.com/metadata/fonts"
GOOGLE_REPOSITORY = "google/fonts"
NOTO_REPOSITORY = "notofonts/noto-cjk"
GOOGLE_RAW = "https://raw.githubusercontent.com/google/fonts/{commit}/{path}"
NOTO_RAW = "https://raw.githubusercontent.com/notofonts/noto-cjk/{commit}/{path}"
GITHUB_COMMIT_API = "https://api.github.com/repos/{repository}/commits/main"
SAFE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_LICENSES = {"OFL": "OFL-1.1", "APACHE2": "Apache-2.0"}
NOTO_FONTS: tuple[tuple[str, str, str], ...] = (
    (
        "noto-sans-cjk-kr-thin",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-Thin.otf",
    ),
    (
        "noto-sans-cjk-kr-light",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-Light.otf",
    ),
    (
        "noto-sans-cjk-kr-demilight",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-DemiLight.otf",
    ),
    (
        "noto-sans-cjk-kr-regular",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-Regular.otf",
    ),
    (
        "noto-sans-cjk-kr-medium",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-Medium.otf",
    ),
    (
        "noto-sans-cjk-kr-bold",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-Bold.otf",
    ),
    (
        "noto-sans-cjk-kr-black",
        "noto-sans-cjk-kr",
        "Sans/OTF/Korean/NotoSansCJKkr-Black.otf",
    ),
    (
        "noto-serif-cjk-kr-extralight",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-ExtraLight.otf",
    ),
    (
        "noto-serif-cjk-kr-light",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-Light.otf",
    ),
    (
        "noto-serif-cjk-kr-regular",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-Regular.otf",
    ),
    (
        "noto-serif-cjk-kr-medium",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-Medium.otf",
    ),
    (
        "noto-serif-cjk-kr-semibold",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-SemiBold.otf",
    ),
    (
        "noto-serif-cjk-kr-bold",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-Bold.otf",
    ),
    (
        "noto-serif-cjk-kr-black",
        "noto-serif-cjk-kr",
        "Serif/OTF/Korean/NotoSerifCJKkr-Black.otf",
    ),
)
EXPECTED_AUTHORITY = {
    "automatic_label_promotion_allowed": False,
    "calibration_eligible": False,
    "evaluation_eligible": False,
    "human_gold": False,
    "production_use_allowed": False,
    "training_eligible": True,
    "training_only": True,
}


class GlyphVoiceSourcePackError(ValueError):
    """Raised when an upstream source or sealed pack drifts."""


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
        raise GlyphVoiceSourcePackError(f"{location}: invalid record seal")
    body = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(body).encode("utf-8")) != expected:
        raise GlyphVoiceSourcePackError(f"{location}: record seal drifted")


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
        raise GlyphVoiceSourcePackError(f"{location}: linked/reparse path forbidden")
    if not path.is_file() or path.stat().st_size < 1:
        raise GlyphVoiceSourcePackError(f"{location}: missing regular file")


def _safe_relative_path(value: Any, location: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise GlyphVoiceSourcePackError(f"{location}: expected relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise GlyphVoiceSourcePackError(f"{location}: unsafe relative path")
    if any("\\" in part or ":" in part or not part for part in path.parts):
        raise GlyphVoiceSourcePackError(f"{location}: unsafe relative path")
    return path


def _resolve_repo_file(repo_root: Path, value: Any, location: str) -> Path:
    relative = _safe_relative_path(value, location)
    candidate = repo_root.joinpath(*relative.parts)
    _assert_regular_file(candidate, location)
    resolved = candidate.resolve()
    try:
        resolved.relative_to(repo_root.resolve())
    except ValueError as error:
        raise GlyphVoiceSourcePackError(f"{location}: escaped repository") from error
    return resolved


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    _assert_regular_file(path, location)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GlyphVoiceSourcePackError(f"{location}: invalid JSON") from error
    if not isinstance(value, Mapping):
        raise GlyphVoiceSourcePackError(f"{location}: expected object")
    return value


def _producer_descriptor(repo_root: Path) -> dict[str, Any]:
    path = Path(__file__).resolve()
    return {
        "byte_size": path.stat().st_size,
        "file": path.relative_to(repo_root.resolve()).as_posix(),
        "sha256": sha256_file(path),
    }


def _verify_producer(repo_root: Path, descriptor: Mapping[str, Any]) -> None:
    path = _resolve_repo_file(repo_root, descriptor.get("file"), "producer.file")
    if descriptor.get("byte_size") != path.stat().st_size or descriptor.get(
        "sha256"
    ) != sha256_file(path):
        raise GlyphVoiceSourcePackError("producer binding drifted")


def _fetch_bytes(url: str, *, timeout: int = 180, attempts: int = 4) -> bytes:
    headers = {"User-Agent": "carrot-manga-translator-glyphvoice-corpus/1"}
    last_error: BaseException | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
            if not payload:
                raise GlyphVoiceSourcePackError(f"empty response: {url}")
            return payload
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as error:
            last_error = error
            if isinstance(error, urllib.error.HTTPError) and error.code == 404:
                raise
            if attempt + 1 < attempts:
                time.sleep(0.5 * (2**attempt))
    raise GlyphVoiceSourcePackError(f"download failed: {url}") from last_error


def _fetch_optional(url: str) -> bytes | None:
    try:
        return _fetch_bytes(url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def _github_main_commit(repository: str) -> str:
    payload = _fetch_bytes(GITHUB_COMMIT_API.format(repository=repository))
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GlyphVoiceSourcePackError(
            f"invalid GitHub commit response: {repository}"
        ) from error
    commit = value.get("sha") if isinstance(value, Mapping) else None
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise GlyphVoiceSourcePackError(f"invalid GitHub commit SHA: {repository}")
    return commit


def _slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "", value.lower())
    if not result:
        raise GlyphVoiceSourcePackError(f"cannot slug family: {value!r}")
    return result


def _safe_id(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-._")
    if SAFE_ID_RE.fullmatch(normalized) is None:
        raise GlyphVoiceSourcePackError(f"unsafe generated identifier: {value!r}")
    return normalized


def _font_blocks(metadata: str) -> list[str]:
    result: list[str] = []
    cursor = 0
    while True:
        match = re.search(r"\bfonts\s*\{", metadata[cursor:])
        if match is None:
            break
        start = cursor + match.start()
        brace = metadata.find("{", start)
        depth = 0
        end = brace
        while end < len(metadata):
            if metadata[end] == "{":
                depth += 1
            elif metadata[end] == "}":
                depth -= 1
                if depth == 0:
                    result.append(metadata[brace + 1 : end])
                    cursor = end + 1
                    break
            end += 1
        else:
            raise GlyphVoiceSourcePackError("unterminated METADATA.pb fonts block")
    return result


def _parse_google_metadata(metadata: bytes) -> tuple[str, list[dict[str, Any]]]:
    try:
        text = metadata.decode("utf-8")
    except UnicodeDecodeError as error:
        raise GlyphVoiceSourcePackError(
            "Google Fonts METADATA.pb is not UTF-8"
        ) from error
    license_match = re.search(r'^license:\s*"([A-Z0-9]+)"', text, re.MULTILINE)
    if license_match is None or license_match.group(1) not in ALLOWED_LICENSES:
        raise GlyphVoiceSourcePackError(
            "Google Fonts license is missing or unsupported"
        )
    fonts: list[dict[str, Any]] = []
    for block in _font_blocks(text):
        filename = re.search(r'^\s*filename:\s*"([^"]+)"', block, re.MULTILINE)
        weight = re.search(r"^\s*weight:\s*([0-9]+)", block, re.MULTILINE)
        style = re.search(r'^\s*style:\s*"([^"]+)"', block, re.MULTILINE)
        if filename is None:
            continue
        fonts.append(
            {
                "filename": filename.group(1),
                "style": style.group(1) if style else "normal",
                "weight": int(weight.group(1)) if weight else 400,
            }
        )
    if not fonts:
        raise GlyphVoiceSourcePackError("Google Fonts METADATA.pb has no font files")
    return ALLOWED_LICENSES[license_match.group(1)], fonts


def _pick_representative_font(fonts: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    return min(
        fonts,
        key=lambda row: (
            0 if row.get("style") == "normal" else 1,
            abs(int(row.get("weight", 400)) - 400),
            str(row.get("filename")),
        ),
    )


def _materialize_representative_font(
    payload: bytes,
) -> tuple[bytes, Mapping[str, Any]]:
    """Freeze every variable axis, using regular weight when available."""

    try:
        font = TTFont(io.BytesIO(payload), lazy=False, recalcBBoxes=False)
    except Exception as error:
        raise GlyphVoiceSourcePackError("downloaded font is unreadable") from error
    try:
        if "fvar" not in font:
            digest = sha256_bytes(payload)
            return payload, {
                "axis_coordinates": {},
                "fonttools_version": fontTools.__version__,
                "materialized_static_instance": False,
                "original_sha256": digest,
                "output_sha256": digest,
            }
        coordinates: dict[str, float] = {}
        for axis in font["fvar"].axes:
            value = float(axis.defaultValue)
            if axis.axisTag == "wght":
                value = min(float(axis.maxValue), max(float(axis.minValue), 400.0))
            coordinates[str(axis.axisTag)] = value
        instance = instantiateVariableFont(
            font,
            coordinates,
            inplace=False,
            optimize=True,
            updateFontNames=True,
        )
        try:
            if "fvar" in instance:
                raise GlyphVoiceSourcePackError(
                    "variable axes remain after static materialization"
                )
            output = io.BytesIO()
            instance.save(output, reorderTables=True)
            materialized = output.getvalue()
        finally:
            instance.close()
        return materialized, {
            "axis_coordinates": coordinates,
            "fonttools_version": fontTools.__version__,
            "materialized_static_instance": True,
            "original_sha256": sha256_bytes(payload),
            "output_sha256": sha256_bytes(materialized),
        }
    finally:
        font.close()


def _google_family_selection(
    metadata_document: Mapping[str, Any], *, max_japanese: int, max_korean: int
) -> list[tuple[str, str]]:
    rows = metadata_document.get("familyMetadataList")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)):
        raise GlyphVoiceSourcePackError("Google Fonts metadata family list missing")
    japanese: list[str] = []
    korean: list[str] = []
    for row in rows:
        if not isinstance(row, Mapping) or row.get("isOpenSource") is not True:
            continue
        family = row.get("family")
        subsets = {str(value).lower() for value in row.get("subsets", [])}
        primary = str(row.get("primaryScript", ""))
        if not isinstance(family, str) or not family:
            continue
        if primary == "Hira" or "japanese" in subsets:
            japanese.append(family)
        if primary == "Kore" or "korean" in subsets:
            korean.append(family)
    japanese = sorted(set(japanese))
    korean = sorted(set(korean))
    if max_japanese > 0:
        japanese = japanese[:max_japanese]
    if max_korean > 0:
        korean = korean[:max_korean]
    return [(family, "ja") for family in japanese] + [
        (family, "ko") for family in korean
    ]


def _download_google_family(
    family: str,
    locale_hint: str,
    *,
    commit: str,
) -> dict[str, Any]:
    slug = _slug(family)
    metadata_payload: bytes | None = None
    directory: str | None = None
    for root in ("ofl", "apache", "ufl"):
        path = f"{root}/{slug}/METADATA.pb"
        metadata_payload = _fetch_optional(GOOGLE_RAW.format(commit=commit, path=path))
        if metadata_payload is None:
            continue
        directory = f"{root}/{slug}"
        break
    if metadata_payload is None or directory is None:
        raise GlyphVoiceSourcePackError(
            f"Google Fonts family is not downloadable: {family}"
        )
    license_id, fonts = _parse_google_metadata(metadata_payload)
    license_payload: bytes | None = None
    license_filename: str | None = None
    license_source_path: str | None = None
    for candidate in ("OFL.txt", "LICENSE.txt"):
        candidate_path = f"{directory}/{candidate}"
        license_payload = _fetch_optional(
            GOOGLE_RAW.format(commit=commit, path=candidate_path)
        )
        if license_payload is not None:
            license_filename = candidate
            license_source_path = candidate_path
            break
    if license_payload is None:
        canonical_path = (
            "ofl/aoboshione/OFL.txt"
            if license_id == "OFL-1.1"
            else "apache/luckiestguy/LICENSE.txt"
        )
        license_payload = _fetch_bytes(
            GOOGLE_RAW.format(commit=commit, path=canonical_path)
        )
        license_filename = "OFL.txt" if license_id == "OFL-1.1" else "LICENSE.txt"
        license_source_path = canonical_path
    assert license_filename is not None and license_source_path is not None
    selected = _pick_representative_font(fonts)
    filename = str(selected["filename"])
    encoded_path = urllib.parse.quote(f"{directory}/{filename}", safe="/[]@,+=")
    original_font_payload = _fetch_bytes(
        GOOGLE_RAW.format(commit=commit, path=encoded_path)
    )
    font_payload, materialization = _materialize_representative_font(
        original_font_payload
    )
    materialized_filename = filename
    if materialization["materialized_static_instance"]:
        source_path = Path(filename)
        stem = re.sub(r"\[[^\]]+\]", "", source_path.stem).rstrip("-_")
        materialized_filename = f"{stem}-instance-wght400{source_path.suffix}"
    return {
        "directory": directory,
        "family": family,
        "font_filename": filename,
        "font_payload": font_payload,
        "license_filename": license_filename,
        "license_id": license_id,
        "license_payload": license_payload,
        "license_source_path": license_source_path,
        "locale_hint": locale_hint,
        "materialization": materialization,
        "materialized_filename": materialized_filename,
        "metadata_payload": metadata_payload,
        "original_font_payload": original_font_payload,
        "selected_font": dict(selected),
        "slug": slug,
    }


def _download_noto(commit: str) -> tuple[bytes, list[dict[str, Any]]]:
    sans_license = _fetch_bytes(NOTO_RAW.format(commit=commit, path="Sans/LICENSE"))
    serif_license = _fetch_bytes(NOTO_RAW.format(commit=commit, path="Serif/LICENSE"))
    if sans_license != serif_license:
        raise GlyphVoiceSourcePackError("Noto Sans/Serif license texts differ")
    license_payload = sans_license

    def download(row: tuple[str, str, str]) -> dict[str, Any]:
        source_id, family_id, path = row
        return {
            "family_id": family_id,
            "font_payload": _fetch_bytes(
                NOTO_RAW.format(commit=commit, path=urllib.parse.quote(path, safe="/"))
            ),
            "path": path,
            "source_id": source_id,
        }

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(download, row): row for row in NOTO_FONTS}
        for future in as_completed(futures):
            results.append(future.result())
    return license_payload, sorted(results, key=lambda row: row["source_id"])


def _write_download(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _publish_staging(staging: Path, target: Path) -> None:
    """Rename an absent-target directory, tolerating short Windows scanner locks."""

    for attempt in range(8):
        try:
            staging.rename(target)
            return
        except PermissionError:
            if target.exists() or attempt == 7:
                raise
            time.sleep(0.05 * (attempt + 1))
    raise AssertionError("unreachable staging publication loop")


def _artifact_inventory(root: Path) -> list[dict[str, Any]]:
    return [
        {
            "byte_size": path.stat().st_size,
            "file": path.relative_to(root).as_posix(),
            "sha256": sha256_file(path),
        }
        for path in sorted(
            root.rglob("*"), key=lambda value: value.relative_to(root).as_posix()
        )
        if path.is_file() and path.name not in {REPORT_FILE, MARKER_FILE}
    ]


def _merge_base_sources(
    base_manifest: Path | None, repo_root: Path
) -> list[Mapping[str, Any]]:
    if base_manifest is None:
        return []
    document = _read_json(base_manifest, "base source manifest")
    validate_record_seal(document, "base source manifest")
    if (
        document.get("schema_version") != SOURCE_SCHEMA_VERSION
        or document.get("record_type") != SOURCE_RECORD_TYPE
    ):
        raise GlyphVoiceSourcePackError("base source manifest schema drifted")
    rows = document.get("sources")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)):
        raise GlyphVoiceSourcePackError("base source rows missing")
    result: list[Mapping[str, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise GlyphVoiceSourcePackError("base source row invalid")
        font_path = _resolve_repo_file(
            repo_root, row.get("font_file"), f"base[{index}].font"
        )
        license_record = row.get("license")
        if not isinstance(license_record, Mapping):
            raise GlyphVoiceSourcePackError("base source license missing")
        license_path = _resolve_repo_file(
            repo_root, license_record.get("text_file"), f"base[{index}].license"
        )
        if row.get("font_sha256") != sha256_file(font_path) or license_record.get(
            "text_sha256"
        ) != sha256_file(license_path):
            raise GlyphVoiceSourcePackError("base source bytes drifted")
        result.append(copy.deepcopy(dict(row)))
    return result


def build_pack(
    *,
    output_dir: Path,
    repo_root: Path,
    base_source_manifest: Path | None,
    max_japanese: int,
    max_korean: int,
    include_noto: bool,
    workers: int,
) -> Mapping[str, Any]:
    if workers < 1 or workers > 16:
        raise GlyphVoiceSourcePackError("workers must be between 1 and 16")
    if any(
        isinstance(value, bool) or value < 0 for value in (max_japanese, max_korean)
    ):
        raise GlyphVoiceSourcePackError("font limits must be nonnegative integers")
    target = output_dir.expanduser().absolute()
    if target.exists() or _is_link_or_reparse(target):
        raise GlyphVoiceSourcePackError("output directory already exists")
    if _path_or_ancestor_is_link_or_reparse(target.parent):
        raise GlyphVoiceSourcePackError("output parent is linked")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:

        def final_repo_file(path: Path) -> str:
            final_path = target / path.relative_to(staging)
            return final_path.relative_to(repo_root.resolve()).as_posix()

        google_commit = _github_main_commit(GOOGLE_REPOSITORY)
        noto_commit = _github_main_commit(NOTO_REPOSITORY) if include_noto else None
        google_metadata_payload = _fetch_bytes(GOOGLE_METADATA_URL)
        try:
            google_metadata = json.loads(google_metadata_payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GlyphVoiceSourcePackError(
                "Google Fonts metadata is invalid"
            ) from error
        if not isinstance(google_metadata, Mapping):
            raise GlyphVoiceSourcePackError("Google Fonts metadata is not an object")
        selection = _google_family_selection(
            google_metadata,
            max_japanese=max_japanese,
            max_korean=max_korean,
        )
        _write_download(
            staging / UPSTREAM_DIR / "google-fonts-metadata.json",
            google_metadata_payload,
        )
        print(f"selected Google Fonts families: {len(selection)}", flush=True)
        google_rows: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    _download_google_family, family, locale, commit=google_commit
                ): (family, locale)
                for family, locale in selection
            }
            completed = 0
            for future in as_completed(futures):
                family, locale = futures[future]
                downloaded = future.result()
                slug = downloaded["slug"]
                family_root = staging / UPSTREAM_DIR / "google-fonts" / slug
                font_path = family_root / "fonts" / downloaded["materialized_filename"]
                metadata_path = family_root / "METADATA.pb"
                license_path = family_root / downloaded["license_filename"]
                _write_download(font_path, downloaded["font_payload"])
                original_path = font_path
                if downloaded["materialization"]["materialized_static_instance"]:
                    original_path = (
                        family_root / "original" / downloaded["font_filename"]
                    )
                    _write_download(original_path, downloaded["original_font_payload"])
                _write_download(metadata_path, downloaded["metadata_payload"])
                _write_download(license_path, downloaded["license_payload"])
                source_id = _safe_id(
                    f"gf-{slug}-{Path(downloaded['materialized_filename']).stem}"
                )
                google_rows.append(
                    {
                        "face_index": 0,
                        "family_id": _safe_id(f"gf-{slug}"),
                        "font_file": final_repo_file(font_path),
                        "font_sha256": sha256_file(font_path),
                        "label": family,
                        "license": {
                            "id": downloaded["license_id"],
                            "source_url": GOOGLE_RAW.format(
                                commit=google_commit,
                                path=downloaded["license_source_path"],
                            ),
                            "text_file": final_repo_file(license_path),
                            "text_sha256": sha256_file(license_path),
                            "training_allowed": True,
                        },
                        "locale_hint": locale,
                        "source_id": source_id,
                        "upstream": {
                            "commit": google_commit,
                            "metadata_file": final_repo_file(metadata_path),
                            "metadata_sha256": sha256_file(metadata_path),
                            "materialization": downloaded["materialization"],
                            "original_font": {
                                "byte_size": original_path.stat().st_size,
                                "file": final_repo_file(original_path),
                                "sha256": sha256_file(original_path),
                            },
                            "repository": GOOGLE_REPOSITORY,
                            "selected_font": downloaded["selected_font"],
                        },
                    }
                )
                completed += 1
                print(
                    f"google-fonts {completed}/{len(selection)}: {family}", flush=True
                )

        noto_rows: list[dict[str, Any]] = []
        if include_noto:
            assert noto_commit is not None
            noto_license, noto_downloads = _download_noto(noto_commit)
            noto_license_path = staging / UPSTREAM_DIR / "noto-cjk" / "LICENSE"
            _write_download(noto_license_path, noto_license)
            for downloaded in noto_downloads:
                filename = Path(downloaded["path"]).name
                font_path = staging / UPSTREAM_DIR / "noto-cjk" / "fonts" / filename
                _write_download(font_path, downloaded["font_payload"])
                noto_rows.append(
                    {
                        "face_index": 0,
                        "family_id": downloaded["family_id"],
                        "font_file": final_repo_file(font_path),
                        "font_sha256": sha256_file(font_path),
                        "label": downloaded["family_id"].replace("-", " ").title(),
                        "license": {
                            "id": "OFL-1.1",
                            "source_url": NOTO_RAW.format(
                                commit=noto_commit, path="Sans/LICENSE"
                            ),
                            "text_file": final_repo_file(noto_license_path),
                            "text_sha256": sha256_file(noto_license_path),
                            "training_allowed": True,
                        },
                        "locale_hint": "bridge_candidate",
                        "source_id": downloaded["source_id"],
                        "upstream": {
                            "commit": noto_commit,
                            "font_path": downloaded["path"],
                            "repository": NOTO_REPOSITORY,
                        },
                    }
                )
            print(f"noto-cjk faces: {len(noto_rows)}", flush=True)

        base_rows = _merge_base_sources(base_source_manifest, repo_root)
        combined = [*base_rows, *google_rows, *noto_rows]
        deduplicated: list[Mapping[str, Any]] = []
        seen_physical: set[tuple[str, int]] = set()
        seen_ids: set[str] = set()
        for row in combined:
            identity = (str(row["font_sha256"]), int(row["face_index"]))
            source_id = str(row["source_id"])
            if identity in seen_physical:
                continue
            if source_id in seen_ids:
                raise GlyphVoiceSourcePackError(
                    f"duplicate source id after merge: {source_id}"
                )
            seen_physical.add(identity)
            seen_ids.add(source_id)
            deduplicated.append(row)
        deduplicated.sort(
            key=lambda row: (
                str(row["family_id"]),
                str(row["source_id"]),
                int(row["face_index"]),
            )
        )
        source_record = seal_record(
            {
                "authority": EXPECTED_AUTHORITY,
                "counts": {
                    "base_face_count": len(base_rows),
                    "deduplicated_face_count": len(deduplicated),
                    "family_count": len(
                        {str(row["family_id"]) for row in deduplicated}
                    ),
                    "google_face_count": len(google_rows),
                    "noto_cjk_face_count": len(noto_rows),
                },
                "inputs": {
                    "base_source_manifest": (
                        {
                            "file": base_source_manifest.resolve()
                            .relative_to(repo_root.resolve())
                            .as_posix(),
                            "sha256": sha256_file(base_source_manifest),
                        }
                        if base_source_manifest is not None
                        else None
                    ),
                    "google_fonts": {
                        "commit": google_commit,
                        "metadata_sha256": sha256_bytes(google_metadata_payload),
                        "metadata_url": GOOGLE_METADATA_URL,
                        "repository": GOOGLE_REPOSITORY,
                    },
                    "noto_cjk": (
                        {"commit": noto_commit, "repository": NOTO_REPOSITORY}
                        if include_noto
                        else None
                    ),
                },
                "producer": _producer_descriptor(repo_root),
                "record_type": SOURCE_RECORD_TYPE,
                "schema_version": SOURCE_SCHEMA_VERSION,
                "sources": deduplicated,
            }
        )
        (staging / SOURCE_FILE).write_bytes(json_bytes(source_record, pretty=True))
        inventory = _artifact_inventory(staging)
        report = seal_record(
            {
                "artifacts": inventory,
                "artifact_inventory_sha256": sha256_bytes(
                    canonical_json(inventory).encode("utf-8")
                ),
                "counts": source_record["counts"],
                "producer": _producer_descriptor(repo_root),
                "record_type": REPORT_RECORD_TYPE,
                "schema_version": PACK_SCHEMA_VERSION,
                "source_manifest_record_sha256": source_record["record_sha256"],
                "status": "built_open_font_training_source_pack",
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    REPORT_FILE: sha256_file(staging / REPORT_FILE),
                    SOURCE_FILE: sha256_file(staging / SOURCE_FILE),
                    "artifact_inventory_sha256": report["artifact_inventory_sha256"],
                },
                "owner": OWNER,
                "safe_replace": False,
                "schema_version": PACK_SCHEMA_VERSION,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        _publish_staging(staging, target)
        return validate_pack(target, repo_root=repo_root)
    except BaseException:
        if staging.exists() and not _is_link_or_reparse(staging):
            shutil.rmtree(staging)
        raise


def validate_pack(output_dir: Path, *, repo_root: Path) -> Mapping[str, Any]:
    expanded = output_dir.expanduser().absolute()
    if _path_or_ancestor_is_link_or_reparse(expanded):
        raise GlyphVoiceSourcePackError("source pack output is linked")
    root = expanded.resolve()
    if not root.is_dir() or {path.name for path in root.iterdir()} != ROOT_INVENTORY:
        raise GlyphVoiceSourcePackError("source pack root inventory drifted")
    for path in root.rglob("*"):
        if _is_link_or_reparse(path):
            raise GlyphVoiceSourcePackError(
                "source pack contains linked/reparse content"
            )
    source = _read_json(root / SOURCE_FILE, "source manifest")
    report = _read_json(root / REPORT_FILE, "report")
    marker = _read_json(root / MARKER_FILE, "marker")
    for record, location in (
        (source, "source manifest"),
        (report, "report"),
        (marker, "marker"),
    ):
        validate_record_seal(record, location)
    if (
        source.get("schema_version") != SOURCE_SCHEMA_VERSION
        or source.get("record_type") != SOURCE_RECORD_TYPE
    ):
        raise GlyphVoiceSourcePackError("source manifest contract drifted")
    if source.get("authority") != EXPECTED_AUTHORITY:
        raise GlyphVoiceSourcePackError("source authority drifted")
    if (
        report.get("schema_version") != PACK_SCHEMA_VERSION
        or report.get("record_type") != REPORT_RECORD_TYPE
        or report.get("source_manifest_record_sha256") != source.get("record_sha256")
    ):
        raise GlyphVoiceSourcePackError("report contract drifted")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not False
        or marker.get("schema_version") != PACK_SCHEMA_VERSION
    ):
        raise GlyphVoiceSourcePackError("marker contract drifted")
    producer = source.get("producer")
    if not isinstance(producer, Mapping):
        raise GlyphVoiceSourcePackError("source producer missing")
    _verify_producer(repo_root, producer)
    rows = source.get("sources")
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)) or not rows:
        raise GlyphVoiceSourcePackError("source rows missing")
    identities: set[tuple[str, int]] = set()
    source_ids: set[str] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise GlyphVoiceSourcePackError("source row invalid")
        source_id = row.get("source_id")
        if (
            not isinstance(source_id, str)
            or SAFE_ID_RE.fullmatch(source_id) is None
            or source_id in source_ids
        ):
            raise GlyphVoiceSourcePackError("source identity drifted")
        source_ids.add(source_id)
        font = _resolve_repo_file(
            repo_root, row.get("font_file"), f"source[{index}].font"
        )
        face_index = row.get("face_index")
        if (
            isinstance(face_index, bool)
            or not isinstance(face_index, int)
            or face_index < 0
        ):
            raise GlyphVoiceSourcePackError("source face index invalid")
        identity = (str(row.get("font_sha256")), face_index)
        if identity in identities or row.get("font_sha256") != sha256_file(font):
            raise GlyphVoiceSourcePackError("source physical identity drifted")
        identities.add(identity)
        license_record = row.get("license")
        if (
            not isinstance(license_record, Mapping)
            or license_record.get("id") not in ALLOWED_LICENSES.values()
            or license_record.get("training_allowed") is not True
        ):
            raise GlyphVoiceSourcePackError("source license contract drifted")
        license_path = _resolve_repo_file(
            repo_root, license_record.get("text_file"), f"source[{index}].license"
        )
        if license_record.get("text_sha256") != sha256_file(license_path):
            raise GlyphVoiceSourcePackError("source license bytes drifted")
        upstream = row.get("upstream")
        if (
            isinstance(upstream, Mapping)
            and upstream.get("repository") == GOOGLE_REPOSITORY
        ):
            materialization = upstream.get("materialization")
            original_descriptor = upstream.get("original_font")
            if not isinstance(materialization, Mapping) or not isinstance(
                original_descriptor, Mapping
            ):
                raise GlyphVoiceSourcePackError(
                    "Google source materialization binding missing"
                )
            original = _resolve_repo_file(
                repo_root,
                original_descriptor.get("file"),
                f"source[{index}].original_font",
            )
            if (
                original_descriptor.get("byte_size") != original.stat().st_size
                or original_descriptor.get("sha256") != sha256_file(original)
                or materialization.get("original_sha256") != sha256_file(original)
                or materialization.get("output_sha256") != sha256_file(font)
                or materialization.get("fonttools_version") != fontTools.__version__
                or not isinstance(materialization.get("axis_coordinates"), Mapping)
                or not isinstance(
                    materialization.get("materialized_static_instance"), bool
                )
            ):
                raise GlyphVoiceSourcePackError(
                    "Google source materialization binding drifted"
                )
            with TTFont(str(font), lazy=False, recalcBBoxes=False) as materialized_font:
                if "fvar" in materialized_font:
                    raise GlyphVoiceSourcePackError(
                        "training font retained variable axes"
                    )
            if materialization["materialized_static_instance"]:
                with TTFont(
                    str(original), lazy=False, recalcBBoxes=False
                ) as original_font:
                    if "fvar" not in original_font:
                        raise GlyphVoiceSourcePackError(
                            "materialized source was not variable"
                        )
            elif original.resolve() != font.resolve():
                raise GlyphVoiceSourcePackError(
                    "static Google font duplicated as a transformed source"
                )
    inventory = report.get("artifacts")
    if not isinstance(inventory, Sequence) or isinstance(inventory, (str, bytes)):
        raise GlyphVoiceSourcePackError("artifact inventory missing")
    expected_paths: set[str] = set()
    for descriptor in inventory:
        if not isinstance(descriptor, Mapping):
            raise GlyphVoiceSourcePackError("artifact descriptor invalid")
        relative = _safe_relative_path(descriptor.get("file"), "artifact.file")
        path = root.joinpath(*relative.parts)
        _assert_regular_file(path, "artifact")
        if descriptor.get("byte_size") != path.stat().st_size or descriptor.get(
            "sha256"
        ) != sha256_file(path):
            raise GlyphVoiceSourcePackError("artifact descriptor drifted")
        expected_paths.add(relative.as_posix())
    physical = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name not in {REPORT_FILE, MARKER_FILE}
    }
    if physical != expected_paths or report.get(
        "artifact_inventory_sha256"
    ) != sha256_bytes(canonical_json(list(inventory)).encode("utf-8")):
        raise GlyphVoiceSourcePackError("artifact inventory drifted")
    marker_artifacts = marker.get("artifacts")
    if not isinstance(marker_artifacts, Mapping) or dict(marker_artifacts) != {
        REPORT_FILE: sha256_file(root / REPORT_FILE),
        SOURCE_FILE: sha256_file(root / SOURCE_FILE),
        "artifact_inventory_sha256": report["artifact_inventory_sha256"],
    }:
        raise GlyphVoiceSourcePackError("marker binding drifted")
    return {
        "face_count": len(rows),
        "family_count": len({str(row["family_id"]) for row in rows}),
        "status": "validated_open_font_training_source_pack",
    }


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="download and seal a new source pack")
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--base-source-manifest", type=Path)
    build.add_argument("--max-japanese", type=int, default=0)
    build.add_argument("--max-korean", type=int, default=0)
    build.add_argument(
        "--workers", type=int, default=min(8, max(1, (os.cpu_count() or 4)))
    )
    build.add_argument("--without-noto", action="store_true")
    validate = subparsers.add_parser("validate", help="strictly validate a source pack")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = _default_repo_root()
    if args.command == "build":
        result = build_pack(
            output_dir=args.output_dir,
            repo_root=repo_root,
            base_source_manifest=args.base_source_manifest,
            max_japanese=args.max_japanese,
            max_korean=args.max_korean,
            include_noto=not args.without_noto,
            workers=args.workers,
        )
    else:
        result = validate_pack(args.output_dir, repo_root=repo_root)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
