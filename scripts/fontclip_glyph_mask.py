#!/usr/bin/env python3
"""Comic-text segmentation helpers for building FontCLIP training crops.

The bundled ``comic-text-detector.onnx`` has three outputs, but this module only
requests its full-resolution ``seg`` output.  A page is therefore inferred once
and any number of OCR AABBs can subsequently be sampled from
:class:`ComicTextPageMask`.

The module deliberately keeps third-party imports optional.  Importing it never
fails merely because the OCR Python environment is incomplete; inspect
``ComicTextMasker.available`` / ``unavailable_reason`` before inference.

Coordinates are half-open pixel AABBs: ``(x1, y1, x2, y2)``.  The returned
``tight_bbox`` uses the same page coordinate system.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

try:
    import numpy as np
except Exception as exc:  # pragma: no cover - exercised only in broken runtimes
    np = None  # type: ignore[assignment]
    _NUMPY_IMPORT_ERROR: Exception | None = exc
else:
    _NUMPY_IMPORT_ERROR = None

try:
    import cv2
except Exception as exc:  # pragma: no cover - exercised only in broken runtimes
    cv2 = None  # type: ignore[assignment]
    _CV2_IMPORT_ERROR: Exception | None = exc
else:
    _CV2_IMPORT_ERROR = None

try:
    import onnxruntime as ort
except Exception as exc:  # pragma: no cover - exercised only in broken runtimes
    ort = None  # type: ignore[assignment]
    _ORT_IMPORT_ERROR: Exception | None = exc
else:
    _ORT_IMPORT_ERROR = None

try:
    from PIL import Image, ImageOps
except Exception as exc:  # Pillow is optional for ndarray-only callers
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]
    _PIL_IMPORT_ERROR: Exception | None = exc
else:
    _PIL_IMPORT_ERROR = None


BBox = tuple[int, int, int, int]

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_PATH = (
    REPO_ROOT / "models" / "detectors" / "comic-text-detector.onnx"
)
DEFAULT_CONFIG_PATH = (
    REPO_ROOT
    / "models"
    / "detectors"
    / "comic-text-and-bubble-detector.config.json"
)
DEFAULT_PREPROCESSOR_PATH = (
    REPO_ROOT
    / "models"
    / "detectors"
    / "comic-text-and-bubble-detector.preprocessor.json"
)

# This identifies the manga-image-translator CTD CPU model.  Hash verification is
# optional because some callers may intentionally pass a compatible re-export.
EXPECTED_MODEL_SHA256 = (
    "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f"
)

__all__ = [
    "BBox",
    "ComicTextMaskError",
    "ComicTextMaskUnavailableError",
    "InvalidBBoxError",
    "MaskerAvailability",
    "GlyphMaskStats",
    "GlyphMaskResult",
    "PreprocessTransform",
    "ComicTextPageMask",
    "ComicTextMasker",
]


class ComicTextMaskError(RuntimeError):
    """Base error for glyph-mask extraction."""


class ComicTextMaskUnavailableError(ComicTextMaskError):
    """Raised when inference is requested from an unavailable masker."""


class InvalidBBoxError(ValueError):
    """Raised for a malformed or empty OCR bounding box."""


@dataclass(frozen=True)
class MaskerAvailability:
    """Current availability and verified model information."""

    available: bool
    reason: str | None
    model_path: str
    provider: str | None
    input_name: str | None
    input_size: tuple[int, int] | None
    segmentation_output_name: str | None
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class GlyphMaskStats:
    """Quality statistics measured inside one clipped OCR AABB.

    ``support_*`` describes the raw model support at ``threshold``.
    ``ink_*`` describes pixels remaining after connected-component cleanup.
    ``border_contact_ratio`` is the fraction of retained ink in the border band;
    it is useful for rejecting OCR boxes that cut through neighbouring glyphs.
    """

    crop_width: int
    crop_height: int
    crop_pixels: int
    threshold: float
    min_component_pixels: int
    raw_component_count: int
    kept_component_count: int
    removed_component_count: int
    removed_pixels: int
    support_pixels: int
    support_ratio: float
    ink_pixels: int
    ink_ratio: float
    retained_support_ratio: float
    mean_support_probability: float
    mean_ink_probability: float
    peak_probability: float
    tight_bbox_area_ratio: float
    border_band: int
    border_contact: bool
    border_contact_pixels: int
    border_contact_ratio: float
    border_perimeter_coverage: float
    border_contact_sides: tuple[str, ...]


@dataclass(frozen=True)
class GlyphMaskResult:
    """A cleaned glyph mask and tight, transparent source-glyph crop.

    Array layout:

    * ``probability_mask``: float32 ``H x W`` over the clipped OCR AABB.
    * ``binary_mask``: uint8 ``H x W`` (0 or 255), after component cleanup.
    * ``tight_mask``: uint8 mask cropped to ``tight_bbox_local``.
    * ``rgba``: uint8 ``h x w x 4`` source pixels with ``tight_mask`` as alpha.
    """

    requested_bbox: tuple[float, float, float, float]
    ocr_bbox: BBox
    tight_bbox_local: BBox | None
    tight_bbox: BBox | None
    probability_mask: Any = field(repr=False)
    binary_mask: Any = field(repr=False)
    tight_mask: Any = field(repr=False)
    rgba: Any = field(repr=False)
    stats: GlyphMaskStats

    @property
    def empty(self) -> bool:
        return self.tight_bbox is None

    @property
    def mask(self) -> Any:
        """Alias for the cleaned, full-OCR-box ``binary_mask``."""

        return self.binary_mask

    @property
    def glyph_mask(self) -> Any:
        """Alias for the tightly cropped grayscale ``tight_mask``."""

        return self.tight_mask

    @property
    def glyph_rgba(self) -> Any:
        """Alias for the tightly cropped source-glyph ``rgba`` image."""

        return self.rgba

    def metadata(self) -> dict[str, Any]:
        """Return JSON-serializable coordinates and quality statistics."""

        return {
            "requested_bbox": list(self.requested_bbox),
            "ocr_bbox": list(self.ocr_bbox),
            "tight_bbox_local": (
                list(self.tight_bbox_local)
                if self.tight_bbox_local is not None
                else None
            ),
            "tight_bbox": (
                list(self.tight_bbox) if self.tight_bbox is not None else None
            ),
            "empty": self.empty,
            "stats": asdict(self.stats),
        }

    def save(
        self,
        rgba_path: str | Path,
        *,
        mask_path: str | Path | None = None,
        metadata_path: str | Path | None = None,
    ) -> dict[str, str]:
        """Save the tight RGBA glyph, grayscale mask, and optional JSON metadata."""

        if self.empty:
            raise ComicTextMaskError("cannot save an empty glyph mask")

        rgba_target = Path(rgba_path)
        if mask_path is None:
            mask_target = rgba_target.with_name(f"{rgba_target.stem}.mask.png")
        else:
            mask_target = Path(mask_path)
        rgba_target.parent.mkdir(parents=True, exist_ok=True)
        mask_target.parent.mkdir(parents=True, exist_ok=True)
        _save_array_image(rgba_target, self.rgba)
        _save_array_image(mask_target, self.tight_mask)

        outputs = {
            "rgba": str(rgba_target.resolve()),
            "mask": str(mask_target.resolve()),
        }
        if metadata_path is not None:
            metadata_target = Path(metadata_path)
            metadata_target.parent.mkdir(parents=True, exist_ok=True)
            payload = self.metadata()
            payload["outputs"] = outputs
            metadata_target.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            outputs["metadata"] = str(metadata_target.resolve())
        return outputs


@dataclass(frozen=True)
class PreprocessTransform:
    """Geometry used to place the page in the model's top-left letterbox."""

    original_width: int
    original_height: int
    resized_width: int
    resized_height: int
    input_width: int
    input_height: int
    segmentation_width: int
    segmentation_height: int

    @property
    def segmentation_scale_x(self) -> float:
        return (
            self.resized_width
            / self.original_width
            * self.segmentation_width
            / self.input_width
        )

    @property
    def segmentation_scale_y(self) -> float:
        return (
            self.resized_height
            / self.original_height
            * self.segmentation_height
            / self.input_height
        )


