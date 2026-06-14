#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter


IMAGE_MULTIPLE = 16
INPAINT_CROP_CONTEXT = 64

PROMPT = (
    "Clean manga inpainting after lettering removal. "
    "The masked area is filled only by the surrounding artwork: blank speech-bubble surface, continuous screentone, "
    "paper grain, panel borders, color palette, and line art matching neighboring pixels. "
    "Preserve the source page's original color or grayscale style and keep unmasked pixels unchanged."
)

# FLUX.2 is not trained around CLIP-style negative prompt lists. In sd.cpp this
# is especially easy to over-condition into residual glyphs, so keep all intent
# in the positive target-state prompt above.
NEGATIVE_PROMPT = ""


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

    return StableDiffusion(
        diffusion_model_path=args.diffusion_model,
        llm_path=args.llm,
        vae_path=args.vae,
        offload_params_to_cpu=True,
        diffusion_flash_attn=True,
        n_threads=args.threads,
        verbose=False,
    )


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

    # The app and Koharu-style compositing use white as "erase this area".
    # FLUX.2 Klein in stable-diffusion.cpp is an image-edit model, so feed it a
    # reference image where the masked lettering is already roughly blanked.
    # The final result is still composited only through our original mask.
    erase_mask = mask.point(lambda value: 255 if value > 16 else 0, mode="L")
    mask_padding = int(request.get("mask_padding") or 16)
    bounds = inpaint_crop_bounds(image, erase_mask, mask_padding)
    if bounds is None:
        inference_image = image
        composite_mask = erase_mask
    else:
        inference_image = image.crop(bounds)
        composite_mask = erase_mask.crop(bounds)
    expanded_erase_mask = expand_inference_mask(composite_mask, mask_padding)
    reference_image = build_klein_reference_image(inference_image, expanded_erase_mask)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    debug_mask_path = output_path.with_name(f"{output_path.stem}.sdcpp-mask.png")
    debug_ref_path = output_path.with_name(f"{output_path.stem}.sdcpp-ref.png")
    expanded_erase_mask.save(debug_mask_path)
    reference_image.save(debug_ref_path)

    result = call_generate_image(
        sd,
        image=reference_image,
        reference_path=debug_ref_path,
        steps=steps,
        strength=strength,
    )
    output = normalize_output_image(result)
    if output.size != inference_image.size:
        output = output.resize(inference_image.size, Image.Resampling.LANCZOS)
    validate_masked_region_changed(inference_image, output.convert("RGB"), composite_mask)
    if bounds is not None:
        output = composite_inpaint_crop(image, output, composite_mask, bounds)
    output.convert("RGBA").save(output_path)


def call_generate_image(
    sd: Any,
    image: Image.Image,
    reference_path: Path,
    steps: int,
    strength: float,
):
    return sd.generate_image(
        prompt=PROMPT,
        negative_prompt=NEGATIVE_PROMPT,
        ref_images=[str(reference_path)],
        width=image.width,
        height=image.height,
        sample_steps=steps,
        sample_method="euler",
        cfg_scale=1.0,
        guidance=1.0,
        strength=strength,
        seed=-1,
        batch_count=1,
    )


def build_klein_reference_image(image: Image.Image, erase_mask: Image.Image) -> Image.Image:
    base = image.convert("RGB")
    mask_l = erase_mask.convert("L")
    if mask_l.getbbox() is None:
        return base

    fill_color = estimate_local_fill_color(base, mask_l)
    flat_fill = Image.new("RGB", base.size, fill_color)
    blurred_fill = base.filter(ImageFilter.GaussianBlur(radius=10))
    mixed_fill = Image.blend(blurred_fill, flat_fill, 0.65)

    rough = base.copy()
    rough.paste(mixed_fill, mask=mask_l)

    # Give the edit model a clean but not razor-sharp guide. The hard original
    # app mask is still used later for the real composite boundary.
    soft_mask = mask_l.filter(ImageFilter.GaussianBlur(radius=1.5))
    return Image.composite(rough, base, soft_mask)


