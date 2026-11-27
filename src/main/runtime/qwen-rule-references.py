"""Create two identically framed references for print crossing a panel edge."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def write_references(cv2, source, stencil, box, size, radius, first, second, mask):
    with Image.open(source) as src, Image.open(stencil) as ink:
        if src.size != ink.size or not (1 <= radius <= 12):
            raise ValueError("Invalid native stencil for paired Qwen references")
        x, y, w, h = box
        if min(x, y) < 0 or min(w, h) <= 0 or x+w > src.width or y+h > src.height:
            raise ValueError("The paired Qwen window is outside the source crop")
        bounds = (x, y, x+w, y+h)
        rgb = np.asarray(src.crop(bounds).convert("RGB"))
        selected = np.uint8(np.asarray(ink.crop(bounds).convert("L")) > 127)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1, 2*radius+1))
    knockout = cv2.dilate(selected, kernel)
    guide = cv2.inpaint(rgb, knockout, 5, cv2.INPAINT_NS)
    Image.fromarray(guide).resize(size, Image.Resampling.LANCZOS).save(first)
    Image.fromarray(rgb).resize(size, Image.Resampling.LANCZOS).save(second)
    Image.fromarray(knockout*255).resize(size, Image.Resampling.NEAREST).save(mask)


def write_display_references(source, guide, box, size, first, second, mask):
    x, y, w, h = box
    with Image.open(guide) as prepared, Image.open(source) as original:
        if prepared.size != (w, h) or min(x, y) < 0 or x+w > original.width or y+h > original.height:
            raise ValueError("The measured colour reference is outside the original crop")
        prepared.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(first)
        original.crop((x, y, x+w, y+h)).convert("RGB").resize(size, Image.Resampling.LANCZOS).save(second)
        Image.new("L", size, 255).save(mask)


def write_native_ink(source, stencil, size, first, mask):
    from scipy.ndimage import distance_transform_edt
    with Image.open(source) as original, Image.open(stencil) as selection:
        if original.size != selection.size:
            raise ValueError("The print stencil and its original must have the same size")
        original.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(first)
        inside = np.asarray(selection.convert("L")) > 127
        halo = inside.any() & (distance_transform_edt(~inside) <= 3.5)
        Image.fromarray(halo.astype("u1")*255).resize(size, Image.Resampling.NEAREST).save(mask)


if __name__ == "__main__":
    package, source, stencil, first, second, mask = sys.argv[1:7]
    sys.path.insert(0, str(Path(package).resolve()))
    x, y, w, h, width, height = map(int, sys.argv[7:13])
    if sys.argv[13] == "native-ink":
        write_native_ink(source, stencil, (width, height), first, mask)
    elif sys.argv[13] == "display":
        write_display_references(source, stencil, (x, y, w, h), (width, height), first, second, mask)
    else:
        import cv2
        write_references(cv2, source, stencil, (x, y, w, h), (width, height), int(sys.argv[13]), first, second, mask)