@dataclass
class ComicTextPageMask:
    """One page image plus one CTD segmentation inference.

    Call :meth:`extract` repeatedly; it only resamples the stored segmentation
    map and never runs ONNX again.
    """

    image_rgb: Any = field(repr=False)
    segmentation_probability: Any = field(repr=False)
    transform: PreprocessTransform
    source: str | None
    model_path: str
    provider: str
    default_threshold: float = 0.3
    default_min_component_pixels: int = 3
    default_border_band: int = 1

    @property
    def width(self) -> int:
        return self.transform.original_width

    @property
    def height(self) -> int:
        return self.transform.original_height

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)

    def probability_for_bbox(
        self,
        bbox: Sequence[float | int],
        *,
        bbox_format: str = "xyxy",
    ) -> tuple[BBox, tuple[float, float, float, float], Any]:
        """Sample the model probability map at original-page pixel centers."""

        requested, clipped = _normalize_bbox(
            bbox, self.width, self.height, bbox_format=bbox_format
        )
        x1, y1, x2, y2 = clipped
        crop_width = x2 - x1
        crop_height = y2 - y1
        scale_x = self.transform.segmentation_scale_x
        scale_y = self.transform.segmentation_scale_y

        # These center-aligned maps match OpenCV resize semantics while avoiding
        # a potentially huge full-page float32 probability allocation.
        map_x_line = (
            (np.arange(crop_width, dtype=np.float32) + x1 + 0.5) * scale_x
            - 0.5
        )
        map_y_line = (
            (np.arange(crop_height, dtype=np.float32) + y1 + 0.5) * scale_y
            - 0.5
        )
        map_x, map_y = np.meshgrid(map_x_line, map_y_line)
        probability = cv2.remap(
            self.segmentation_probability,
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0.0,
        )
        return clipped, requested, np.ascontiguousarray(
            probability, dtype=np.float32
        )

    def extract(
        self,
        bbox: Sequence[float | int],
        *,
        bbox_format: str = "xyxy",
        threshold: float | None = None,
        min_component_pixels: int | None = None,
        border_band: int | None = None,
    ) -> GlyphMaskResult:
        """Extract an actual-pixel glyph mask from one OCR AABB."""

        effective_threshold = (
            self.default_threshold if threshold is None else float(threshold)
        )
        if not 0.0 <= effective_threshold <= 1.0:
            raise ValueError("threshold must be between 0 and 1")
        effective_min_area = (
            self.default_min_component_pixels
            if min_component_pixels is None
            else int(min_component_pixels)
        )
        if effective_min_area < 1:
            raise ValueError("min_component_pixels must be at least 1")
        effective_border_band = (
            self.default_border_band if border_band is None else int(border_band)
        )
        if effective_border_band < 1:
            raise ValueError("border_band must be at least 1")

        clipped, requested, probability = self.probability_for_bbox(
            bbox, bbox_format=bbox_format
        )
        support = probability >= effective_threshold
        (
            cleaned,
            raw_component_count,
            kept_component_count,
            removed_pixels,
        ) = _remove_small_components(support, effective_min_area)
        mask_u8 = np.ascontiguousarray(cleaned.astype(np.uint8) * 255)
        tight_local = _tight_bbox(cleaned)

        x1, y1, x2, y2 = clipped
        source_crop = self.image_rgb[y1:y2, x1:x2]
        if tight_local is None:
            tight_page = None
            tight_mask = np.zeros((0, 0), dtype=np.uint8)
            rgba = np.zeros((0, 0, 4), dtype=np.uint8)
        else:
            tx1, ty1, tx2, ty2 = tight_local
            tight_page = (x1 + tx1, y1 + ty1, x1 + tx2, y1 + ty2)
            tight_mask = np.ascontiguousarray(mask_u8[ty1:ty2, tx1:tx2])
            tight_rgb = np.ascontiguousarray(source_crop[ty1:ty2, tx1:tx2])
            rgba = np.concatenate((tight_rgb, tight_mask[..., None]), axis=2)
            # Hidden RGB values must not make two visually identical glyphs
            # hash differently.  The mask is binary, so canonical black RGB
            # under fully transparent pixels preserves every visible pixel
            # while making the RGBA representation deterministic.
            rgba[rgba[..., 3] == 0, :3] = 0

        stats = _mask_stats(
            probability=probability,
            support=support,
            cleaned=cleaned,
            threshold=effective_threshold,
            min_component_pixels=effective_min_area,
            raw_component_count=raw_component_count,
            kept_component_count=kept_component_count,
            removed_pixels=removed_pixels,
            tight_bbox_local=tight_local,
            border_band=effective_border_band,
        )
        return GlyphMaskResult(
            requested_bbox=requested,
            ocr_bbox=clipped,
            tight_bbox_local=tight_local,
            tight_bbox=tight_page,
            probability_mask=probability,
            binary_mask=mask_u8,
            tight_mask=tight_mask,
            rgba=np.ascontiguousarray(rgba),
            stats=stats,
        )

    def extract_glyph(
        self,
        bbox: Sequence[float | int],
        **kwargs: Any,
    ) -> GlyphMaskResult:
        """Readable alias for :meth:`extract`."""

        return self.extract(bbox, **kwargs)

    def extract_many(
        self,
        bboxes: Iterable[Sequence[float | int]],
        **kwargs: Any,
    ) -> list[GlyphMaskResult]:
        """Extract multiple OCR boxes without another model invocation."""

        return [self.extract(bbox, **kwargs) for bbox in bboxes]

    def page_probability_mask(self) -> Any:
        """Materialize a full original-resolution probability map for QA only."""

        return cv2.resize(
            self.segmentation_probability[
                : max(
                    1,
                    int(
                        round(
                            self.transform.resized_height
                            * self.transform.segmentation_height
                            / self.transform.input_height
                        )
                    ),
                ),
                : max(
                    1,
                    int(
                        round(
                            self.transform.resized_width
                            * self.transform.segmentation_width
                            / self.transform.input_width
                        )
                    ),
                ),
            ],
            (self.width, self.height),
            interpolation=cv2.INTER_LINEAR,
        ).astype(np.float32, copy=False)