def estimate_local_fill_color(image: Image.Image, erase_mask: Image.Image) -> tuple[int, int, int]:
    bbox = erase_mask.getbbox()
    if bbox is None:
        return (255, 255, 255)

    x0, y0, x1, y1 = bbox
    ring_padding = 24
    sample_box = (
        max(0, x0 - ring_padding),
        max(0, y0 - ring_padding),
        min(image.width, x1 + ring_padding),
        min(image.height, y1 + ring_padding),
    )
    crop = image.crop(sample_box).convert("RGB")
    mask_crop = erase_mask.crop(sample_box).convert("L")

    samples: list[tuple[int, int, int]] = []
    pixels = crop.load()
    mask_pixels = mask_crop.load()
    step = 2 if crop.width * crop.height > 4096 else 1
    for y in range(0, crop.height, step):
        for x in range(0, crop.width, step):
            if mask_pixels[x, y] <= 16:
                samples.append(pixels[x, y])

    if not samples:
        return (255, 255, 255)

    def median_channel(index: int) -> int:
        values = sorted(pixel[index] for pixel in samples)
        return int(values[len(values) // 2])

    return (median_channel(0), median_channel(1), median_channel(2))


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


def inpaint_crop_bounds(image: Image.Image, mask: Image.Image, mask_padding: int) -> tuple[int, int, int, int] | None:
    min_x = mask.width
    min_y = mask.height
    max_x = -1
    max_y = -1
    pixels = mask.load()
    for y in range(mask.height):
        for x in range(mask.width):
            if pixels[x, y] == 0:
                continue
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
    if max_x < min_x or max_y < min_y:
        return None

    padding = max(INPAINT_CROP_CONTEXT, int(mask_padding or 0))
    x0 = max(0, min_x - padding)
    y0 = max(0, min_y - padding)
    x1 = min(image.width, max_x + 1 + padding)
    y1 = min(image.height, max_y + 1 + padding)

    x0 = (x0 // IMAGE_MULTIPLE) * IMAGE_MULTIPLE
    y0 = (y0 // IMAGE_MULTIPLE) * IMAGE_MULTIPLE
    x1 = ((x1 + IMAGE_MULTIPLE - 1) // IMAGE_MULTIPLE) * IMAGE_MULTIPLE
    y1 = ((y1 + IMAGE_MULTIPLE - 1) // IMAGE_MULTIPLE) * IMAGE_MULTIPLE
    x1 = min(image.width, x1)
    y1 = min(image.height, y1)

    if x1 <= x0 or y1 <= y0:
        return None
    if x0 == 0 and y0 == 0 and x1 == image.width and y1 == image.height:
        return None
    return (x0, y0, x1, y1)


def composite_inpaint_crop(
    original: Image.Image,
    generated_crop: Image.Image,
    mask_crop: Image.Image,
    bounds: tuple[int, int, int, int],
) -> Image.Image:
    x0, y0, x1, y1 = bounds
    expected_size = (x1 - x0, y1 - y0)
    if generated_crop.size != expected_size:
        generated_crop = generated_crop.resize(expected_size, Image.Resampling.LANCZOS)

    output = original.convert("RGBA")
    generated = generated_crop.convert("RGBA")
    alpha_mask = mask_crop.convert("L")
    for y in range(expected_size[1]):
        for x in range(expected_size[0]):
            alpha = alpha_mask.getpixel((x, y)) / 255.0
            if alpha <= 0:
                continue
            base = output.getpixel((x0 + x, y0 + y))
            next_pixel = generated.getpixel((x, y))
            output.putpixel(
                (x0 + x, y0 + y),
                (
                    int(round(base[0] * (1 - alpha) + next_pixel[0] * alpha)),
                    int(round(base[1] * (1 - alpha) + next_pixel[1] * alpha)),
                    int(round(base[2] * (1 - alpha) + next_pixel[2] * alpha)),
                    base[3],
                ),
            )
    return output


def expand_inference_mask(mask: Image.Image, mask_padding: int) -> Image.Image:
    padding = max(0, int(mask_padding or 0))
    if padding <= 0:
        return mask
    # Koharu expands the mask with L-infinity dilation before converting it to
    # latent mask space. Pillow's MaxFilter with an odd square kernel is the
    # same "any white pixel in this square makes the output white" operation.
    return mask.filter(ImageFilter.MaxFilter(padding * 2 + 1))


def validate_masked_region_changed(input_image: Image.Image, output_image: Image.Image, mask: Image.Image) -> None:
    input_rgb = input_image.convert("RGB")
    output_rgb = output_image.convert("RGB")
    mask_l = mask.convert("L")
    changed_pixels = 0
    total_pixels = 0
    total_delta = 0
    for (r0, g0, b0), (r1, g1, b1), m in zip(input_rgb.getdata(), output_rgb.getdata(), mask_l.getdata()):
        if m <= 16:
            continue
        total_pixels += 1
        delta = abs(r0 - r1) + abs(g0 - g1) + abs(b0 - b1)
        total_delta += delta
        if delta >= 18:
            changed_pixels += 1
    if total_pixels == 0:
        raise RuntimeError("Flux inpainting mask is empty")
    changed_ratio = changed_pixels / total_pixels
    mean_delta = total_delta / max(1, total_pixels)
    if changed_ratio < 0.015 and mean_delta < 3.0:
        raise RuntimeError(
            "Flux ROCm output did not modify the masked text area. "
            "The runtime likely ignored the inpainting mask."
        )


if __name__ == "__main__":
    raise SystemExit(main())
