#!/usr/bin/env python3
"""Resolve and validate physical assets used by font-matching training.

This module is deliberately importable by a trainer.  ``CatalogAssetResolver``
turns one sealed training-sample view descriptor into a verified in-memory RGB
image.  ``validate_training_asset_bundle`` performs the exhaustive preflight
over a catalog registry, a training export, and its render bank and returns a
deterministic sealed report.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any, Mapping, Sequence

from PIL import Image, UnidentifiedImageError

try:
    import build_font_matching_master as master
except ImportError:  # pragma: no cover - import from repository root
    from scripts import build_font_matching_master as master  # type: ignore[no-redef]


SCHEMA_VERSION = "font-matching-training-assets-validation-v1"
RECORD_TYPE = "font_matching_training_assets_validation"
TRAINING_EXPORT_SCHEMA_VERSION = "font-matching-training-export-v1"
TRAINING_EXPORT_REPORT_SCHEMA_VERSION = "font-matching-training-export-report-v1"
TRAINING_SAMPLE_SCHEMA_VERSION = "font-matching-training-sample-v1"
TRAINING_EXPORT_OWNER = "carrot-manga-translator/font-matching-training-export"
RENDER_BANK_SCHEMA_VERSION = "font-render-bank-v1"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
VALID_SPLITS = frozenset({"train", "val", "test"})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
OVERLAY_PATH_PARTS = frozenset(
    {
        "contact-sheet",
        "contact-sheets",
        "contact_sheet",
        "contact_sheets",
        "diagnostic",
        "diagnostics",
        "overlay",
        "overlays",
        "qa-overlay",
        "qa-overlays",
        "qa_overlay",
        "qa_overlays",
    }
)
OVERLAY_FLAG_KEYS = frozenset(
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
SYNTHETIC_FLAG_KEYS = frozenset(
    {
        "generated",
        "generative",
        "is_synthetic",
        "synthetic",
        "synthetic_style",
    }
)
EVALUATION_FLAG_KEYS = frozenset({"eval_eligible", "evaluation_eligible"})
RAW_224_RECIPE: Mapping[str, Any] = MappingProxyType(
    {
        "algorithm": "fontclip-letterbox-rgb-v1",
        "canvas_color_rgb": [255, 255, 255],
        "convert_mode": "RGB",
        "operation": "aspect_preserving_letterbox",
        "placement": "center_floor",
        "resize_filter": "lanczos",
        "rounding": "python_round_then_minimum_1px",
        "target_size_px": [224, 224],
    }
)


class CatalogAssetError(ValueError):
    """Raised when a training asset is not exactly the sealed real input."""


@dataclass
class ResolvedImageAsset:
    """One verified trainer-ready view.

    The image is detached from the source file and always RGB.  Callers should
    use this object as a context manager or call ``close`` after tensorization.
    """

    sample_id: str
    view_name: str
    catalog_id: str
    status: str
    physical_path: Path
    source_file_sha256: str
    source_byte_size: int
    pixel_sha256: str
    image: Image.Image
    materialized: bool

    @property
    def mode(self) -> str:
        return self.image.mode

    @property
    def size(self) -> tuple[int, int]:
        return self.image.size

    def close(self) -> None:
        self.image.close()

    def __enter__(self) -> ResolvedImageAsset:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def evidence(self) -> dict[str, Any]:
        return {
            "catalog_id": self.catalog_id,
            "materialized": self.materialized,
            "mode": self.mode,
            "pixel_sha256": self.pixel_sha256,
            "sample_id": self.sample_id,
            "size_px": list(self.size),
            "source_byte_size": self.source_byte_size,
            "source_file_sha256": self.source_file_sha256,
            "status": self.status,
            "view_name": self.view_name,
        }


@dataclass
class ResolvedRenderPrototype:
    """One verified, detached RGB render-bank prototype for tensorization."""

    render_id: str
    font_id: str
    candidate_display_id: str
    blind_alias: str
    probe_id: str
    writing_mode: str
    image_file: str
    physical_path: Path
    source_font_sha256: str
    source_file_sha256: str
    source_byte_size: int
    pixel_sha256: str
    image: Image.Image

    @property
    def mode(self) -> str:
        return self.image.mode

    @property
    def size(self) -> tuple[int, int]:
        return self.image.size

    def close(self) -> None:
        self.image.close()

    def __enter__(self) -> ResolvedRenderPrototype:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def evidence(self) -> dict[str, Any]:
        return {
            "blind_alias": self.blind_alias,
            "candidate_display_id": self.candidate_display_id,
            "font_id": self.font_id,
            "image_file": self.image_file,
            "mode": self.mode,
            "pixel_sha256": self.pixel_sha256,
            "probe_id": self.probe_id,
            "render_id": self.render_id,
            "size_px": list(self.size),
            "source_byte_size": self.source_byte_size,
            "source_file_sha256": self.source_file_sha256,
            "source_font_sha256": self.source_font_sha256,
            "writing_mode": self.writing_mode,
        }


@dataclass(frozen=True)
class TrainingExportSnapshot:
    root: Path
    marker_sha256: str
    manifest_sha256: str
    report_sha256: str
    samples_sha256: str
    manifest: Mapping[str, Any]
    samples: tuple[Mapping[str, Any], ...]
    candidate_count: int


@dataclass(frozen=True)
class RenderBankSnapshot:
    manifest_path: Path
    manifest_sha256: str
    specification_sha256: str
    candidate_ids: tuple[str, ...]
    prototype_evidence: tuple[Mapping[str, Any], ...]

    @property
    def prototype_ids(self) -> tuple[str, ...]:
        return tuple(str(row["render_id"]) for row in self.prototype_evidence)

    def resolve_prototype(self, render_id: str) -> ResolvedRenderPrototype:
        """Open one prototype and reverify its bytes before returning it."""

        normalized_id = require_id(render_id, location="render_id")
        matches = [
            row
            for row in self.prototype_evidence
            if row.get("render_id") == normalized_id
        ]
        if len(matches) != 1:
            raise CatalogAssetError(
                f"render bank has no unique prototype {normalized_id!r}"
            )
        evidence = matches[0]
        relative = safe_relative_path(
            evidence.get("image_file"),
            location=f"prototype[{normalized_id}].image_file",
        )
        physical = resolve_inside(
            self.manifest_path.parent,
            relative,
            location=f"prototype[{normalized_id}].image_file",
        )
        payload = _read_bytes(physical, location=f"prototype[{normalized_id}]")
        expected_sha = require_sha256(
            evidence.get("artifact_sha256"),
            location=f"prototype[{normalized_id}].artifact_sha256",
        )
        if sha256_bytes(payload) != expected_sha:
            raise CatalogAssetError(
                f"prototype[{normalized_id}]: render artifact hash mismatch"
            )
        if evidence.get("artifact_byte_size") != len(payload):
            raise CatalogAssetError(
                f"prototype[{normalized_id}]: render artifact byte size mismatch"
            )
        image, mode, size = _decode_image_bytes(
            payload, location=f"prototype[{normalized_id}]"
        )
        if mode != "RGB" or list(size) != evidence.get("size_px"):
            image.close()
            raise CatalogAssetError(
                f"prototype[{normalized_id}]: decoded image contract drifted"
            )
        actual_pixel_sha = pixel_sha256(image)
        if actual_pixel_sha != evidence.get("pixel_sha256"):
            image.close()
            raise CatalogAssetError(
                f"prototype[{normalized_id}]: decoded pixel hash drifted"
            )
        return ResolvedRenderPrototype(
            render_id=normalized_id,
            font_id=str(evidence["font_id"]),
            candidate_display_id=str(evidence["candidate_display_id"]),
            blind_alias=str(evidence["blind_alias"]),
            probe_id=str(evidence["probe_id"]),
            writing_mode=str(evidence["writing_mode"]),
            image_file=relative,
            physical_path=physical,
            source_font_sha256=str(evidence["source_font_sha256"]),
            source_file_sha256=expected_sha,
            source_byte_size=len(payload),
            pixel_sha256=actual_pixel_sha,
            image=image,
        )


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise CatalogAssetError(f"could not read {path}: {error}") from error
    return digest.hexdigest()


def pixel_sha256(image: Image.Image) -> str:
    canonical = image
    if canonical.mode not in {"RGB", "RGBA", "L"}:
        canonical = canonical.convert("RGB")
    digest = hashlib.sha256()
    digest.update(canonical.mode.encode("ascii", "strict"))
    digest.update(b"\0")
    digest.update(f"{canonical.width}x{canonical.height}".encode("ascii"))
    digest.update(b"\0")
    digest.update(canonical.tobytes())
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = dict(core)
    output["record_sha256"] = sha256_bytes(canonical_json(core).encode("utf-8"))
    return output


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    expected = require_sha256(
        record.get("record_sha256"), location=f"{location}.record_sha256"
    )
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != expected:
        raise CatalogAssetError(f"{location}: record seal mismatch")
    return expected


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CatalogAssetError(f"{location}: expected an object")
    return value


def require_list(value: Any, *, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise CatalogAssetError(f"{location}: expected an array")
    return value


def require_text(value: Any, *, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise CatalogAssetError(f"{location}: expected a non-empty string")
    return normalized


def require_id(value: Any, *, location: str) -> str:
    normalized = require_text(value, location=location)
    if SAFE_ID_RE.fullmatch(normalized) is None:
        raise CatalogAssetError(f"{location}: invalid identifier")
    return normalized


def require_sha256(value: Any, *, location: str) -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    if SHA256_RE.fullmatch(normalized) is None:
        raise CatalogAssetError(f"{location}: expected a lowercase SHA-256")
    return normalized


def nested(value: Mapping[str, Any], *parts: str) -> Any:
    current: Any = value
    for part in parts:
        if not isinstance(current, Mapping):
            return None
        current = current.get(part)
    return current


def safe_relative_path(value: Any, *, location: str) -> str:
    raw = require_text(value, location=location).replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    pure = PurePosixPath(raw)
    if (
        pure.is_absolute()
        or not pure.parts
        or any(part in {"", ".", ".."} for part in pure.parts)
        or ":" in pure.parts[0]
    ):
        raise CatalogAssetError(f"{location}: unsafe relative path {value!r}")
    return pure.as_posix()


def path_looks_like_overlay(relative: str) -> bool:
    parts: set[str] = set()
    for raw_part in PurePosixPath(relative).parts:
        part = raw_part.casefold()
        parts.add(part)
        parts.add(PurePosixPath(part).stem)
    return bool(parts & OVERLAY_PATH_PARTS)


def resolve_inside(root: Path, relative: str, *, location: str) -> Path:
    if path_looks_like_overlay(relative):
        raise CatalogAssetError(f"{location}: QA/diagnostic path is forbidden")
    candidate = (root / Path(*PurePosixPath(relative).parts)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise CatalogAssetError(f"{location}: path escaped its catalog root") from error
    if not candidate.is_file():
        raise CatalogAssetError(f"{location}: referenced file does not exist")
    return candidate


def assert_no_forbidden_flags(value: Any, *, location: str, key: str = "") -> None:
    normalized_key = key.casefold()
    if normalized_key in OVERLAY_FLAG_KEYS and value is not False:
        raise CatalogAssetError(f"{location}: QA/diagnostic overlay input is forbidden")
    if normalized_key in SYNTHETIC_FLAG_KEYS and value is not False:
        raise CatalogAssetError(f"{location}: synthetic/generated input is forbidden")
    if normalized_key in EVALUATION_FLAG_KEYS and value is not True:
        raise CatalogAssetError(f"{location}: evaluation-ineligible input is forbidden")
    if normalized_key in {"provenance", "source_provenance"} and isinstance(value, str):
        lowered = value.casefold()
        if "synthetic" in lowered or "generative" in lowered:
            raise CatalogAssetError(f"{location}: synthetic provenance is forbidden")
    if isinstance(value, Mapping):
        for child_key, child in value.items():
            assert_no_forbidden_flags(
                child,
                location=f"{location}.{child_key}",
                key=str(child_key),
            )
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_forbidden_flags(child, location=f"{location}[{index}]", key=key)


def _read_bytes(path: Path, *, location: str) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise CatalogAssetError(
            f"{location}: could not read {path}: {error}"
        ) from error


def read_json(path: Path, *, location: str) -> dict[str, Any]:
    payload = _read_bytes(path, location=location)
    try:
        value = json.loads(payload.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogAssetError(f"{location}: invalid JSON: {error}") from error
    return dict(require_mapping(value, location=location))


def read_jsonl(
    path: Path, *, location: str
) -> tuple[tuple[Mapping[str, Any], ...], bytes]:
    payload = _read_bytes(path, location=location)
    rows: list[Mapping[str, Any]] = []
    for line_number, line in enumerate(payload.splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CatalogAssetError(
                f"{location}:{line_number}: invalid JSON: {error}"
            ) from error
        rows.append(dict(require_mapping(value, location=f"{location}:{line_number}")))
    return tuple(rows), payload


def _decode_image_bytes(
    payload: bytes, *, location: str
) -> tuple[Image.Image, str, tuple[int, int]]:
    try:
        with Image.open(io.BytesIO(payload)) as opened:
            opened.load()
            mode = opened.mode
            size = opened.size
            detached = opened.copy()
    except (OSError, UnidentifiedImageError) as error:
        raise CatalogAssetError(f"{location}: image decode failed: {error}") from error
    if size[0] <= 0 or size[1] <= 0:
        detached.close()
        raise CatalogAssetError(f"{location}: decoded image is empty")
    return detached, mode, size


def letterbox_raw_224(image: Image.Image) -> Image.Image:
    """Materialize the exact ``fontclip-letterbox-rgb-v1`` recipe."""

    source = image.convert("RGB")
    scale = min(224 / source.width, 224 / source.height)
    resized_size = (
        max(1, round(source.width * scale)),
        max(1, round(source.height * scale)),
    )
    resized = source.resize(resized_size, Image.Resampling.LANCZOS)
    source.close()
    output = Image.new("RGB", (224, 224), (255, 255, 255))
    output.paste(
        resized,
        ((224 - resized.width) // 2, (224 - resized.height) // 2),
    )
    resized.close()
    return output


class CatalogAssetResolver:
    """Resolve sealed sample views against catalog roots from one registry."""

    def __init__(self, registry_path: Path | str) -> None:
        self.registry_path = Path(registry_path).expanduser().resolve()
        try:
            configuration = master.load_catalog_registry(self.registry_path)
        except master.MasterManifestError as error:
            raise CatalogAssetError(f"catalog registry: {error}") from error
        registry = read_json(self.registry_path, location="catalog registry")
        self.registry_sha256 = sha256_file(self.registry_path)
        self.registry_record_sha256 = validate_record_seal(
            registry, location="catalog registry"
        )
        roots: dict[str, Path] = {}
        manifest_hashes: dict[str, str] = {}
        for catalog in configuration.catalogs:
            if catalog.catalog_id in roots:
                raise CatalogAssetError(
                    f"duplicate registry catalog {catalog.catalog_id!r}"
                )
            root = catalog.root.resolve()
            if not root.is_dir():
                raise CatalogAssetError(
                    f"catalog root is not a directory: {catalog.catalog_id}"
                )
            manifest = catalog.manifest_path.resolve()
            if manifest.parent != root or not manifest.is_file():
                raise CatalogAssetError(
                    f"{catalog.catalog_id}: manifest is not a direct root child"
                )
            roots[catalog.catalog_id] = root
            manifest_hashes[catalog.catalog_id] = sha256_file(manifest)
        self.catalog_roots: Mapping[str, Path] = MappingProxyType(roots)
        self.catalog_manifest_sha256: Mapping[str, str] = MappingProxyType(
            manifest_hashes
        )

    def _catalog_root(self, catalog_id: str, *, location: str) -> Path:
        root = self.catalog_roots.get(catalog_id)
        if root is None:
            raise CatalogAssetError(f"{location}: unknown catalog {catalog_id!r}")
        return root

    def resolve_sample_view(
        self, sample: Mapping[str, Any], view_name: str
    ) -> ResolvedImageAsset:
        if view_name not in VIEW_NAMES:
            raise CatalogAssetError(f"unsupported model view {view_name!r}")
        sample_id = require_id(sample.get("sample_id"), location="sample.sample_id")
        assert_no_forbidden_flags(sample, location=f"sample[{sample_id}]")
        source = require_mapping(
            sample.get("source"), location=f"sample[{sample_id}].source"
        )
        views = require_mapping(
            source.get("views"), location=f"sample[{sample_id}].source.views"
        )
        return self.resolve_view_descriptor(
            views.get(view_name),
            sample_id=sample_id,
            view_name=view_name,
            location=f"sample[{sample_id}].source.views.{view_name}",
        )

    def resolve_view_descriptor(
        self,
        value: Any,
        *,
        sample_id: str,
        view_name: str,
        location: str,
    ) -> ResolvedImageAsset:
        descriptor = require_mapping(value, location=location)
        assert_no_forbidden_flags(descriptor, location=location)
        if descriptor.get("expected_size_px") != [224, 224]:
            raise CatalogAssetError(f"{location}: expected_size_px must be 224x224")
        catalog_id = require_id(
            descriptor.get("catalog_id"), location=f"{location}.catalog_id"
        )
        root = self._catalog_root(catalog_id, location=location)
        status = require_text(descriptor.get("status"), location=f"{location}.status")
        if status == "available":
            return self._resolve_available(
                descriptor,
                sample_id=sample_id,
                view_name=view_name,
                catalog_id=catalog_id,
                root=root,
                location=location,
            )
        if status == "derivable" and view_name == "raw_224":
            return self._resolve_derivable_raw(
                descriptor,
                sample_id=sample_id,
                catalog_id=catalog_id,
                root=root,
                location=location,
            )
        raise CatalogAssetError(
            f"{location}: training view must be available or derivable raw_224"
        )

    def _resolve_available(
        self,
        descriptor: Mapping[str, Any],
        *,
        sample_id: str,
        view_name: str,
        catalog_id: str,
        root: Path,
        location: str,
    ) -> ResolvedImageAsset:
        if descriptor.get("reason") is not None:
            raise CatalogAssetError(f"{location}: available view has a reason")
        if descriptor.get("hash_scope") != "file_bytes":
            raise CatalogAssetError(f"{location}: hash_scope must be file_bytes")
        relative = safe_relative_path(
            descriptor.get("path"), location=f"{location}.path"
        )
        expected_sha = require_sha256(
            descriptor.get("file_sha256"), location=f"{location}.file_sha256"
        )
        physical = resolve_inside(root, relative, location=f"{location}.path")
        payload = _read_bytes(physical, location=location)
        actual_sha = sha256_bytes(payload)
        if actual_sha != expected_sha:
            raise CatalogAssetError(f"{location}: file hash mismatch")
        decoded, decoded_mode, decoded_size = _decode_image_bytes(
            payload, location=location
        )
        if decoded_size != (224, 224):
            decoded.close()
            raise CatalogAssetError(
                f"{location}: decoded size is {decoded_size}, expected (224, 224)"
            )
        declared_mode = descriptor.get("declared_mode")
        if declared_mode is not None and declared_mode != decoded_mode:
            decoded.close()
            raise CatalogAssetError(
                f"{location}: decoded mode {decoded_mode!r} differs from declared_mode"
            )
        if decoded_mode != "RGB":
            decoded.close()
            raise CatalogAssetError(
                f"{location}: trainer view mode must be RGB, found {decoded_mode!r}"
            )
        return ResolvedImageAsset(
            sample_id=sample_id,
            view_name=view_name,
            catalog_id=catalog_id,
            status="available",
            physical_path=physical,
            source_file_sha256=actual_sha,
            source_byte_size=len(payload),
            pixel_sha256=pixel_sha256(decoded),
            image=decoded,
            materialized=False,
        )

    def _resolve_derivable_raw(
        self,
        descriptor: Mapping[str, Any],
        *,
        sample_id: str,
        catalog_id: str,
        root: Path,
        location: str,
    ) -> ResolvedImageAsset:
        if (
            descriptor.get("path") is not None
            or descriptor.get("file_sha256") is not None
        ):
            raise CatalogAssetError(
                f"{location}: derivable view must have null path and hash"
            )
        require_text(descriptor.get("reason"), location=f"{location}.reason")
        recipe = require_mapping(
            descriptor.get("materialization_recipe"),
            location=f"{location}.materialization_recipe",
        )
        if dict(recipe) != dict(RAW_224_RECIPE):
            raise CatalogAssetError(
                f"{location}: invalid raw_224 materialization recipe"
            )
        native = require_mapping(
            descriptor.get("source_native"), location=f"{location}.source_native"
        )
        assert_no_forbidden_flags(native, location=f"{location}.source_native")
        if native.get("status") != "available":
            raise CatalogAssetError(f"{location}: native source is not available")
        if native.get("catalog_id") != catalog_id:
            raise CatalogAssetError(f"{location}: native source catalog mismatch")
        if native.get("hash_scope") != "file_bytes":
            raise CatalogAssetError(f"{location}: native hash_scope must be file_bytes")
        relative = safe_relative_path(
            native.get("path"), location=f"{location}.source_native.path"
        )
        expected_sha = require_sha256(
            native.get("file_sha256"),
            location=f"{location}.source_native.file_sha256",
        )
        physical = resolve_inside(
            root, relative, location=f"{location}.source_native.path"
        )
        payload = _read_bytes(physical, location=location)
        actual_sha = sha256_bytes(payload)
        if actual_sha != expected_sha:
            raise CatalogAssetError(f"{location}: native source hash mismatch")
        decoded, decoded_mode, decoded_size = _decode_image_bytes(
            payload, location=f"{location}.source_native"
        )
        declared_size = native.get("declared_size_px")
        if declared_size is not None and declared_size != list(decoded_size):
            decoded.close()
            raise CatalogAssetError(f"{location}: native source size drifted")
        declared_mode = native.get("declared_mode")
        if declared_mode is not None and declared_mode != decoded_mode:
            decoded.close()
            raise CatalogAssetError(f"{location}: native source mode drifted")
        materialized = letterbox_raw_224(decoded)
        decoded.close()
        if materialized.mode != "RGB" or materialized.size != (224, 224):
            materialized.close()
            raise CatalogAssetError(f"{location}: raw_224 materialization failed")
        return ResolvedImageAsset(
            sample_id=sample_id,
            view_name="raw_224",
            catalog_id=catalog_id,
            status="derivable",
            physical_path=physical,
            source_file_sha256=actual_sha,
            source_byte_size=len(payload),
            pixel_sha256=pixel_sha256(materialized),
            image=materialized,
            materialized=True,
        )


def _artifact_descriptor(manifest: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    artifacts = require_mapping(
        manifest.get("artifacts"), location="training export manifest.artifacts"
    )
    descriptor = require_mapping(
        artifacts.get(name), location=f"training export manifest.artifacts.{name}"
    )
    if descriptor.get("file") != name:
        raise CatalogAssetError(f"training export artifact {name} has wrong file name")
    return descriptor


def _require_nonnegative_int(value: Any, *, location: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise CatalogAssetError(f"{location}: expected a non-negative integer")
    return value


def load_training_export(
    export_dir: Path | str,
    *,
    catalog_registry_sha256: str,
    render_bank_manifest_sha256: str,
    render_specification_sha256: str,
) -> TrainingExportSnapshot:
    raw_root = Path(export_dir).expanduser()
    if raw_root.exists() and raw_root.is_symlink():
        raise CatalogAssetError("training export root must not be a symlink")
    root = raw_root.resolve()
    if not root.is_dir():
        raise CatalogAssetError(f"training export is not a directory: {root}")
    marker_path = root / ".font-matching-training-export-owned.json"
    manifest_path = root / "manifest.json"
    report_path = root / "report.json"
    samples_path = root / "samples.jsonl"
    for path in (marker_path, manifest_path, report_path, samples_path):
        if path.parent != root or not path.is_file():
            raise CatalogAssetError(f"missing training export file: {path.name}")
    marker = read_json(marker_path, location="training export marker")
    manifest = read_json(manifest_path, location="training export manifest")
    report = read_json(report_path, location="training export report")
    marker_sha = sha256_file(marker_path)
    manifest_sha = sha256_file(manifest_path)
    report_sha = sha256_file(report_path)
    if (
        marker.get("owner") != TRAINING_EXPORT_OWNER
        or marker.get("schema_version") != TRAINING_EXPORT_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise CatalogAssetError("training export ownership marker is invalid")
    if (
        marker.get("manifest_sha256") != manifest_sha
        or marker.get("report_sha256") != report_sha
        or report.get("manifest_sha256") != manifest_sha
    ):
        raise CatalogAssetError("training export metadata hash binding failed")
    if manifest.get("schema_version") != TRAINING_EXPORT_SCHEMA_VERSION:
        raise CatalogAssetError("training export manifest schema is unsupported")
    if report.get("schema_version") != TRAINING_EXPORT_REPORT_SCHEMA_VERSION:
        raise CatalogAssetError("training export report schema is unsupported")

    registry_binding = require_mapping(
        manifest.get("registry_exclusions"),
        location="training export manifest.registry_exclusions",
    )
    report_registry_binding = require_mapping(
        report.get("registry_exclusions"),
        location="training export report.registry_exclusions",
    )
    registry_common_fields = (
        "catalog_registry_sha256",
        "excluded_final_count",
        "excluded_final_ids_sha256",
        "ids_digest_algorithm",
    )
    if registry_binding.get("catalog_registry_sha256") != catalog_registry_sha256:
        raise CatalogAssetError("training export is bound to another catalog registry")
    _require_nonnegative_int(
        registry_binding.get("excluded_final_count"),
        location="training export registry_exclusions.excluded_final_count",
    )
    require_sha256(
        registry_binding.get("excluded_final_ids_sha256"),
        location="training export registry_exclusions.excluded_final_ids_sha256",
    )
    if registry_binding.get("ids_digest_algorithm") != "sha256-sorted-lf-utf8-v1":
        raise CatalogAssetError("training export exclusion digest algorithm drifted")
    if any(
        report_registry_binding.get(key) != registry_binding.get(key)
        for key in registry_common_fields
    ):
        raise CatalogAssetError("training export registry exclusion report drifted")
    parent_workspace_projection = report_registry_binding.get(
        "parent_workspace_projection"
    )
    if not isinstance(parent_workspace_projection, bool):
        raise CatalogAssetError(
            "training export report parent_workspace_projection must be boolean"
        )
    expected_registry_mode = (
        "registry_parent_workspace_projection"
        if parent_workspace_projection
        else "registry_current_master"
    )
    if (
        nested(manifest, "master_registry_binding", "mode") != expected_registry_mode
        or nested(report, "summary", "migration_mode") != expected_registry_mode
    ):
        raise CatalogAssetError("training export registry projection mode drifted")

    source_contract = require_mapping(
        nested(manifest, "contracts", "source_inputs"),
        location="training export contracts.source_inputs",
    )
    if source_contract.get(
        "review_card_pixels_allowed"
    ) is not False or source_contract.get("required_views") != list(VIEW_NAMES):
        raise CatalogAssetError("training export source-input contract is unsafe")
    isolation = require_mapping(
        nested(manifest, "contracts", "augmentation_isolation"),
        location="training export contracts.augmentation_isolation",
    )
    evaluation = require_mapping(
        nested(manifest, "contracts", "evaluation"),
        location="training export contracts.evaluation",
    )
    if (
        isolation.get("core_files_accept_synthetic") is not False
        or isolation.get("evaluation_splits_accept_generated") is not False
        or evaluation.get("generated_examples_allowed") is not False
        or evaluation.get("qa_overlay_examples_allowed") is not False
    ):
        raise CatalogAssetError(
            "training export synthetic/evaluation isolation is unsafe"
        )
    checks = require_mapping(
        report.get("checks"), location="training export report.checks"
    )
    for key in (
        "core_qa_overlay_count",
        "core_synthetic_count",
        "generated_evaluation_count",
    ):
        if checks.get(key) != 0:
            raise CatalogAssetError(f"training export report {key} must be zero")

    samples, samples_payload = read_jsonl(samples_path, location="samples.jsonl")
    if not samples:
        raise CatalogAssetError("samples.jsonl is empty")
    descriptor = _artifact_descriptor(manifest, "samples.jsonl")
    samples_sha = sha256_bytes(samples_payload)
    if (
        require_sha256(
            descriptor.get("sha256"),
            location="manifest.artifacts.samples.jsonl.sha256",
        )
        != samples_sha
        or _require_nonnegative_int(
            descriptor.get("byte_size"),
            location="manifest.artifacts.samples.jsonl.byte_size",
        )
        != len(samples_payload)
        or _require_nonnegative_int(
            descriptor.get("record_count"),
            location="manifest.artifacts.samples.jsonl.record_count",
        )
        != len(samples)
    ):
        raise CatalogAssetError("samples.jsonl artifact binding failed")
    report_outputs = require_mapping(
        report.get("outputs"), location="training export report.outputs"
    )
    if report_outputs.get("samples.jsonl") != descriptor:
        raise CatalogAssetError("training export report samples descriptor drifted")
    if manifest.get("real_sample_count") != len(samples):
        raise CatalogAssetError("training export real_sample_count drifted")
    candidate_count = _require_nonnegative_int(
        manifest.get("candidate_count"), location="training export candidate_count"
    )
    renderer_bindings = require_mapping(
        manifest.get("renderer_bindings"),
        location="training export renderer_bindings",
    )
    if (
        renderer_bindings.get("render_bank_manifest_sha256")
        != render_bank_manifest_sha256
        or renderer_bindings.get("render_specification_sha256")
        != render_specification_sha256
    ):
        raise CatalogAssetError("training export is bound to another render bank")
    return TrainingExportSnapshot(
        root=root,
        marker_sha256=marker_sha,
        manifest_sha256=manifest_sha,
        report_sha256=report_sha,
        samples_sha256=samples_sha,
        manifest=manifest,
        samples=samples,
        candidate_count=candidate_count,
    )


def _validate_render_artifact(
    render: Mapping[str, Any],
    *,
    bank_root: Path,
    location: str,
) -> dict[str, Any]:
    assert_no_forbidden_flags(render, location=location)
    artifact = require_mapping(render.get("artifact"), location=f"{location}.artifact")
    if artifact.get("qa_overlay") is not False:
        raise CatalogAssetError(f"{location}: render artifact is not overlay-free")
    relative = safe_relative_path(
        artifact.get("file"), location=f"{location}.artifact.file"
    )
    if render.get("image_file") != relative:
        raise CatalogAssetError(f"{location}: image_file/artifact.file mismatch")
    physical = resolve_inside(bank_root, relative, location=f"{location}.artifact.file")
    payload = _read_bytes(physical, location=location)
    expected_sha = require_sha256(
        artifact.get("sha256"), location=f"{location}.artifact.sha256"
    )
    if sha256_bytes(payload) != expected_sha:
        raise CatalogAssetError(f"{location}: render artifact hash mismatch")
    byte_size = _require_nonnegative_int(
        artifact.get("byte_size"), location=f"{location}.artifact.byte_size"
    )
    if byte_size != len(payload):
        raise CatalogAssetError(f"{location}: render artifact byte size mismatch")
    image, mode, size = _decode_image_bytes(payload, location=location)
    decoded_pixel_sha = pixel_sha256(image)
    image.close()
    if mode != "RGB":
        raise CatalogAssetError(f"{location}: render prototype mode must be RGB")
    declared_size = (
        _require_nonnegative_int(
            artifact.get("width"), location=f"{location}.artifact.width"
        ),
        _require_nonnegative_int(
            artifact.get("height"), location=f"{location}.artifact.height"
        ),
    )
    if 0 in declared_size or size != declared_size:
        raise CatalogAssetError(f"{location}: render artifact dimensions mismatch")
    canvas = require_mapping(render.get("canvas"), location=f"{location}.canvas")
    pixels = require_mapping(render.get("pixels"), location=f"{location}.pixels")
    if (
        [canvas.get("width"), canvas.get("height")] != list(size)
        or [pixels.get("width"), pixels.get("height")] != list(size)
        or pixels.get("qa_overlay") is not False
    ):
        raise CatalogAssetError(f"{location}: render pixel/canvas contract drifted")
    readiness = require_mapping(
        render.get("readiness"), location=f"{location}.readiness"
    )
    required_ready = (
        "content_fits",
        "document_fonts_ready",
        "font_check_passed",
        "production_font_check_passed",
    )
    if any(readiness.get(key) is not True for key in required_ready):
        raise CatalogAssetError(f"{location}: render is not font-ready")
    for key in ("matching_face_count", "requested_face_loaded_count"):
        value = readiness.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise CatalogAssetError(f"{location}: {key} must be positive")
    statuses = readiness.get("matching_face_statuses")
    if (
        not isinstance(statuses, list)
        or not statuses
        or any(status != "loaded" for status in statuses)
    ):
        raise CatalogAssetError(f"{location}: matching font faces are not loaded")
    fallback = require_mapping(
        render.get("fallback_detection"),
        location=f"{location}.fallback_detection",
    )
    if fallback.get("status") != "passed":
        raise CatalogAssetError(f"{location}: fallback detection did not pass")
    if render.get("font_weight") != 400 or render.get("font_style") != "normal":
        raise CatalogAssetError(f"{location}: prototype is not production 400 normal")
    writing_mode = require_text(
        render.get("writing_mode"), location=f"{location}.writing_mode"
    )
    if writing_mode not in {"horizontal", "vertical"}:
        raise CatalogAssetError(f"{location}: unsupported writing mode")
    return {
        "artifact_byte_size": byte_size,
        "artifact_sha256": expected_sha,
        "image_file": relative,
        "mode": mode,
        "pixel_sha256": decoded_pixel_sha,
        "probe_id": require_id(render.get("probe_id"), location=f"{location}.probe_id"),
        "render_id": require_id(
            render.get("render_id"), location=f"{location}.render_id"
        ),
        "size_px": list(size),
        "writing_mode": writing_mode,
    }


def load_render_bank(path_value: Path | str) -> RenderBankSnapshot:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise CatalogAssetError(f"missing render-bank manifest: {path}")
    document = read_json(path, location="render bank")
    manifest_sha = sha256_file(path)
    if document.get("schema_version") != RENDER_BANK_SCHEMA_VERSION:
        raise CatalogAssetError("render-bank schema is unsupported")
    if document.get("deterministic_specification") is not True:
        raise CatalogAssetError("render bank is not deterministic")
    specification_sha = require_sha256(
        document.get("specification_sha256"),
        location="render_bank.specification_sha256",
    )
    source_contract = require_mapping(
        document.get("source_contract"), location="render_bank.source_contract"
    )
    if source_contract.get("schema_version") != "font-face-manifest-v1":
        raise CatalogAssetError("render-bank font source schema is unsupported")
    require_sha256(
        source_contract.get("manifest_sha256"),
        location="render_bank.source_contract.manifest_sha256",
    )
    render_spec = require_mapping(
        document.get("render_spec"), location="render_bank.render_spec"
    )
    if (
        render_spec.get("qa_overlay") is not False
        or render_spec.get("capture_format") != "png"
        or render_spec.get("device_scale_factor") != 1
    ):
        raise CatalogAssetError("render-bank pixel specification is unsafe")
    generation = require_mapping(
        document.get("generation"), location="render_bank.generation"
    )
    if (
        generation.get("partial") is not False
        or generation.get("complete_against_production_assets") is not True
        or generation.get("production_asset_omitted_render_count") != 0
    ):
        raise CatalogAssetError("render bank is partial or omits production assets")
    candidates = require_list(
        document.get("candidates"), location="render_bank.candidates"
    )
    renders = require_list(document.get("renders"), location="render_bank.renders")
    if not candidates or not renders:
        raise CatalogAssetError("render bank candidates/renders are empty")
    all_candidates: dict[str, Mapping[str, Any]] = {}
    canonical_candidates: dict[str, Mapping[str, Any]] = {}
    aliases: set[str] = set()
    font_ids: set[str] = set()
    for index, raw_candidate in enumerate(candidates):
        location = f"render_bank.candidates[{index}]"
        candidate = require_mapping(raw_candidate, location=location)
        display_id = require_text(
            candidate.get("display_id"), location=f"{location}.display_id"
        )
        if display_id in all_candidates:
            raise CatalogAssetError("render-bank candidate display ID is duplicated")
        all_candidates[display_id] = candidate
        if candidate.get("production_400_normal_canonical") is not True:
            continue
        assert_no_forbidden_flags(candidate, location=location)
        font_id = require_id(candidate.get("font_id"), location=f"{location}.font_id")
        alias = require_id(
            candidate.get("blind_alias"), location=f"{location}.blind_alias"
        )
        if (
            display_id in canonical_candidates
            or font_id in font_ids
            or alias in aliases
        ):
            raise CatalogAssetError(
                "render-bank canonical candidate identity is duplicated"
            )
        font_ids.add(font_id)
        aliases.add(alias)
        status = require_mapping(
            candidate.get("production_asset_status"),
            location=f"{location}.production_asset_status",
        )
        if (
            status.get("code") != "passed"
            or status.get("chromium_ots_compatible") is not True
            or candidate.get("probe_coverage_complete") is not True
            or candidate.get("missing_probe_codepoints") != []
            or candidate.get("render_weight") != 400
            or candidate.get("render_style") != "normal"
        ):
            raise CatalogAssetError(f"{location}: candidate is not font-ready")
        require_sha256(
            candidate.get("source_sha256"), location=f"{location}.source_sha256"
        )
        allowed_modes = candidate.get("allowed_writing_modes")
        if (
            not isinstance(allowed_modes, list)
            or not allowed_modes
            or len(allowed_modes) != len(set(allowed_modes))
            or any(mode not in {"horizontal", "vertical"} for mode in allowed_modes)
        ):
            raise CatalogAssetError(f"{location}: allowed writing modes are invalid")
        canonical_candidates[display_id] = candidate
    if not canonical_candidates:
        raise CatalogAssetError("render bank has no real canonical candidates")
    declared_candidate_count = _require_nonnegative_int(
        document.get("candidate_count"), location="render_bank.candidate_count"
    )
    if declared_candidate_count != len(candidates):
        raise CatalogAssetError("render-bank candidate_count drifted")

    renders_by_display: dict[str, list[Mapping[str, Any]]] = {
        display_id: [] for display_id in canonical_candidates
    }
    rendered_display_ids: set[str] = set()
    for index, raw_render in enumerate(renders):
        render = require_mapping(raw_render, location=f"render_bank.renders[{index}]")
        display_id = require_text(
            render.get("candidate_display_id"),
            location=f"render_bank.renders[{index}].candidate_display_id",
        )
        if display_id not in all_candidates:
            raise CatalogAssetError(f"render_bank.renders[{index}]: unknown candidate")
        rendered_display_ids.add(display_id)
        if display_id in renders_by_display:
            renders_by_display[display_id].append(render)
    expected_render_count = _require_nonnegative_int(
        generation.get("expected_render_count"),
        location="render_bank.generation.expected_render_count",
    )
    if (
        expected_render_count != len(renders)
        or generation.get("full_render_count") != len(renders)
        or generation.get("rendered_count") != len(renders)
    ):
        raise CatalogAssetError("render-bank generation counts drifted")

    evidence: list[Mapping[str, Any]] = []
    render_ids: set[str] = set()
    for display_id in sorted(canonical_candidates):
        candidate = canonical_candidates[display_id]
        candidate_renders = renders_by_display[display_id]
        if not candidate_renders:
            raise CatalogAssetError(
                f"candidate {display_id!r} has no render prototypes"
            )
        allowed_modes = set(candidate["allowed_writing_modes"])
        for render_index, render in enumerate(
            sorted(
                candidate_renders,
                key=lambda value: (
                    str(value.get("writing_mode")),
                    str(value.get("probe_id")),
                    str(value.get("render_id")),
                ),
            )
        ):
            location = f"candidate[{display_id}].renders[{render_index}]"
            if render.get("blind_alias") != candidate.get("blind_alias"):
                raise CatalogAssetError(f"{location}: blind alias drifted")
            if render.get("source_file") != candidate.get("source_file"):
                raise CatalogAssetError(f"{location}: source font path drifted")
            artifact_evidence = _validate_render_artifact(
                render, bank_root=path.parent, location=location
            )
            render_id = str(artifact_evidence["render_id"])
            if render_id in render_ids:
                raise CatalogAssetError(f"duplicate render ID {render_id!r}")
            render_ids.add(render_id)
            if artifact_evidence["writing_mode"] not in allowed_modes:
                raise CatalogAssetError(f"{location}: forbidden writing mode")
            evidence.append(
                {
                    "blind_alias": candidate["blind_alias"],
                    "candidate_display_id": display_id,
                    "font_id": candidate["font_id"],
                    "source_font_sha256": candidate["source_sha256"],
                    **artifact_evidence,
                }
            )
    rendered_candidate_count = _require_nonnegative_int(
        document.get("rendered_candidate_count"),
        location="render_bank.rendered_candidate_count",
    )
    if rendered_candidate_count != len(
        rendered_display_ids
    ) or rendered_display_ids != set(all_candidates):
        raise CatalogAssetError("rendered_candidate_count drifted")
    return RenderBankSnapshot(
        manifest_path=path,
        manifest_sha256=manifest_sha,
        specification_sha256=specification_sha,
        candidate_ids=tuple(sorted(font_ids)),
        prototype_evidence=tuple(
            sorted(
                evidence,
                key=lambda row: (
                    str(row["font_id"]),
                    str(row["writing_mode"]),
                    str(row["probe_id"]),
                    str(row["render_id"]),
                ),
            )
        ),
    )


def _records_sha256(records: Sequence[Mapping[str, Any]]) -> str:
    payload = "".join(canonical_json(record) + "\n" for record in records)
    return sha256_bytes(payload.encode("utf-8"))


def validate_training_asset_bundle(
    *,
    catalog_registry: Path | str,
    training_export_dir: Path | str,
    render_bank_manifest: Path | str,
) -> dict[str, Any]:
    resolver = CatalogAssetResolver(catalog_registry)
    render_bank = load_render_bank(render_bank_manifest)
    export = load_training_export(
        training_export_dir,
        catalog_registry_sha256=resolver.registry_sha256,
        render_bank_manifest_sha256=render_bank.manifest_sha256,
        render_specification_sha256=render_bank.specification_sha256,
    )
    if export.candidate_count != len(render_bank.candidate_ids):
        raise CatalogAssetError(
            "training export candidate count differs from render bank"
        )

    sample_ids: set[str] = set()
    example_ids: set[str] = set()
    view_evidence: list[Mapping[str, Any]] = []
    status_counts: dict[str, int] = {"available": 0, "derivable": 0}
    split_counts: dict[str, int] = {split: 0 for split in sorted(VALID_SPLITS)}
    total_view_source_bytes = 0
    for index, sample in enumerate(export.samples, 1):
        location = f"samples[{index}]"
        validate_record_seal(sample, location=location)
        if sample.get("schema_version") != TRAINING_SAMPLE_SCHEMA_VERSION:
            raise CatalogAssetError(f"{location}: sample schema is unsupported")
        assert_no_forbidden_flags(sample, location=location)
        sample_id = require_id(
            sample.get("sample_id"), location=f"{location}.sample_id"
        )
        example_id = require_id(
            sample.get("example_id"), location=f"{location}.example_id"
        )
        if sample_id in sample_ids or example_id in example_ids:
            raise CatalogAssetError(f"{location}: duplicate sample/example identity")
        sample_ids.add(sample_id)
        example_ids.add(example_id)
        split = require_text(sample.get("split"), location=f"{location}.split")
        if split not in VALID_SPLITS:
            raise CatalogAssetError(f"{location}: unsupported split")
        split_counts[split] += 1
        provenance = require_mapping(
            sample.get("provenance"), location=f"{location}.provenance"
        )
        if (
            provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
        ):
            raise CatalogAssetError(f"{location}: sample is not real and overlay-free")
        source_catalog_id = require_id(
            provenance.get("source_catalog_id"),
            location=f"{location}.provenance.source_catalog_id",
        )
        if source_catalog_id not in resolver.catalog_roots:
            raise CatalogAssetError(f"{location}: provenance names an unknown catalog")
        if sample.get("evaluation_eligible") is False:
            raise CatalogAssetError(f"{location}: evaluation-ineligible sample")
        input_bindings = require_mapping(
            sample.get("input_bindings"), location=f"{location}.input_bindings"
        )
        if input_bindings.get("catalog_registry_sha256") != resolver.registry_sha256:
            raise CatalogAssetError(f"{location}: sample uses another catalog registry")
        if (
            input_bindings.get("render_bank_manifest_sha256")
            != render_bank.manifest_sha256
            or input_bindings.get("render_specification_sha256")
            != render_bank.specification_sha256
        ):
            raise CatalogAssetError(f"{location}: sample uses another render bank")
        source = require_mapping(sample.get("source"), location=f"{location}.source")
        views = require_mapping(
            source.get("views"), location=f"{location}.source.views"
        )
        if set(views) != set(VIEW_NAMES):
            raise CatalogAssetError(
                f"{location}: sample must contain exactly three views"
            )
        for view_name in VIEW_NAMES:
            descriptor = require_mapping(
                views[view_name], location=f"{location}.source.views.{view_name}"
            )
            if descriptor.get("catalog_id") != source_catalog_id:
                raise CatalogAssetError(
                    f"{location}: {view_name} differs from provenance catalog"
                )
            with resolver.resolve_sample_view(sample, view_name) as resolved:
                evidence = resolved.evidence()
                view_evidence.append(evidence)
                status_counts[resolved.status] += 1
                total_view_source_bytes += resolved.source_byte_size

    ordered_view_evidence = tuple(
        sorted(
            view_evidence,
            key=lambda row: (str(row["sample_id"]), str(row["view_name"])),
        )
    )
    ordered_prototype_evidence = render_bank.prototype_evidence
    catalog_rows = [
        {
            "catalog_id": catalog_id,
            "manifest_sha256": resolver.catalog_manifest_sha256[catalog_id],
        }
        for catalog_id in sorted(resolver.catalog_roots)
    ]
    core = {
        "schema_version": SCHEMA_VERSION,
        "record_type": RECORD_TYPE,
        "inputs": {
            "catalog_registry": {
                "record_sha256": resolver.registry_record_sha256,
                "sha256": resolver.registry_sha256,
            },
            "catalogs": catalog_rows,
            "render_bank": {
                "manifest_sha256": render_bank.manifest_sha256,
                "specification_sha256": render_bank.specification_sha256,
            },
            "training_export": {
                "manifest_sha256": export.manifest_sha256,
                "marker_sha256": export.marker_sha256,
                "report_sha256": export.report_sha256,
                "samples_sha256": export.samples_sha256,
            },
        },
        "counts": {
            "catalogs": len(catalog_rows),
            "font_candidates": len(render_bank.candidate_ids),
            "render_prototypes": len(ordered_prototype_evidence),
            "samples": len(export.samples),
            "samples_by_split": split_counts,
            "view_source_bytes_verified": total_view_source_bytes,
            "views": len(ordered_view_evidence),
            "views_by_status": status_counts,
        },
        "evidence_sha256": {
            "ordered_sample_ids": sha256_bytes(
                ("\n".join(sorted(sample_ids)) + "\n").encode("utf-8")
            ),
            "render_prototypes": _records_sha256(ordered_prototype_evidence),
            "resolved_views": _records_sha256(ordered_view_evidence),
        },
        "checks": {
            "all_images_decoded": True,
            "all_model_views_rgb_224": True,
            "all_render_prototypes_font_ready": True,
            "catalog_roots_registry_bound": True,
            "evaluation_ineligible_inputs": 0,
            "qa_overlay_inputs": 0,
            "synthetic_inputs": 0,
        },
    }
    return seal_record(core)


__all__ = [
    "CatalogAssetError",
    "CatalogAssetResolver",
    "RAW_224_RECIPE",
    "ResolvedImageAsset",
    "ResolvedRenderPrototype",
    "RenderBankSnapshot",
    "canonical_json",
    "json_bytes",
    "letterbox_raw_224",
    "load_render_bank",
    "load_training_export",
    "pixel_sha256",
    "seal_record",
    "validate_training_asset_bundle",
]