class ComicTextMasker:
    """Loads the CTD ONNX model and performs one segmentation run per page."""

    def __init__(
        self,
        model_path: str | Path = DEFAULT_MODEL_PATH,
        *,
        config_path: str | Path | None = DEFAULT_CONFIG_PATH,
        preprocessor_path: str | Path | None = DEFAULT_PREPROCESSOR_PATH,
        providers: Sequence[str] | None = None,
        threshold: float = 0.3,
        min_component_pixels: int = 3,
        border_band: int = 1,
        verify_model_hash: bool = False,
        eager: bool = True,
        strict: bool = False,
    ) -> None:
        self.model_path = Path(model_path).expanduser().resolve()
        self.config_path = _optional_path(config_path)
        self.preprocessor_path = _optional_path(preprocessor_path)
        self.requested_providers = tuple(providers) if providers else None
        self.threshold = float(threshold)
        self.min_component_pixels = int(min_component_pixels)
        self.border_band = int(border_band)
        self.verify_model_hash = bool(verify_model_hash)

        if not 0.0 <= self.threshold <= 1.0:
            raise ValueError("threshold must be between 0 and 1")
        if self.min_component_pixels < 1:
            raise ValueError("min_component_pixels must be at least 1")
        if self.border_band < 1:
            raise ValueError("border_band must be at least 1")

        self._session: Any = None
        self._input_name: str | None = None
        self._segmentation_output_name: str | None = None
        self._input_width: int | None = None
        self._input_height: int | None = None
        self._provider: str | None = None
        self._unavailable_reason: str | None = None
        self._warnings: list[str] = []
        self._preprocessor: dict[str, Any] = {}
        self._config: dict[str, Any] = {}
        self._run_lock = threading.Lock()
        self.inference_count = 0

        self._check_local_requirements()
        self._load_metadata()
        if eager and self._unavailable_reason is None:
            self.load()
        if strict and not self.available:
            raise ComicTextMaskUnavailableError(
                self.unavailable_reason or "comic text masker is unavailable"
            )

    @property
    def available(self) -> bool:
        """Whether the model session is loaded and its I/O is verified."""

        return self._session is not None and self._unavailable_reason is None

    @property
    def unavailable_reason(self) -> str | None:
        return self._unavailable_reason

    @property
    def warnings(self) -> tuple[str, ...]:
        return tuple(self._warnings)

    @property
    def availability(self) -> MaskerAvailability:
        input_size = None
        if self._input_width is not None and self._input_height is not None:
            input_size = (self._input_width, self._input_height)
        return MaskerAvailability(
            available=self.available,
            reason=self.unavailable_reason,
            model_path=str(self.model_path),
            provider=self._provider,
            input_name=self._input_name,
            input_size=input_size,
            segmentation_output_name=self._segmentation_output_name,
            warnings=self.warnings,
        )

    @property
    def model_info(self) -> dict[str, Any]:
        """JSON-serializable verified model/preprocessing information."""

        return {
            **asdict(self.availability),
            "config_path": (
                str(self.config_path) if self.config_path is not None else None
            ),
            "preprocessor_path": (
                str(self.preprocessor_path)
                if self.preprocessor_path is not None
                else None
            ),
            "preprocessor": self._preprocessor,
            "config_architectures": self._config.get("architectures"),
            "inference_count": self.inference_count,
        }

    def load(self) -> bool:
        """Load and validate ONNX I/O, returning ``False`` instead of crashing."""

        if self.available:
            return True
        if self._unavailable_reason is not None:
            return False
        try:
            if self.verify_model_hash:
                digest = _sha256_file(self.model_path)
                if digest.lower() != EXPECTED_MODEL_SHA256:
                    raise ComicTextMaskError(
                        "comic text detector SHA-256 mismatch: "
                        f"expected {EXPECTED_MODEL_SHA256}, got {digest}"
                    )

            session_options = ort.SessionOptions()
            session_options.log_severity_level = 3
            providers = self._resolve_providers()
            session = ort.InferenceSession(
                str(self.model_path),
                sess_options=session_options,
                providers=providers,
            )
            self._validate_model_io(session)
            self._session = session
            self._provider = session.get_providers()[0]
            self._validate_preprocessor_against_model()
            return True
        except Exception as exc:
            self._session = None
            self._unavailable_reason = (
                f"failed to load comic text detector '{self.model_path}': "
                f"{type(exc).__name__}: {exc}"
            )
            return False

    def infer_page(
        self,
        image: Any,
        *,
        color_order: str = "RGB",
    ) -> ComicTextPageMask:
        """Run CTD once for a page and return a reusable page-mask object."""

        if not self.available and not self.load():
            raise ComicTextMaskUnavailableError(
                self.unavailable_reason or "comic text masker is unavailable"
            )
        image_rgb, source = _load_rgb_image(image, color_order=color_order)
        image_height, image_width = image_rgb.shape[:2]
        tensor, resized_width, resized_height = self._preprocess(image_rgb)

        try:
            with self._run_lock:
                outputs = self._session.run(
                    [self._segmentation_output_name],
                    {self._input_name: tensor},
                )
                self.inference_count += 1
        except Exception as exc:
            raise ComicTextMaskError(
                f"comic text segmentation inference failed: {type(exc).__name__}: {exc}"
            ) from exc

        segmentation = _coerce_segmentation(outputs[0])
        transform = PreprocessTransform(
            original_width=image_width,
            original_height=image_height,
            resized_width=resized_width,
            resized_height=resized_height,
            input_width=int(self._input_width),
            input_height=int(self._input_height),
            segmentation_width=int(segmentation.shape[1]),
            segmentation_height=int(segmentation.shape[0]),
        )
        return ComicTextPageMask(
            image_rgb=image_rgb,
            segmentation_probability=segmentation,
            transform=transform,
            source=source,
            model_path=str(self.model_path),
            provider=str(self._provider),
            default_threshold=self.threshold,
            default_min_component_pixels=self.min_component_pixels,
            default_border_band=self.border_band,
        )

    def prepare_page(
        self,
        image: Any,
        *,
        color_order: str = "RGB",
    ) -> ComicTextPageMask:
        """Alias for :meth:`infer_page` for dataset extractors."""

        return self.infer_page(image, color_order=color_order)

    def extract_many(
        self,
        image: Any,
        bboxes: Iterable[Sequence[float | int]],
        *,
        color_order: str = "RGB",
        **extract_kwargs: Any,
    ) -> list[GlyphMaskResult]:
        """Convenience API that performs exactly one page inference."""

        page = self.infer_page(image, color_order=color_order)
        return page.extract_many(bboxes, **extract_kwargs)

    def _check_local_requirements(self) -> None:
        missing: list[str] = []
        if np is None:
            missing.append(f"numpy ({_NUMPY_IMPORT_ERROR})")
        if cv2 is None:
            missing.append(f"opencv-python ({_CV2_IMPORT_ERROR})")
        if ort is None:
            missing.append(f"onnxruntime ({_ORT_IMPORT_ERROR})")
        if missing:
            self._unavailable_reason = "missing required package(s): " + ", ".join(
                missing
            )
            return
        if not self.model_path.is_file():
            self._unavailable_reason = (
                f"comic text detector model is missing: {self.model_path}"
            )

    def _load_metadata(self) -> None:
        self._config = _read_json_metadata(
            self.config_path, "config", self._warnings
        )
        self._preprocessor = _read_json_metadata(
            self.preprocessor_path, "preprocessor", self._warnings
        )

        # The repository currently stores RT-DETR metadata beside the legacy CTD
        # segmentation model.  Its rescale/normalization fields are compatible,
        # but the fixed ONNX shape must take precedence over its 640x640 size.
        architectures = self._config.get("architectures")
        if architectures and any("RTDetr" in str(item) for item in architectures):
            self._warnings.append(
                "adjacent config describes RT-DETR rather than the CTD multi-head "
                "model; class labels are intentionally ignored"
            )

        if self._preprocessor:
            if self._preprocessor.get("do_rescale", True) is False:
                self._warnings.append(
                    "preprocessor disables rescaling; CTD still requires float "
                    "pixels matching its exported graph"
                )
            if self._preprocessor.get("do_normalize", False):
                self._warnings.append(
                    "preprocessor requests mean/std normalization; it will be "
                    "applied before inference"
                )

    def _resolve_providers(self) -> list[str]:
        available = list(ort.get_available_providers())
        if self.requested_providers:
            missing = [
                provider
                for provider in self.requested_providers
                if provider not in available
            ]
            if missing:
                raise ComicTextMaskUnavailableError(
                    "requested ONNX provider(s) unavailable: "
                    + ", ".join(missing)
                    + "; available: "
                    + ", ".join(available)
                )
            return list(self.requested_providers)
        if "CPUExecutionProvider" in available:
            return ["CPUExecutionProvider"]
        if not available:
            raise ComicTextMaskUnavailableError(
                "onnxruntime reports no execution providers"
            )
        return [available[0]]

    def _validate_model_io(self, session: Any) -> None:
        inputs = session.get_inputs()
        if len(inputs) != 1:
            raise ComicTextMaskError(
                f"expected one model input, found {len(inputs)}"
            )
        model_input = inputs[0]
        shape = tuple(model_input.shape)
        if len(shape) != 4:
            raise ComicTextMaskError(
                f"expected NCHW model input, found shape {shape}"
            )
        if shape[0] not in (1, "1") or shape[1] not in (3, "3"):
            raise ComicTextMaskError(
                f"expected model input [1,3,H,W], found {shape}"
            )
        if model_input.type != "tensor(float)":
            raise ComicTextMaskError(
                f"expected float32 model input, found {model_input.type}"
            )
        try:
            input_height = int(shape[2])
            input_width = int(shape[3])
        except (TypeError, ValueError) as exc:
            raise ComicTextMaskError(
                f"model requires a fixed spatial input, found {shape}"
            ) from exc
        if input_height < 1 or input_width < 1:
            raise ComicTextMaskError(f"invalid model input size {shape[2:]}")

        outputs = session.get_outputs()
        segmentation_output = next(
            (output for output in outputs if output.name == "seg"), None
        )
        if segmentation_output is None:
            candidates = [
                output
                for output in outputs
                if len(tuple(output.shape)) == 4
                and tuple(output.shape)[1] in (1, "1")
            ]
            if len(candidates) != 1:
                names = ", ".join(output.name for output in outputs)
                raise ComicTextMaskError(
                    "could not identify the segmentation output; "
                    f"model outputs: {names}"
                )
            segmentation_output = candidates[0]
            self._warnings.append(
                f"using inferred segmentation output '{segmentation_output.name}'"
            )
        if segmentation_output.type != "tensor(float)":
            raise ComicTextMaskError(
                "expected float segmentation output, found "
                f"{segmentation_output.type}"
            )

        self._input_name = model_input.name
        self._input_height = input_height
        self._input_width = input_width
        self._segmentation_output_name = segmentation_output.name

    def _validate_preprocessor_against_model(self) -> None:
        size = self._preprocessor.get("size")
        if not isinstance(size, Mapping):
            return
        configured_height = size.get("height")
        configured_width = size.get("width")
        if (
            configured_height is not None
            and configured_width is not None
            and (
                int(configured_height) != self._input_height
                or int(configured_width) != self._input_width
            )
        ):
            self._warnings.append(
                "preprocessor size "
                f"{configured_width}x{configured_height} differs from fixed ONNX "
                f"input {self._input_width}x{self._input_height}; fixed model "
                "dimensions take precedence"
            )

    def _preprocess(self, image_rgb: Any) -> tuple[Any, int, int]:
        height, width = image_rgb.shape[:2]
        scale = min(self._input_width / width, self._input_height / height)
        resized_width = max(1, min(self._input_width, int(round(width * scale))))
        resized_height = max(
            1, min(self._input_height, int(round(height * scale)))
        )
        resized = cv2.resize(
            image_rgb,
            (resized_width, resized_height),
            # Both the bundled preprocessor (resample=2) and upstream CTD
            # ``letterbox`` use bilinear resizing, including for downscaling.
            interpolation=cv2.INTER_LINEAR,
        )
        canvas = np.zeros(
            (self._input_height, self._input_width, 3), dtype=np.uint8
        )
        # This top-left placement (padding only on the right/bottom) matches the
        # upstream CTD ``letterbox`` implementation used to export this model.
        canvas[:resized_height, :resized_width] = resized

        tensor = canvas.astype(np.float32)
        if self._preprocessor.get("do_rescale", True):
            tensor *= float(
                self._preprocessor.get("rescale_factor", 1.0 / 255.0)
            )
        else:
            # The verified bundled CTD graph was trained with [0, 1] RGB pixels.
            # Keep this invariant even if unrelated adjacent metadata says false.
            tensor *= 1.0 / 255.0
        if self._preprocessor.get("do_normalize", False):
            mean = np.asarray(
                self._preprocessor.get("image_mean", [0.0, 0.0, 0.0]),
                dtype=np.float32,
            ).reshape(1, 1, 3)
            std = np.asarray(
                self._preprocessor.get("image_std", [1.0, 1.0, 1.0]),
                dtype=np.float32,
            ).reshape(1, 1, 3)
            if np.any(std == 0):
                raise ComicTextMaskError(
                    "preprocessor image_std must not contain zero"
                )
            tensor = (tensor - mean) / std
        tensor = np.ascontiguousarray(
            tensor.transpose(2, 0, 1)[None, ...], dtype=np.float32
        )
        return tensor, resized_width, resized_height


