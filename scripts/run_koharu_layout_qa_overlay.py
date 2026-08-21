"""Run the pinned KoharuLayout model and make a translucent QA overlay.

This is deliberately a local, non-production diagnostic. The remote repository's
Python loader is not executed: this script reconstructs the reviewed loader with a
strict SafeTensors state load and pins the repository revision and file hashes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter


SCHEMA_VERSION = "koharu-layout-rfdetr-qa-overlay-v1"
REPO_ID = "mayocream/koharu-layout-rfdetr-seg-2xl-1152"
REPO_REVISION = "aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2"
MODEL_FILENAME = "model.safetensors"
MODEL_SHA256 = "9bf6d2cbd7793c956d8c857bb1672a396eb7f100eb0682f86830d05e31168efb"
MODEL_BYTES = 161_292_684
CONFIG_FILENAME = "inference_config.json"
CONFIG_SHA256 = "3b1956f18e9f91a8add4865a78c6d554d3917bd5e1f28f5d91faa533d09e6de6"
RFDETR_VERSION = "1.7.0"
RESOLUTION = 1152
NUM_SELECT = 160
CLASS_NAMES = {0: "text", 1: "onomatopoeia", 2: "bubble", 3: "panel"}
CLASS_LABELS = {0: "text", 1: "SFX", 2: "bubble", 3: "panel"}
CLASS_THRESHOLDS = {0: 0.25, 1: 0.20, 2: 0.50, 3: 0.50}
CLASS_COLORS = {
    0: (0, 190, 255),
    1: (255, 70, 145),
    2: (45, 205, 105),
    3: (145, 100, 255),
}
CLASS_ALPHAS = {0: 0.28, 1: 0.24, 2: 0.12, 3: 0.05}
CLASS_RENDER_ORDER = (3, 2, 0, 1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def expected_inference_config() -> dict[str, Any]:
    return {
        "architecture": "RFDETRSeg2XLarge",
        "rfdetr_version": RFDETR_VERSION,
        "resolution": RESOLUTION,
        "num_select": NUM_SELECT,
        "classes": {str(class_id): name for class_id, name in CLASS_NAMES.items()},
        "recommended_thresholds": {
            "text": CLASS_THRESHOLDS[0],
            "onomatopoeia": CLASS_THRESHOLDS[1],
            "bubble": CLASS_THRESHOLDS[2],
            "panel": CLASS_THRESHOLDS[3],
        },
        "checkpoint": MODEL_FILENAME,
        "checkpoint_sha256": MODEL_SHA256,
        "source_checkpoint_sha256": "b1f8c81e41e376342cb9e236be265505a96dc0c3774916df17cad4d720e3b67a",
    }


def validate_inference_config(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(
            f"KoharuLayout config must be a regular non-link file: {path}"
        )
    actual_sha = sha256_file(path)
    if actual_sha != CONFIG_SHA256:
        raise RuntimeError(
            f"KoharuLayout config SHA drifted: expected {CONFIG_SHA256}, got {actual_sha}"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    if data != expected_inference_config():
        raise RuntimeError("KoharuLayout inference config contract drifted")
    return data


def validate_weights(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(
            f"KoharuLayout weights must be a regular non-link file: {path}"
        )
    actual_bytes = path.stat().st_size
    if actual_bytes != MODEL_BYTES:
        raise RuntimeError(
            f"KoharuLayout weights bytes drifted: expected {MODEL_BYTES}, got {actual_bytes}"
        )
    actual_sha = sha256_file(path)
    if actual_sha != MODEL_SHA256:
        raise RuntimeError(
            f"KoharuLayout weights SHA drifted: expected {MODEL_SHA256}, got {actual_sha}"
        )
    return {"path": str(path.resolve()), "sha256": actual_sha, "bytes": actual_bytes}


def ensure_assets(cache_dir: Path, *, allow_download: bool) -> dict[str, Any]:
    cache_dir = cache_dir.resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    weights_path = cache_dir / MODEL_FILENAME
    config_path = cache_dir / CONFIG_FILENAME
    missing = [path.name for path in (weights_path, config_path) if not path.is_file()]
    if missing and not allow_download:
        raise RuntimeError(f"KoharuLayout assets are missing: {', '.join(missing)}")
    if missing:
        from huggingface_hub import hf_hub_download

        for filename in missing:
            downloaded = Path(
                hf_hub_download(
                    repo_id=REPO_ID,
                    filename=filename,
                    revision=REPO_REVISION,
                    local_dir=str(cache_dir),
                )
            ).resolve()
            if downloaded != (cache_dir / filename).resolve():
                raise RuntimeError(
                    f"Unexpected Hugging Face asset path for {filename}: {downloaded}"
                )
    config = validate_inference_config(config_path)
    weights = validate_weights(weights_path)
    return {
        "repo_id": REPO_ID,
        "revision": REPO_REVISION,
        "weights": weights,
        "config": {
            "path": str(config_path.resolve()),
            "sha256": CONFIG_SHA256,
            "bytes": config_path.stat().st_size,
            "value": config,
        },
    }


def filter_detection_indices(
    class_ids: np.ndarray, confidences: np.ndarray
) -> np.ndarray:
    class_ids = np.asarray(class_ids)
    confidences = np.asarray(confidences)
    if (
        class_ids.ndim != 1
        or confidences.ndim != 1
        or len(class_ids) != len(confidences)
    ):
        raise ValueError("class_ids and confidences must be same-length vectors")
    keep = np.zeros(len(class_ids), dtype=bool)
    for index, (raw_class_id, raw_confidence) in enumerate(
        zip(class_ids, confidences, strict=True)
    ):
        class_id = int(raw_class_id)
        confidence = float(raw_confidence)
        if class_id not in CLASS_NAMES:
            raise ValueError(f"Unexpected KoharuLayout class id: {class_id}")
        if not math.isfinite(confidence) or confidence < 0 or confidence > 1:
            raise ValueError(f"Invalid KoharuLayout confidence: {confidence}")
        keep[index] = confidence >= CLASS_THRESHOLDS[class_id]
    return keep


def _resize_mask(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    mask = np.asarray(mask)
    if mask.ndim != 2:
        raise ValueError(f"Detection mask must be 2D, got shape {mask.shape}")
    binary = mask.astype(bool)
    if binary.shape == (height, width):
        return binary
    resized = Image.fromarray(binary.astype(np.uint8) * 255).resize(
        (width, height),
        Image.Resampling.NEAREST,
    )
    return np.asarray(resized) > 0


def _load_legend_font(size: int) -> ImageFont.ImageFont:
    candidates = (
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    )
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def compose_overlay(
    image: Image.Image,
    masks: np.ndarray,
    class_ids: np.ndarray,
    *,
    alpha_scale: float = 1.0,
    include_legend: bool = True,
) -> tuple[Image.Image, Image.Image, dict[int, int]]:
    if not math.isfinite(alpha_scale) or not 0 < alpha_scale <= 2:
        raise ValueError("alpha_scale must be finite and in (0, 2]")
    source = image.convert("RGB")
    width, height = source.size
    masks = np.asarray(masks)
    class_ids = np.asarray(class_ids)
    if masks.ndim != 3 or class_ids.ndim != 1 or len(masks) != len(class_ids):
        raise ValueError("masks must be [N,H,W] and match class_ids")

    base = np.asarray(source, dtype=np.float32).copy()
    class_map = np.zeros((height, width, 3), dtype=np.uint8)
    union_pixels: dict[int, int] = {}
    unions: dict[int, np.ndarray] = {}
    for class_id in CLASS_NAMES:
        indices = np.flatnonzero(class_ids.astype(np.int64) == class_id)
        union = np.zeros((height, width), dtype=bool)
        for index in indices:
            union |= _resize_mask(masks[int(index)], width, height)
        unions[class_id] = union
        union_pixels[class_id] = int(union.sum())

    for class_id in CLASS_RENDER_ORDER:
        union = unions[class_id]
        if not union.any():
            continue
        color = np.asarray(CLASS_COLORS[class_id], dtype=np.float32)
        alpha = min(1.0, CLASS_ALPHAS[class_id] * alpha_scale)
        base[union] = base[union] * (1.0 - alpha) + color * alpha
        class_map[union] = np.asarray(CLASS_COLORS[class_id], dtype=np.uint8)

    result = Image.fromarray(np.rint(base).clip(0, 255).astype(np.uint8))
    outline_layer = Image.new("RGBA", source.size, (0, 0, 0, 0))
    for class_id in CLASS_RENDER_ORDER:
        union = unions[class_id]
        if not union.any():
            continue
        mask_image = Image.fromarray(union.astype(np.uint8) * 255)
        expanded = np.asarray(mask_image.filter(ImageFilter.MaxFilter(3))) > 0
        contracted = np.asarray(mask_image.filter(ImageFilter.MinFilter(3))) > 0
        edge = expanded ^ contracted
        edge_alpha = int(round(min(1.0, 0.64 * alpha_scale) * 255))
        edge_rgba = np.zeros((height, width, 4), dtype=np.uint8)
        edge_rgba[edge, :3] = CLASS_COLORS[class_id]
        edge_rgba[edge, 3] = edge_alpha
        outline_layer = Image.alpha_composite(outline_layer, Image.fromarray(edge_rgba))
    result = Image.alpha_composite(result.convert("RGBA"), outline_layer)

    if include_legend:
        legend = Image.new("RGBA", source.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(legend)
        font_size = max(14, min(28, round(width / 52)))
        font = _load_legend_font(font_size)
        padding = max(8, font_size // 2)
        swatch = max(12, round(font_size * 0.8))
        labels = [
            f"{CLASS_LABELS[class_id]} {union_pixels[class_id]:,} px"
            for class_id in CLASS_NAMES
        ]
        text_widths = [draw.textbbox((0, 0), label, font=font)[2] for label in labels]
        box_width = padding * 2 + swatch + padding + max(text_widths)
        row_height = max(swatch, font_size + 4)
        box_height = padding * 2 + row_height * len(labels)
        draw.rounded_rectangle(
            (8, 8, 8 + box_width, 8 + box_height),
            radius=max(6, padding),
            fill=(0, 0, 0, 155),
            outline=(255, 255, 255, 120),
            width=1,
        )
        for row, (class_id, label) in enumerate(zip(CLASS_NAMES, labels, strict=True)):
            y = 8 + padding + row * row_height
            draw.rectangle(
                (8 + padding, y + 2, 8 + padding + swatch, y + 2 + swatch),
                fill=(*CLASS_COLORS[class_id], 230),
            )
            draw.text(
                (8 + padding * 2 + swatch, y),
                label,
                font=font,
                fill=(255, 255, 255, 245),
            )
        result = Image.alpha_composite(result, legend)

    return result.convert("RGB"), Image.fromarray(class_map), union_pixels


def _load_model(weights_path: Path, device: str) -> tuple[Any, dict[str, Any]]:
    import torch
    import warnings
    from rfdetr import RFDETRSeg2XLarge
    from rfdetr.config import PretrainWeightsCompatibilityWarning
    from safetensors.torch import load_file

    installed_version = importlib.metadata.version("rfdetr")
    if installed_version != RFDETR_VERSION:
        raise RuntimeError(
            f"Expected rfdetr=={RFDETR_VERSION}, got {installed_version}"
        )
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but torch.cuda.is_available() is false")
    resolved_device = torch.device(device)
    started = time.perf_counter()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", PretrainWeightsCompatibilityWarning)
        model = RFDETRSeg2XLarge(
            pretrain_weights=None,
            resolution=RESOLUTION,
            num_select=NUM_SELECT,
            num_classes=len(CLASS_NAMES),
        )
    incompatible = model.model.model.load_state_dict(
        load_file(str(weights_path), device="cpu"), strict=True
    )
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise RuntimeError(f"Incompatible KoharuLayout weights: {incompatible}")
    model.model.class_names = [CLASS_NAMES[index] for index in range(len(CLASS_NAMES))]
    model.model.device = resolved_device
    model.model.model.eval()
    load_seconds = time.perf_counter() - started
    runtime = {
        "rfdetr_version": installed_version,
        "torch_version": torch.__version__,
        "device": str(resolved_device),
        "cuda_device_name": torch.cuda.get_device_name(resolved_device)
        if resolved_device.type == "cuda"
        else None,
        "model_load_seconds": load_seconds,
    }
    return model, runtime


def _normalise_detection_arrays(detections: Any) -> dict[str, np.ndarray]:
    if detections.mask is None:
        raise RuntimeError("KoharuLayout returned detections without instance masks")
    arrays = {
        "xyxy": np.asarray(detections.xyxy, dtype=np.float32),
        "mask": np.asarray(detections.mask),
        "class_id": np.asarray(detections.class_id, dtype=np.int64),
        "confidence": np.asarray(detections.confidence, dtype=np.float32),
    }
    count = len(arrays["class_id"])
    if (
        arrays["xyxy"].shape != (count, 4)
        or arrays["mask"].ndim != 3
        or len(arrays["mask"]) != count
    ):
        raise RuntimeError("KoharuLayout returned malformed detection arrays")
    if arrays["confidence"].shape != (count,):
        raise RuntimeError("KoharuLayout returned malformed confidence scores")
    return arrays


def _exclusive_output(path: Path) -> Path:
    path = path.resolve()
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite existing QA output: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _detection_records(arrays: dict[str, np.ndarray]) -> list[dict[str, Any]]:
    records = []
    for index in range(len(arrays["class_id"])):
        class_id = int(arrays["class_id"][index])
        records.append(
            {
                "index": index,
                "class_id": class_id,
                "class_name": CLASS_NAMES[class_id],
                "confidence": round(float(arrays["confidence"][index]), 8),
                "xyxy": [round(float(value), 3) for value in arrays["xyxy"][index]],
                "mask_pixels": int(
                    np.asarray(arrays["mask"][index]).astype(bool).sum()
                ),
            }
        )
    return records


def run_overlay(args: argparse.Namespace) -> dict[str, Any]:
    import torch

    input_path = Path(args.input).resolve(strict=True)
    if not input_path.is_file() or input_path.is_symlink():
        raise RuntimeError(f"Input must be a regular non-link image: {input_path}")
    output_path = _exclusive_output(Path(args.output))
    report_path = _exclusive_output(Path(args.report))
    class_map_path = _exclusive_output(Path(args.class_map_output))
    assets = ensure_assets(Path(args.cache_dir), allow_download=not args.no_download)
    source_sha = sha256_file(input_path)
    with Image.open(input_path) as opened:
        image = opened.convert("RGB")
    model, runtime = _load_model(Path(assets["weights"]["path"]), args.device)
    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
    inference_started = time.perf_counter()
    with torch.inference_mode():
        raw_detections = model.predict(
            image,
            threshold=min(CLASS_THRESHOLDS.values()),
            shape=(RESOLUTION, RESOLUTION),
            include_source_image=False,
        )
    if args.device == "cuda":
        torch.cuda.synchronize()
    inference_seconds = time.perf_counter() - inference_started
    raw_arrays = _normalise_detection_arrays(raw_detections)
    keep = filter_detection_indices(raw_arrays["class_id"], raw_arrays["confidence"])
    arrays = {name: values[keep] for name, values in raw_arrays.items()}
    overlay, class_map, union_pixels = compose_overlay(
        image,
        arrays["mask"],
        arrays["class_id"],
        alpha_scale=args.alpha_scale,
        include_legend=not args.no_legend,
    )
    overlay.save(output_path, format="PNG", optimize=True)
    class_map.save(class_map_path, format="PNG", optimize=True)
    class_counts = {
        CLASS_NAMES[class_id]: int(np.sum(arrays["class_id"] == class_id))
        for class_id in CLASS_NAMES
    }
    report = {
        "schema_version": SCHEMA_VERSION,
        "status": "completed",
        "scope": "local_qa_only",
        "production_integration": False,
        "promotion_eligible": False,
        "model": assets,
        "runtime": {
            **runtime,
            "python_version": platform.python_version(),
            "inference_seconds": inference_seconds,
            "cuda_peak_memory_bytes": int(torch.cuda.max_memory_allocated())
            if args.device == "cuda"
            else None,
        },
        "input": {
            "path": str(input_path),
            "sha256": source_sha,
            "bytes": input_path.stat().st_size,
            "width": image.width,
            "height": image.height,
        },
        "outputs": {
            "overlay": {
                "path": str(output_path),
                "sha256": sha256_file(output_path),
                "bytes": output_path.stat().st_size,
            },
            "class_map": {
                "path": str(class_map_path),
                "sha256": sha256_file(class_map_path),
                "bytes": class_map_path.stat().st_size,
            },
        },
        "inference": {
            "resolution": [RESOLUTION, RESOLUTION],
            "raw_threshold": min(CLASS_THRESHOLDS.values()),
            "class_thresholds": {
                CLASS_NAMES[key]: value for key, value in CLASS_THRESHOLDS.items()
            },
            "class_colors_rgb": {
                CLASS_NAMES[key]: list(value) for key, value in CLASS_COLORS.items()
            },
            "class_alphas": {
                CLASS_NAMES[key]: min(1.0, value * args.alpha_scale)
                for key, value in CLASS_ALPHAS.items()
            },
            "raw_detection_count": int(len(raw_arrays["class_id"])),
            "kept_detection_count": int(len(arrays["class_id"])),
            "class_counts": class_counts,
            "class_union_pixels": {
                CLASS_NAMES[key]: union_pixels[key] for key in CLASS_NAMES
            },
            "detections": _detection_records(arrays),
        },
        "limitations": {
            "ocr_or_reading_order": False,
            "text_to_bubble_relationships": False,
            "sfx_threshold_precision_tradeoff": True,
            "manga109_training_terms_require_separate_distribution_review": True,
        },
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "ok": True,
                "overlay": str(output_path),
                "report": str(report_path),
                **class_counts,
            }
        )
    )
    return report


def build_parser() -> argparse.ArgumentParser:
    root = Path(__file__).resolve().parents[1]
    default_cache = root / ".tmp" / "koharu-layout-rfdetr-qa-v1" / "assets"
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    setup = subparsers.add_parser(
        "setup", help="Download and verify the pinned SafeTensors/config assets"
    )
    setup.add_argument("--cache-dir", default=str(default_cache))
    setup.add_argument("--no-download", action="store_true")
    overlay = subparsers.add_parser(
        "overlay", help="Run one source page and write a translucent class overlay"
    )
    overlay.add_argument("--input", required=True)
    overlay.add_argument("--output", required=True)
    overlay.add_argument("--report", required=True)
    overlay.add_argument("--class-map-output", required=True)
    overlay.add_argument("--cache-dir", default=str(default_cache))
    overlay.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    overlay.add_argument("--alpha-scale", type=float, default=1.0)
    overlay.add_argument("--no-legend", action="store_true")
    overlay.add_argument("--no-download", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "setup":
        assets = ensure_assets(
            Path(args.cache_dir), allow_download=not args.no_download
        )
        print(json.dumps({"ok": True, "assets": assets}, ensure_ascii=False))
        return 0
    if args.command == "overlay":
        run_overlay(args)
        return 0
    raise AssertionError(f"Unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
