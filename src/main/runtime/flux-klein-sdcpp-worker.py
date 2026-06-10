#!/usr/bin/env python3
from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter


PROMPT = (
    "Remove only the Japanese manga text covered by the mask. "
    "Restore the original manga background, screen tone, line art, panel borders, and speech bubble surface. "
    "Do not add new text, symbols, logos, characters, objects, or decoration."
)
NEGATIVE_PROMPT = "text, letters, words, caption, watermark, logo, signature, extra objects, blurry artifacts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MGT Flux Klein stable-diffusion.cpp worker")
    parser.add_argument("--backend", choices=["rocm", "cpu"], required=True)
    parser.add_argument("--diffusion-model", required=True)
    parser.add_argument("--vae", required=True)
    parser.add_argument("--llm", required=True)
    parser.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    sd = load_stable_diffusion(args)
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
            run_inpaint(sd, request)
            print(json.dumps({"id": request_id, "ok": True}), flush=True)
        except Exception as exc:  # noqa: BLE001 - serialized for Electron parent process
            print(json.dumps({"id": request_id, "ok": False, "error": str(exc)}), flush=True)
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
    return 0


def load_stable_diffusion(args: argparse.Namespace):
    from stable_diffusion_cpp import StableDiffusion

    kwargs = {
        "diffusion_model_path": args.diffusion_model,
        "llm_path": args.llm,
        "vae_path": args.vae,
        "offload_params_to_cpu": True,
        "diffusion_flash_attn": True,
        "n_threads": args.threads,
        "verbose": False,
    }
    return StableDiffusion(**filter_supported_kwargs(StableDiffusion, kwargs))


def run_inpaint(sd: Any, request: dict[str, Any]) -> None:
    input_path = Path(request["input"])
    mask_path = Path(request["mask"])
    output_path = Path(request["output"])
    steps = max(1, int(request.get("steps") or 4))
    strength = float(request.get("strength") or 1.0)

    image = Image.open(input_path).convert("RGB")
    mask = Image.open(mask_path).convert("L")
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)

    # App masks use white as the area to erase. stable-diffusion.cpp expects
    # 0 for masked pixels and 255 for preserved pixels.
    cpp_mask = mask.point(lambda value: 0 if value > 16 else 255, mode="L")
    feather = max(0, int(request.get("feather") or 4))
    if feather > 0:
        cpp_mask = cpp_mask.filter(ImageFilter.GaussianBlur(radius=min(16, feather)))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cpp_mask_path = output_path.with_name(f"{output_path.stem}.sdcpp-mask.png")
    cpp_mask.save(cpp_mask_path)

    result = call_generate_image(
        sd,
        image=image,
        image_path=input_path,
        mask=cpp_mask,
        mask_path=cpp_mask_path,
        steps=steps,
        strength=strength,
    )
    output = normalize_output_image(result)
    if output.size != image.size:
        output = output.resize(image.size, Image.Resampling.LANCZOS)
    output.convert("RGBA").save(output_path)


def call_generate_image(
    sd: Any,
    image: Image.Image,
    image_path: Path,
    mask: Image.Image,
    mask_path: Path,
    steps: int,
    strength: float,
):
    base = {
        "prompt": PROMPT,
        "negative_prompt": NEGATIVE_PROMPT,
        "init_image": image,
        "mask_image": mask,
        "width": image.width,
        "height": image.height,
        "sample_steps": steps,
        "cfg_scale": 1.0,
        "strength": strength,
        "seed": -1,
    }
    variants = [
        base,
        {**base, "init_image": str(image_path), "mask_image": str(mask_path)},
        rename_key(base, "sample_steps", "num_inference_steps"),
        rename_key({**base, "init_image": str(image_path), "mask_image": str(mask_path)}, "sample_steps", "num_inference_steps"),
        without_keys(base, "negative_prompt"),
        without_keys(rename_key(base, "sample_steps", "num_inference_steps"), "negative_prompt"),
        {
            "prompt": PROMPT,
            "ref_images": [str(image_path)],
            "width": image.width,
            "height": image.height,
            "sample_steps": steps,
            "cfg_scale": 1.0,
            "strength": strength,
            "seed": -1,
        },
    ]

    last_error: Exception | None = None
    for kwargs in variants:
        try:
            return sd.generate_image(**filter_supported_kwargs(sd.generate_image, kwargs))
        except TypeError as exc:
            last_error = exc
            continue
    raise last_error or RuntimeError("stable-diffusion.cpp generate_image failed")


def filter_supported_kwargs(fn: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return kwargs
    if any(param.kind == inspect.Parameter.VAR_KEYWORD for param in signature.parameters.values()):
        return kwargs
    return {key: value for key, value in kwargs.items() if key in signature.parameters}


def rename_key(source: dict[str, Any], old: str, new: str) -> dict[str, Any]:
    result = dict(source)
    if old in result:
        result[new] = result.pop(old)
    return result


def without_keys(source: dict[str, Any], *keys: str) -> dict[str, Any]:
    result = dict(source)
    for key in keys:
        result.pop(key, None)
    return result


def normalize_output_image(result: Any) -> Image.Image:
    if isinstance(result, Image.Image):
        return result.convert("RGBA")
    if isinstance(result, list) and result:
        item = result[0]
        if isinstance(item, Image.Image):
            return item.convert("RGBA")
        if hasattr(item, "image") and isinstance(item.image, Image.Image):
            return item.image.convert("RGBA")
    if hasattr(result, "images") and result.images:
        item = result.images[0]
        if isinstance(item, Image.Image):
            return item.convert("RGBA")
    raise RuntimeError("stable-diffusion.cpp returned no image")


if __name__ == "__main__":
    raise SystemExit(main())