def _optional_path(value: str | Path | None) -> Path | None:
    if value is None:
        return None
    return Path(value).expanduser().resolve()


def _read_json_metadata(
    path: Path | None,
    label: str,
    warnings: list[str],
) -> dict[str, Any]:
    if path is None:
        return {}
    if not path.is_file():
        warnings.append(f"{label} metadata is missing: {path}")
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        warnings.append(
            f"could not read {label} metadata '{path}': {type(exc).__name__}: {exc}"
        )
        return {}
    if not isinstance(payload, dict):
        warnings.append(f"{label} metadata is not a JSON object: {path}")
        return {}
    return payload


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_rgb_image(
    image: Any,
    *,
    color_order: str,
) -> tuple[Any, str | None]:
    if np is None or cv2 is None:
        raise ComicTextMaskUnavailableError(
            "numpy and opencv-python are required to load an image"
        )

    source: str | None = None
    if isinstance(image, (str, Path)):
        path = Path(image).expanduser().resolve()
        source = str(path)
        if not path.is_file():
            raise FileNotFoundError(f"page image is missing: {path}")
        if Image is not None:
            with Image.open(path) as opened:
                rgb = _pil_to_rgb(opened)
        else:
            decoded = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if decoded is None:
                detail = f": {_PIL_IMPORT_ERROR}" if _PIL_IMPORT_ERROR else ""
                raise ComicTextMaskError(f"could not decode image {path}{detail}")
            rgb = _numpy_to_rgb(decoded, color_order="BGR")
    elif Image is not None and isinstance(image, Image.Image):
        rgb = _pil_to_rgb(image)
    elif isinstance(image, np.ndarray):
        rgb = _numpy_to_rgb(image, color_order=color_order)
    else:
        raise TypeError(
            "image must be a filesystem path, PIL.Image.Image, or numpy.ndarray"
        )

    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ComicTextMaskError(f"expected an RGB image, found shape {rgb.shape}")
    if rgb.shape[0] < 1 or rgb.shape[1] < 1:
        raise ComicTextMaskError("page image is empty")
    return np.ascontiguousarray(rgb, dtype=np.uint8), source


