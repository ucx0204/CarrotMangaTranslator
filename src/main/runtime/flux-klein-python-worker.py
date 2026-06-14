#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

from PIL import Image


PROMPT = (
    "Clean manga inpainting after lettering removal. "
    "The masked area is filled only by the surrounding artwork: blank speech-bubble surface, continuous screentone, "
    "paper grain, panel borders, color palette, and line art matching neighboring pixels. "
    "Preserve the source page's original color or grayscale style and keep unmasked pixels unchanged."
)

# Keep this as a plain prompt string instead of a bundled prompt embedding.
# FLUX.2/Klein responds better here when the desired final state is described
# positively; long negative prompt lists can leave glyph-like artifacts.
NEGATIVE_PROMPT = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MGT Flux inpainting Python worker")
    parser.add_argument("--backend", choices=["rocm", "cpu"], required=True)
    parser.add_argument("--mode", choices=["klein-edit-composite", "flux-fill"], default="klein-edit-composite")
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--gguf-transformer")
    return parser.parse_args()


def load_pipeline(args: argparse.Namespace):
    import torch
    import diffusers

    if args.backend == "rocm":
        if not getattr(torch.version, "hip", None):
            raise RuntimeError("installed torch is not a ROCm/HIP build")
        if not torch.cuda.is_available():
            raise RuntimeError("ROCm torch cannot see an AMD GPU")
        device = "cuda"
        dtype = resolve_torch_dtype(torch, args.backend)
    else:
        device = "cpu"
        dtype = resolve_torch_dtype(torch, args.backend)

    errors: list[str] = []
    transformer = load_gguf_transformer(diffusers, torch, args.gguf_transformer, args.model_id, args.cache_dir, dtype) if args.gguf_transformer else None
    for class_name in resolve_pipeline_classes(args.mode):
        pipeline_class = getattr(diffusers, class_name, None)
        if pipeline_class is None:
            continue
        try:
            load_kwargs = {
                "cache_dir": args.cache_dir,
                "torch_dtype": dtype,
            }
            if transformer is not None:
                load_kwargs["transformer"] = transformer
            pipe = pipeline_class.from_pretrained(
                args.model_id,
                **load_kwargs,
            )
            if hasattr(pipe, "set_progress_bar_config"):
                pipe.set_progress_bar_config(disable=True)
            if hasattr(pipe, "enable_attention_slicing"):
                pipe.enable_attention_slicing()
            pipe.to(device)
            return pipe, device
        except Exception as exc:  # noqa: BLE001 - report all loader attempts to the parent process
            errors.append(f"{class_name}: {exc}")
    raise RuntimeError("No usable Diffusers inpainting pipeline was found. " + " | ".join(errors[-3:]))


def load_gguf_transformer(diffusers, torch, gguf_path: str | None, model_id: str, cache_dir: str, dtype):
    if not gguf_path:
        return None
    path = Path(gguf_path)
    if not path.is_file():
        raise RuntimeError(f"GGUF transformer file was not found: {path}")

    quant_config_class = getattr(diffusers, "GGUFQuantizationConfig", None)
    if quant_config_class is None:
        raise RuntimeError("Installed diffusers does not provide GGUFQuantizationConfig. Upgrade diffusers/gguf packages.")

    quantization_config = quant_config_class(compute_dtype=dtype)
    errors: list[str] = []
    for class_name in ("Flux2Transformer2DModel", "FluxTransformer2DModel"):
        model_class = getattr(diffusers, class_name, None)
        if model_class is None:
            continue
        attempts = (
            {
                "config": model_id,
                "subfolder": "transformer",
                "cache_dir": cache_dir,
            },
            {},
        )
        for extra_kwargs in attempts:
            try:
                return model_class.from_single_file(
                    str(path),
                    quantization_config=quantization_config,
                    torch_dtype=dtype,
                    **extra_kwargs,
                )
            except Exception as exc:  # noqa: BLE001 - include every loader attempt in one actionable message
                suffix = " with Klein transformer config" if extra_kwargs else ""
                errors.append(f"{class_name}{suffix}: {exc}")
    raise RuntimeError("Unable to load Flux GGUF transformer. " + " | ".join(errors[-3:]))


def resolve_torch_dtype(torch, backend: str):
    requested = (os.environ.get("MANGA_TRANSLATOR_FLUX_TORCH_DTYPE") or os.environ.get("MGT_FLUX_TORCH_DTYPE") or "").strip().lower()
    if requested in {"float32", "fp32", "f32"}:
        return torch.float32
    if requested in {"bfloat16", "bf16"}:
        return torch.bfloat16
    if requested in {"float16", "fp16", "f16"}:
        return torch.float16
    return torch.float16 if backend == "rocm" else torch.float32


def resolve_pipeline_classes(mode: str) -> tuple[str, ...]:
    if mode == "flux-fill":
        return (
            "FluxFillPipeline",
            "FluxInpaintPipeline",
            "AutoPipelineForInpainting",
            "DiffusionPipeline",
        )
    return (
        "Flux2KleinPipeline",
        "DiffusionPipeline",
    )


def run_inpaint(pipe, device: str, mode: str, request: dict) -> None:
    import torch

    input_path = Path(request["input"])
    mask_path = Path(request["mask"])
    output_path = Path(request["output"])
    steps = max(1, int(request.get("steps") or 4))
    strength = float(request.get("strength") or 1.0)

    image = Image.open(input_path).convert("RGB")
    mask = Image.open(mask_path).convert("L")
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)

    kwargs = {
        "prompt": PROMPT,
        "negative_prompt": NEGATIVE_PROMPT,
        "image": image,
        "mask_image": mask,
        "num_inference_steps": steps,
        "strength": strength,
        "height": image.height,
        "width": image.width,
    }
    if device == "cuda":
        kwargs["guidance_scale"] = 1.0

    with torch.inference_mode():
        result = call_pipeline_with_supported_args(pipe, kwargs, mode=mode)

    output = result.images[0].convert("RGBA")
    if output.size != image.size:
        output = output.resize(image.size, Image.Resampling.LANCZOS)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path)


def call_pipeline_with_supported_args(pipe, kwargs: dict, mode: str):
    variants = []
    variants.append(dict(kwargs))
    no_negative = dict(kwargs)
    no_negative.pop("negative_prompt", None)
    variants.append(no_negative)
    if mode == "klein-edit-composite":
        no_mask = dict(no_negative)
        no_mask.pop("mask_image", None)
        variants.append(no_mask)
        variants.append({
            "prompt": kwargs["prompt"],
            "image": kwargs["image"],
            "num_inference_steps": kwargs["num_inference_steps"],
            "guidance_scale": kwargs.get("guidance_scale", 1.0),
        })

    last_error = None
    for candidate in variants:
        try:
            return pipe(**candidate)
        except TypeError as exc:
            last_error = exc
            continue
    raise last_error or RuntimeError("pipeline call failed")


def main() -> int:
    args = parse_args()
    pipe, device = load_pipeline(args)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"id": "", "ok": False, "error": f"invalid json: {exc}"}), flush=True)
            continue
        if request.get("type") == "shutdown":
            return 0
        request_id = str(request.get("id") or "")
        try:
            if request.get("type") != "inpaint":
                raise ValueError(f"unsupported request type: {request.get('type')}")
            run_inpaint(pipe, device, args.mode, request)
            print(json.dumps({"id": request_id, "ok": True}), flush=True)
        except Exception as exc:  # noqa: BLE001 - error is serialized for the Electron parent process
            print(json.dumps({"id": request_id, "ok": False, "error": str(exc)}), flush=True)
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
