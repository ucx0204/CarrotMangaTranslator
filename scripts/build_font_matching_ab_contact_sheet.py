"""Build a labeled, pixel-preserving side-by-side font-matching A/B sheet."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


HEADER_HEIGHT = 112
GUTTER = 16
BACKGROUND = (38, 40, 46)
LEFT_HEADER = (62, 64, 70)
RIGHT_HEADER = (13, 99, 122)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        Path("C:/Windows/Fonts/malgunbd.ttf"),
        Path("C:/Windows/Fonts/segoeuib.ttf"),
    ):
        if path.is_file():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def _panel(path: Path, label: str, color: tuple[int, int, int]) -> Image.Image:
    with Image.open(path) as source:
        image = source.convert("RGB")
    panel = Image.new("RGB", (image.width, image.height + HEADER_HEIGHT), color)
    panel.paste(image, (0, HEADER_HEIGHT))
    draw = ImageDraw.Draw(panel)
    draw.text((24, 23), label, font=_font(44), fill=(255, 255, 255))
    return panel


def build(
    left: Path,
    right: Path,
    output: Path,
    *,
    left_label: str,
    right_label: str,
) -> None:
    if not left.is_file() or not right.is_file():
        raise FileNotFoundError("both A/B inputs must be regular files")
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    left_panel = _panel(left, left_label, LEFT_HEADER)
    right_panel = _panel(right, right_label, RIGHT_HEADER)
    if left_panel.size != right_panel.size:
        raise ValueError(
            f"A/B image dimensions differ: {left_panel.size} != {right_panel.size}"
        )
    sheet = Image.new(
        "RGB",
        (left_panel.width * 2 + GUTTER, left_panel.height),
        BACKGROUND,
    )
    sheet.paste(left_panel, (0, 0))
    sheet.paste(right_panel, (left_panel.width + GUTTER, 0))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--left", type=Path, required=True)
    parser.add_argument("--right", type=Path, required=True)
    parser.add_argument("--left-label", required=True)
    parser.add_argument("--right-label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(
        args.left,
        args.right,
        args.output,
        left_label=args.left_label,
        right_label=args.right_label,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