def _pil_to_rgb(image: Any) -> Any:
    oriented = ImageOps.exif_transpose(image)
    if oriented.mode in ("RGBA", "LA") or (
        oriented.mode == "P" and "transparency" in oriented.info
    ):
        rgba = oriented.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        oriented = Image.alpha_composite(background, rgba).convert("RGB")
    else:
        oriented = oriented.convert("RGB")
    return np.asarray(oriented, dtype=np.uint8)


def _numpy_to_rgb(array: Any, *, color_order: str) -> Any:
    data = np.asarray(array)
    if data.ndim == 2:
        data = np.repeat(data[..., None], 3, axis=2)
    if data.ndim != 3 or data.shape[2] not in (1, 3, 4):
        raise ComicTextMaskError(
            f"numpy image must be HxW, HxWx1, HxWx3, or HxWx4; got {data.shape}"
        )
    if data.shape[2] == 1:
        data = np.repeat(data, 3, axis=2)
    data = _array_to_uint8(data)

    order = color_order.upper()
    valid_orders = {"RGB", "BGR", "RGBA", "BGRA"}
    if order not in valid_orders:
        raise ValueError(
            f"color_order must be one of {sorted(valid_orders)}, got {color_order!r}"
        )
    if data.shape[2] == 4:
        if order in ("BGR", "RGB"):
            order += "A"
        if order == "BGRA":
            data = data[..., [2, 1, 0, 3]]
        alpha = data[..., 3:4].astype(np.float32) / 255.0
        rgb = np.rint(
            data[..., :3].astype(np.float32) * alpha + 255.0 * (1.0 - alpha)
        ).astype(np.uint8)
        return rgb
    if order in ("RGBA", "BGRA"):
        order = order[:3]
    if order == "BGR":
        data = data[..., ::-1]
    return np.ascontiguousarray(data)


