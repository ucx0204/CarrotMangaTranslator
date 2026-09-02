#!/usr/bin/env python3
"""Read app-owned dialogue/effect crops with pinned Hayai OCR v2.

Geometry is immutable input. Dialogue crops become translation anchors while
effect crops are returned separately for the opt-in review layer.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


DLL_DIRECTORY_HANDLES: list[Any] = []


def configure_windows_dll_search_path() -> None:
    """Register the isolated CUDA/ROCm DLL roots before importing torch."""

    raw_dirs = os.environ.get("MANGA_TRANSLATOR_OCR_DLL_DIRS", "")
    if not raw_dirs or not hasattr(os, "add_dll_directory"):
        return
    for entry in raw_dirs.split(os.pathsep):
        candidate = entry.strip()
        if candidate and os.path.isdir(candidate):
            DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(candidate))


configure_windows_dll_search_path()

import torch
from huggingface_hub import snapshot_download
from PIL import Image, ImageOps
from transformers import AutoModel, AutoProcessor, PreTrainedTokenizerFast


MODEL_ID = "JustANormalTinkerer/hayai-ocr-v2"
MODEL_REVISION = "3608bb2075b9b39cb9f63e57251bca665de248cd"
PROCESSOR_ID = "google/siglip2-base-patch16-naflex"
PROCESSOR_REVISION = "b53b807d3a2d5e2b3911292f2d69e5341cdc064c"
REGION_SCHEMA = "hayai-dialogue-effect-separated-v1"
OUTPUT_SCHEMA = "hayai-ocr-regions-v1"
MODEL_FILES = {
    "config.json": (342, "581b762f1dfd55d0108f3f84e3f157bc762524af37fb0c19a7172a18b75582e2"),
    "configuration_hayai.py": (401, "47abd38cf1bae7aef27d01f5b8b4aa0960a7bc625a8afad79c4762ff5e5ed970"),
    "model.safetensors": (622502784, "4c645b221db8428cda04991be234c18133bb8861142a3d87cba04c5099b02328"),
    "modeling_hayai.py": (28251, "3d78976206549964abd55f776ab059e002adc72d2167daf168e46a12a5f4ae62"),
    "tokenizer_config.json": (244, "6fb6c69afaedf1275872d3e62e276fd4467bd00da7a84cbbb5566a2cd28f58f6"),
    "tokenizer.json": (1247253, "f8a0a909c628a684fe463094614e236a8b1d3609e7770f77e7beafaf1056bf13"),
}
PROCESSOR_FILES = {
    "config.json": (329, "c0b8c2e7f0527b0bea1b1d9abe0381c0f294352df92439c54590b8420e539118"),
    "preprocessor_config.json": (393, "1125703e5446d5b6ff4d5893a33bac128cdd21dc12e3dad2469a648fb0ae3bf7"),
    "special_tokens_map.json": (636, "baec30ea10906f16adb8c18af7a34023002c1746542612b8b41c9f09e1351351"),
    "tokenizer_config.json": (40160, "d2343400f0f86133053325951b696df8fd0f53a007cf6a546e6c2b4361344f47"),
    "tokenizer.json": (34356304, "58a1696e79c9d97937389ed116f552a15c84811d7b8023918b86f4bc5775b1b0"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image")
    parser.add_argument("--regions")
    parser.add_argument("--output")
    parser.add_argument("--batch")
    parser.add_argument("--progress")
    parser.add_argument("--device", default="gpu")
    parser.add_argument("--source-language", default="ja")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--max-num-patches", type=int, default=256)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    items = read_batch_items(args)
    model, tokenizer, processor, device = load_runtime(args)
    summaries: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        emit_progress(args.progress, {
            "phase": "start", "index": index, "total": len(items),
            "output": item["output"], "count": 0,
        })
        try:
            payload = process_page(
                image_path=Path(item["image"]),
                region_path=Path(item["regions"]),
                output_path=Path(item["output"]),
                model=model,
                tokenizer=tokenizer,
                processor=processor,
                device=device,
                batch_size=max(1, args.batch_size),
                max_new_tokens=max(8, args.max_new_tokens),
                max_num_patches=max(1, args.max_num_patches),
            )
        except Exception:
            emit_progress(args.progress, {
                "phase": "error", "index": index, "total": len(items),
                "output": item["output"], "count": 0,
            })
            raise
        finally:
            release_gpu_memory()
        summaries.append({"output": item["output"], "count": len(payload["items"])})
        emit_progress(args.progress, {
            "phase": "done", "index": index, "total": len(items),
            "output": item["output"], "count": len(payload["items"]),
        })
    print(json.dumps({"items": summaries, "count": len(summaries)}, ensure_ascii=False), flush=True)
    return 0


def read_batch_items(args: argparse.Namespace) -> list[dict[str, str]]:
    if args.batch:
        payload = read_json(Path(args.batch))
        raw_items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(raw_items, list) or not raw_items:
            raise RuntimeError("Hayai batch manifest contains no items.")
        return [normalize_batch_item(value) for value in raw_items]
    return [normalize_batch_item({
        "image": args.image,
        "regions": args.regions,
        "output": args.output,
    })]


def normalize_batch_item(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise RuntimeError("Invalid Hayai batch item.")
    item = {key: str(value.get(key) or "").strip() for key in ("image", "regions", "output")}
    if not all(item.values()):
        raise RuntimeError("Hayai batch item requires image, regions, and output paths.")
    return item


def load_runtime(args: argparse.Namespace) -> tuple[Any, Any, Any, torch.device]:
    device, backend = configure_requested_device(args.device)
    configure_torch_for_hayai(backend)
    if device.type == "cuda":
        print(
            f"[hayai-ocr] using {backend} device {torch.cuda.current_device()}: "
            f"{torch.cuda.get_device_name(torch.cuda.current_device())}",
            file=sys.stderr,
        )
    else:
        print("[hayai-ocr] using CPU", file=sys.stderr)
    model_path = Path(snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        allow_patterns=list(MODEL_FILES),
    ))
    processor_path = Path(snapshot_download(
        repo_id=PROCESSOR_ID,
        revision=PROCESSOR_REVISION,
        allow_patterns=list(PROCESSOR_FILES),
    ))
    verify_snapshot(model_path, MODEL_FILES, MODEL_ID)
    verify_snapshot(processor_path, PROCESSOR_FILES, PROCESSOR_ID)
    model = AutoModel.from_pretrained(
        model_path,
        trust_remote_code=True,
        local_files_only=True,
    ).to(device).eval()
    tokenizer = PreTrainedTokenizerFast.from_pretrained(
        model_path,
        local_files_only=True,
    )
    processor = AutoProcessor.from_pretrained(
        processor_path,
        local_files_only=True,
    )
    return model, tokenizer, processor, device


def configure_requested_device(device_name: object) -> tuple[torch.device, str]:
    requested_device = str(device_name or "").strip().lower()
    if not requested_device.startswith("gpu"):
        return torch.device("cpu"), "CPU"
    if not torch.cuda.is_available():
        raise RuntimeError(
            "HayaiOCR currently requires a CUDA/HIP GPU, but PyTorch did not expose one. "
            "Select the HayaiOCR CPU device or fix the selected GPU runtime."
        )
    backend = str(
        os.environ.get("MANGA_TRANSLATOR_OCR_GPU_BACKEND", "cuda") or "cuda"
    ).strip().lower()
    hip_version = getattr(torch.version, "hip", None)
    cuda_version = getattr(torch.version, "cuda", None)
    if backend == "rocm-transformers":
        if not hip_version:
            raise RuntimeError(
                "HayaiOCR requested the AMD ROCm runtime, but the installed "
                "PyTorch build does not report a HIP runtime."
            )
        runtime_backend = f"ROCm/HIP {hip_version}"
    elif backend == "cuda":
        if hip_version or not cuda_version:
            raise RuntimeError(
                "HayaiOCR requested the NVIDIA CUDA runtime, but the installed "
                "PyTorch build is not a CUDA build."
            )
        runtime_backend = f"CUDA {cuda_version}"
    else:
        raise RuntimeError(f"Unsupported HayaiOCR GPU backend: {backend}")

    device_index = resolve_requested_device_index(requested_device)
    if has_visible_devices_override():
        device_index = 0
    elif device_index == 0 and torch.cuda.device_count() > 1:
        device_index = max(
            range(torch.cuda.device_count()),
            key=lambda index: int(torch.cuda.get_device_properties(index).total_memory),
        )
    if device_index >= torch.cuda.device_count():
        raise RuntimeError(
            f"HayaiOCR GPU index {device_index} is unavailable; "
            f"PyTorch exposed {torch.cuda.device_count()} device(s)."
        )
    torch.cuda.set_device(device_index)
    torch.cuda.synchronize(device_index)
    return torch.device(f"cuda:{device_index}"), runtime_backend


def resolve_requested_device_index(value: str) -> int:
    if ":" not in value:
        return 0
    try:
        return max(0, int(value.rsplit(":", 1)[1]))
    except (TypeError, ValueError):
        return 0


def has_visible_devices_override() -> bool:
    return any(
        os.environ.get(name)
        for name in (
            "HIP_VISIBLE_DEVICES",
            "ROCR_VISIBLE_DEVICES",
            "CUDA_VISIBLE_DEVICES",
            "GPU_DEVICE_ORDINAL",
        )
    )


def configure_torch_for_hayai(runtime_backend: str) -> None:
    torch.set_grad_enabled(False)
    if not runtime_backend.startswith("ROCm/HIP"):
        return
    if not is_truthy_env("MANGA_TRANSLATOR_OCR_DISABLE_MIOPEN", True):
        return
    # The existing Windows ROCm OCR path uses the same conservative policy.
    # It avoids driver/MIOpen faults without changing the F32 model weights.
    torch.backends.cudnn.enabled = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    miopen_backend = getattr(torch.backends, "miopen", None)
    if miopen_backend is not None and hasattr(miopen_backend, "enabled"):
        miopen_backend.enabled = False


def is_truthy_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


def release_gpu_memory() -> None:
    gc.collect()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def verify_snapshot(
    root: Path,
    expected: Mapping[str, tuple[int, str]],
    label: str,
) -> None:
    for name, (expected_bytes, expected_sha256) in expected.items():
        path = root / name
        if not path.is_file() or path.stat().st_size != expected_bytes:
            raise RuntimeError(f"Pinned {label} asset has an invalid size: {name}")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest().lower() != expected_sha256:
            raise RuntimeError(f"Pinned {label} asset failed SHA-256 verification: {name}")


def process_page(
    *,
    image_path: Path,
    region_path: Path,
    output_path: Path,
    model: Any,
    tokenizer: Any,
    processor: Any,
    device: torch.device,
    batch_size: int,
    max_new_tokens: int,
    max_num_patches: int,
) -> dict[str, Any]:
    manifest = read_json(region_path)
    if manifest.get("schemaVersion") != REGION_SCHEMA:
        raise RuntimeError("Unsupported HayaiOCR region manifest.")
    with Image.open(image_path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    width = int(manifest.get("width") or image.width)
    height = int(manifest.get("height") or image.height)
    if image.size != (width, height):
        raise RuntimeError("HayaiOCR region dimensions do not match the source image.")
    dialogue = require_regions(manifest.get("dialogueRegions"), "dialogue")
    effects = require_regions(manifest.get("effectRegions"), "effect")
    work: list[dict[str, Any]] = []
    for region in [*dialogue, *effects]:
        boxes = list(region.get("recognitionBboxes") or [region["bbox"]])
        for segment_index, box in enumerate(boxes):
            work.append({
                "regionId": str(region["regionId"]),
                "segmentIndex": segment_index,
                "bbox": box,
            })
    recognized_parts: dict[str, list[tuple[int, str]]] = {}
    for offset in range(0, len(work), batch_size):
        batch = work[offset : offset + batch_size]
        crops = [crop_region(image, item["bbox"]) for item in batch]
        texts = recognize_batch_resilient(
            model, tokenizer, processor, device, crops,
            max_new_tokens=max_new_tokens,
            max_num_patches=max_num_patches,
        )
        for item, text in zip(batch, texts):
            region_id = str(item["regionId"])
            recognized_parts.setdefault(region_id, []).append(
                (int(item["segmentIndex"]), normalize_text(text))
            )
    recognized = {
        region_id: normalize_text("".join(
            text for _index, text in sorted(parts, key=lambda value: value[0])
        ))
        for region_id, parts in recognized_parts.items()
    }
    hints = [
        dialogue_hint(
            region,
            recognized.get(str(region["regionId"]), ""),
            recognized_parts.get(str(region["regionId"]), []),
        )
        for region in dialogue
    ]
    effect_review = [effect_item(region, recognized.get(str(region["regionId"]), "")) for region in effects]
    payload = {
        "schemaVersion": OUTPUT_SCHEMA,
        "coordinateSpace": "pixels",
        "width": width,
        "height": height,
        "items": hints,
        "effectReviewRegions": effect_review,
        "noTextDetected": len(hints) == 0,
        "textEvidenceCount": sum(bool(item.get("ocrText")) for item in hints),
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "processorId": PROCESSOR_ID,
            "processorRevision": PROCESSOR_REVISION,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def require_regions(value: object, kind: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise RuntimeError(f"HayaiOCR manifest is missing {kind} regions.")
    output: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict) or raw.get("kind") != kind:
            raise RuntimeError(f"Invalid HayaiOCR {kind} region.")
        box = require_box(raw.get("bbox"), f"{kind} bbox")
        normalized = dict(raw)
        normalized["bbox"] = box
        recognition_boxes = raw.get("recognitionBboxes")
        if recognition_boxes is not None:
            if (
                kind != "dialogue"
                or not isinstance(recognition_boxes, list)
                or not 2 <= len(recognition_boxes) <= 8
            ):
                raise RuntimeError("Invalid HayaiOCR dialogue recognition segments.")
            segments = [
                require_box(segment, "dialogue recognition bbox")
                for segment in recognition_boxes
            ]
            if any(not box_contains(box, segment) for segment in segments):
                raise RuntimeError(
                    "HayaiOCR dialogue recognition segment escapes its logical bbox."
                )
            normalized["recognitionBboxes"] = segments
        output.append(normalized)
    return output


def require_box(value: object, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise RuntimeError(f"Invalid HayaiOCR {label}.")
    try:
        box = [float(item) for item in value]
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"Invalid HayaiOCR {label}.") from error
    if (
        not all(math.isfinite(item) for item in box)
        or box[2] <= box[0]
        or box[3] <= box[1]
    ):
        raise RuntimeError(f"Invalid HayaiOCR {label}.")
    return box


def box_contains(container: Sequence[float], subject: Sequence[float]) -> bool:
    tolerance = 0.001
    return (
        subject[0] >= container[0] - tolerance
        and subject[1] >= container[1] - tolerance
        and subject[2] <= container[2] + tolerance
        and subject[3] <= container[3] + tolerance
    )


def crop_region(image: Image.Image, box: Sequence[object]) -> Image.Image:
    left = max(0, int(math.floor(float(box[0]))))
    top = max(0, int(math.floor(float(box[1]))))
    right = min(image.width, int(math.ceil(float(box[2]))))
    bottom = min(image.height, int(math.ceil(float(box[3]))))
    if right <= left or bottom <= top:
        raise RuntimeError(f"Empty Hayai crop: {list(box)}")
    return image.crop((left, top, right, bottom)).convert("RGB")


def recognize_batch_resilient(
    model: Any,
    tokenizer: Any,
    processor: Any,
    device: torch.device,
    crops: Sequence[Image.Image],
    *,
    max_new_tokens: int,
    max_num_patches: int,
) -> list[str]:
    try:
        return recognize_batch(
            model,
            tokenizer,
            processor,
            device,
            crops,
            max_new_tokens=max_new_tokens,
            max_num_patches=max_num_patches,
        )
    except Exception as error:
        if len(crops) <= 1 or not is_gpu_out_of_memory(error):
            raise
        # Drop tensor-owning traceback frames before retrying smaller groups.
        error.__traceback__ = None
    release_gpu_memory()
    midpoint = max(1, len(crops) // 2)
    return [
        *recognize_batch_resilient(
            model,
            tokenizer,
            processor,
            device,
            crops[:midpoint],
            max_new_tokens=max_new_tokens,
            max_num_patches=max_num_patches,
        ),
        *recognize_batch_resilient(
            model,
            tokenizer,
            processor,
            device,
            crops[midpoint:],
            max_new_tokens=max_new_tokens,
            max_num_patches=max_num_patches,
        ),
    ]


def is_gpu_out_of_memory(error: BaseException) -> bool:
    text = f"{type(error).__name__}: {error}".lower()
    return any(
        marker in text
        for marker in (
            "out of memory",
            "outofmemory",
            "hiperroroutofmemory",
            "cuda_error_out_of_memory",
        )
    )


def recognize_batch(
    model: Any,
    tokenizer: Any,
    processor: Any,
    device: torch.device,
    crops: Sequence[Image.Image],
    *,
    max_new_tokens: int,
    max_num_patches: int,
) -> list[str]:
    if not crops:
        return []
    inputs = processor(
        images=list(crops),
        max_num_patches=max_num_patches,
        return_tensors="pt",
    ).to(device)
    # Match the model author's reference path. Autocasting the published F32
    # checkpoint caused greedy decoding to collapse into repeated CJK tokens.
    with torch.inference_mode():
        texts = model.generate(
            pixel_values=inputs["pixel_values"],
            pixel_attention_mask=inputs["pixel_attention_mask"],
            spatial_shapes=inputs["spatial_shapes"],
            tokenizer=tokenizer,
            max_new_tokens=max_new_tokens,
            num_beams=1,
            repetition_penalty=1.0,
        )
    return [str(value) for value in texts]


def dialogue_hint(
    region: Mapping[str, Any],
    text: str,
    recognized_segments: list[tuple[int, str]],
) -> dict[str, Any]:
    box = region["bbox"]
    numeric_id = int(region["id"])
    hint = {
        "id": numeric_id,
        "label": "text",
        "x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3],
        "score": float(region.get("detectorConfidence") or 0),
        "ocrText": text,
        "reviewFragmentId": f"B{numeric_id:04d}",
        "reviewStatus": "confirmed",
        "reviewOrder": 1,
        "geometryLocked": True,
        "sourceDetectionIds": list(region.get("sourceDetectionIds") or []),
    }
    recognition_boxes = list(region.get("recognitionBboxes") or [])
    if len(recognition_boxes) >= 2:
        text_by_index = dict(recognized_segments)
        hint["recognitionSegments"] = [
            {
                "x1": segment[0],
                "y1": segment[1],
                "x2": segment[2],
                "y2": segment[3],
                "ocrText": text_by_index.get(index, ""),
            }
            for index, segment in enumerate(recognition_boxes)
        ]
    return hint


def effect_item(region: Mapping[str, Any], text: str) -> dict[str, Any]:
    return {
        "regionId": str(region["regionId"]),
        "bbox": list(region["bbox"]),
        "detectorConfidence": float(region.get("detectorConfidence") or 0),
        "recognizedText": text,
        "sourceDetectionIds": list(region.get("sourceDetectionIds") or []),
    }


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"[\r\n\t]+", " ", text)
    cjk = r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]"
    text = re.sub(rf"({cjk})\s+({cjk})", r"\1\2", text)
    return re.sub(r"\s+", " ", text).strip()


def emit_progress(path: str | None, payload: Mapping[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
        handle.flush()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