def _array_to_uint8(array: Any) -> Any:
    if array.dtype == np.uint8:
        return array
    if np.issubdtype(array.dtype, np.floating):
        finite = np.nan_to_num(array, nan=0.0, posinf=255.0, neginf=0.0)
        maximum = float(finite.max(initial=0.0))
        if maximum <= 1.0:
            finite = finite * 255.0
        return np.clip(np.rint(finite), 0, 255).astype(np.uint8)
    return np.clip(array, 0, 255).astype(np.uint8)


def _coerce_segmentation(output: Any) -> Any:
    segmentation = np.asarray(output)
    if segmentation.ndim == 4:
        if segmentation.shape[0] != 1 or segmentation.shape[1] != 1:
            raise ComicTextMaskError(
                f"unexpected segmentation shape {segmentation.shape}"
            )
        segmentation = segmentation[0, 0]
    elif segmentation.ndim == 3:
        if segmentation.shape[0] != 1:
            raise ComicTextMaskError(
                f"unexpected segmentation shape {segmentation.shape}"
            )
        segmentation = segmentation[0]
    if segmentation.ndim != 2:
        raise ComicTextMaskError(
            f"expected a 2D segmentation map, found {segmentation.shape}"
        )
    if not np.isfinite(segmentation).all():
        raise ComicTextMaskError("segmentation output contains NaN or infinity")
    minimum = float(segmentation.min(initial=0.0))
    maximum = float(segmentation.max(initial=0.0))
    if minimum < -1e-4 or maximum > 1.0001:
        raise ComicTextMaskError(
            "segmentation output is not a probability map: "
            f"range [{minimum:.6g}, {maximum:.6g}]"
        )
    return np.ascontiguousarray(
        np.clip(segmentation, 0.0, 1.0), dtype=np.float32
    )


def _normalize_bbox(
    bbox: Sequence[float | int],
    image_width: int,
    image_height: int,
    *,
    bbox_format: str,
) -> tuple[tuple[float, float, float, float], BBox]:
    if isinstance(bbox, (str, bytes)) or len(bbox) != 4:
        raise InvalidBBoxError("bbox must contain exactly four finite numbers")
    try:
        values = tuple(float(value) for value in bbox)
    except (TypeError, ValueError) as exc:
        raise InvalidBBoxError("bbox must contain exactly four numbers") from exc
    if not all(math.isfinite(value) for value in values):
        raise InvalidBBoxError("bbox coordinates must be finite")

    normalized_format = bbox_format.lower()
    if normalized_format == "xyxy":
        x1, y1, x2, y2 = values
    elif normalized_format == "xywh":
        x1, y1, width, height = values
        x2, y2 = x1 + width, y1 + height
    else:
        raise InvalidBBoxError("bbox_format must be 'xyxy' or 'xywh'")
    requested = (x1, y1, x2, y2)
    if x2 <= x1 or y2 <= y1:
        raise InvalidBBoxError(
            f"bbox must have positive area, received {requested}"
        )

    clipped = (
        max(0, min(image_width, int(math.floor(x1)))),
        max(0, min(image_height, int(math.floor(y1)))),
        max(0, min(image_width, int(math.ceil(x2)))),
        max(0, min(image_height, int(math.ceil(y2)))),
    )
    if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
        raise InvalidBBoxError(
            f"bbox {requested} is empty after clipping to "
            f"{image_width}x{image_height}"
        )
    return requested, clipped


def _remove_small_components(
    support: Any,
    min_component_pixels: int,
) -> tuple[Any, int, int, int]:
    support_u8 = np.ascontiguousarray(support.astype(np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        support_u8,
        connectivity=8,
        ltype=cv2.CV_32S,
    )
    raw_count = max(0, count - 1)
    if raw_count == 0:
        return np.zeros_like(support, dtype=bool), 0, 0, 0

    areas = stats[1:, cv2.CC_STAT_AREA]
    keep_labels = np.flatnonzero(areas >= min_component_pixels) + 1
    if keep_labels.size == raw_count:
        return support.astype(bool, copy=True), raw_count, raw_count, 0
    keep_lookup = np.zeros(count, dtype=np.uint8)
    keep_lookup[keep_labels] = 1
    cleaned = keep_lookup[labels].astype(bool)
    kept_count = int(keep_labels.size)
    removed_pixels = int(areas[areas < min_component_pixels].sum())
    return cleaned, raw_count, kept_count, removed_pixels


def _tight_bbox(mask: Any) -> BBox | None:
    rows, columns = np.nonzero(mask)
    if rows.size == 0:
        return None
    return (
        int(columns.min()),
        int(rows.min()),
        int(columns.max()) + 1,
        int(rows.max()) + 1,
    )


def _mask_stats(
    *,
    probability: Any,
    support: Any,
    cleaned: Any,
    threshold: float,
    min_component_pixels: int,
    raw_component_count: int,
    kept_component_count: int,
    removed_pixels: int,
    tight_bbox_local: BBox | None,
    border_band: int,
) -> GlyphMaskStats:
    height, width = cleaned.shape
    crop_pixels = int(height * width)
    support_pixels = int(np.count_nonzero(support))
    ink_pixels = int(np.count_nonzero(cleaned))
    effective_band = min(border_band, max(1, (min(width, height) + 1) // 2))

    border = np.zeros_like(cleaned, dtype=bool)
    border[:effective_band, :] = True
    border[-effective_band:, :] = True
    border[:, :effective_band] = True
    border[:, -effective_band:] = True
    contact_pixels = int(np.count_nonzero(cleaned & border))
    border_pixels = int(np.count_nonzero(border))

    sides: list[str] = []
    if np.any(cleaned[:effective_band, :]):
        sides.append("top")
    if np.any(cleaned[:, -effective_band:]):
        sides.append("right")
    if np.any(cleaned[-effective_band:, :]):
        sides.append("bottom")
    if np.any(cleaned[:, :effective_band]):
        sides.append("left")

    if tight_bbox_local is None:
        tight_area_ratio = 0.0
    else:
        x1, y1, x2, y2 = tight_bbox_local
        tight_area_ratio = (x2 - x1) * (y2 - y1) / crop_pixels

    mean_support = (
        float(probability[support].mean()) if support_pixels else 0.0
    )
    mean_ink = float(probability[cleaned].mean()) if ink_pixels else 0.0
    return GlyphMaskStats(
        crop_width=width,
        crop_height=height,
        crop_pixels=crop_pixels,
        threshold=threshold,
        min_component_pixels=min_component_pixels,
        raw_component_count=raw_component_count,
        kept_component_count=kept_component_count,
        removed_component_count=raw_component_count - kept_component_count,
        removed_pixels=removed_pixels,
        support_pixels=support_pixels,
        support_ratio=support_pixels / crop_pixels,
        ink_pixels=ink_pixels,
        ink_ratio=ink_pixels / crop_pixels,
        retained_support_ratio=(
            ink_pixels / support_pixels if support_pixels else 0.0
        ),
        mean_support_probability=mean_support,
        mean_ink_probability=mean_ink,
        peak_probability=float(probability.max(initial=0.0)),
        tight_bbox_area_ratio=float(tight_area_ratio),
        border_band=effective_band,
        border_contact=contact_pixels > 0,
        border_contact_pixels=contact_pixels,
        border_contact_ratio=contact_pixels / ink_pixels if ink_pixels else 0.0,
        border_perimeter_coverage=(
            contact_pixels / border_pixels if border_pixels else 0.0
        ),
        border_contact_sides=tuple(sides),
    )


def _save_array_image(path: Path, array: Any) -> None:
    if Image is not None:
        Image.fromarray(np.asarray(array)).save(path)
        return
    data = np.asarray(array)
    if data.ndim == 3 and data.shape[2] == 4:
        data = cv2.cvtColor(data, cv2.COLOR_RGBA2BGRA)
    elif data.ndim == 3 and data.shape[2] == 3:
        data = cv2.cvtColor(data, cv2.COLOR_RGB2BGR)
    if not cv2.imwrite(str(path), data):
        raise ComicTextMaskError(f"failed to save image: {path}")


def _parse_cli_bbox(values: Sequence[str]) -> tuple[float, float, float, float]:
    if len(values) == 1:
        parts = [part.strip() for part in values[0].split(",")]
    else:
        parts = list(values)
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            "--bbox expects x1,y1,x2,y2 or four space-separated numbers"
        )
    try:
        parsed = tuple(float(part) for part in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "--bbox coordinates must be numbers"
        ) from exc
    return parsed  # type: ignore[return-value]


def _build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run one comic-text segmentation smoke test and extract a tight "
            "RGBA glyph crop plus grayscale mask."
        )
    )
    parser.add_argument(
        "--smoke-image",
        required=True,
        help="source manga page",
    )
    parser.add_argument(
        "--bbox",
        nargs="+",
        required=True,
        metavar="COORD",
        help="pixel AABB as x1,y1,x2,y2 (or four separate values)",
    )
    parser.add_argument(
        "--bbox-format",
        choices=("xyxy", "xywh"),
        default="xyxy",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="output RGBA PNG; <stem>.mask.png and <stem>.json are also written",
    )
    parser.add_argument("--model", default=str(DEFAULT_MODEL_PATH))
    parser.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG_PATH),
        help="optional adjacent detector config JSON",
    )
    parser.add_argument(
        "--preprocessor",
        default=str(DEFAULT_PREPROCESSOR_PATH),
        help="preprocessor JSON (fixed ONNX dimensions override its size)",
    )
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--min-component-pixels", type=int, default=3)
    parser.add_argument("--border-band", type=int, default=1)
    parser.add_argument(
        "--verify-model-hash",
        action="store_true",
        help="require the known bundled CTD SHA-256",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_cli_parser()
    args = parser.parse_args(argv)
    try:
        bbox = _parse_cli_bbox(args.bbox)
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))

    masker = ComicTextMasker(
        args.model,
        config_path=args.config or None,
        preprocessor_path=args.preprocessor or None,
        threshold=args.threshold,
        min_component_pixels=args.min_component_pixels,
        border_band=args.border_band,
        verify_model_hash=args.verify_model_hash,
    )
    if not masker.available:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": masker.unavailable_reason,
                    "model": masker.model_info,
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2

    try:
        page = masker.infer_page(args.smoke_image)
        result = page.extract(bbox, bbox_format=args.bbox_format)
        if result.empty:
            raise ComicTextMaskError(
                "the bbox contains no segmentation support at the selected "
                f"threshold ({args.threshold})"
            )
        output = Path(args.output).expanduser().resolve()
        if output.suffix.lower() != ".png":
            raise ComicTextMaskError("--output must be a .png path")
        metadata_path = output.with_name(f"{output.stem}.json")
        outputs = result.save(output, metadata_path=metadata_path)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "model": masker.model_info,
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 3

    payload = {
        "ok": True,
        "page": {
            "source": page.source,
            "width": page.width,
            "height": page.height,
            "inference_count": masker.inference_count,
        },
        "result": result.metadata(),
        "outputs": outputs,
        "model": masker.model_info,
    }
    # Keep the sidecar as complete as stdout (``save`` initially writes result
    # metadata before model/page information is assembled).
    Path(outputs["metadata"]).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
