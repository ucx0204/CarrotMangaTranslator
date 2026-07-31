from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


DEFAULT_COLS = 3
DEFAULT_ROWS = 4
CELL_WIDTH = 620
CELL_HEIGHT = 360


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build exhaustive source-page review sheets for FontCLIP items that "
            "were marked for manual recropping."
        )
    )
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--library-dir", type=Path, required=True)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--manifest",
        type=Path,
        help="Defaults to DATASET_DIR/manifest_masked.jsonl.",
    )
    parser.add_argument("--cols", type=int, default=DEFAULT_COLS)
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def load_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(
            "C:/Windows/Fonts/consolab.ttf"
            if bold
            else "C:/Windows/Fonts/consola.ttf"
        ),
        Path("C:/Windows/Fonts/msgothic.ttc"),
        Path("C:/Windows/Fonts/arial.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    raise FileNotFoundError("No usable QA font was found")


FONT = load_font(18)
FONT_SMALL = load_font(14)
FONT_BOLD = load_font(19, bold=True)


def to_bbox(value: Any, *, field: str, item_id: str) -> list[int]:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"{item_id}: {field} is not a four-value list")
    bbox = [int(component) for component in value]
    if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        raise ValueError(f"{item_id}: invalid {field}={bbox}")
    return bbox


def fit(image: Image.Image, width: int, height: int) -> Image.Image:
    fitted = image.copy()
    fitted.thumbnail((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), "white")
    x = (width - fitted.width) // 2
    y = (height - fitted.height) // 2
    canvas.paste(fitted, (x, y))
    return canvas


def validate_bbox(page: Image.Image, bbox: list[int], *, label: str) -> None:
    x1, y1, x2, y2 = bbox
    if not (0 <= x1 < x2 <= page.width and 0 <= y1 < y2 <= page.height):
        raise ValueError(f"{label}: bbox {bbox} is outside page {page.size}")


def context_crop(
    page: Image.Image,
    current_bbox: list[int],
    proposed_bbox: list[int],
) -> tuple[Image.Image, tuple[int, int]]:
    x1 = min(current_bbox[0], proposed_bbox[0])
    y1 = min(current_bbox[1], proposed_bbox[1])
    x2 = max(current_bbox[2], proposed_bbox[2])
    y2 = max(current_bbox[3], proposed_bbox[3])
    width = x2 - x1
    height = y2 - y1
    margin_x = max(42, int(width * 1.15))
    margin_y = max(42, int(height * 0.55))
    left = max(0, x1 - margin_x)
    top = max(0, y1 - margin_y)
    right = min(page.width, x2 + margin_x)
    bottom = min(page.height, y2 + margin_y)
    return page.crop((left, top, right, bottom)), (left, top)


def overlay_bbox(
    draw: ImageDraw.ImageDraw,
    bbox: list[int],
    origin: tuple[int, int],
    color: tuple[int, int, int],
    width: int,
) -> None:
    left, top = origin
    x1, y1, x2, y2 = bbox
    draw.rectangle(
        (x1 - left, y1 - top, x2 - left - 1, y2 - top - 1),
        outline=color,
        width=width,
    )


def build_proposals(
    journal_rows: list[dict[str, Any]],
    manifest_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    proposals: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sheet in sorted(journal_rows, key=lambda row: int(row["sheet_index"])):
        sheet_index = int(sheet["sheet_index"])
        for decision in sorted(
            sheet["decisions"], key=lambda row: int(row["cell_index"])
        ):
            if decision["decision"] != "recrop":
                continue
            item_id = str(decision["id"])
            if item_id in seen:
                raise ValueError(f"Duplicate recrop item ID: {item_id}")
            seen.add(item_id)
            manifest = manifest_by_id.get(item_id)
            if manifest is None:
                raise KeyError(f"Recrop item is missing from manifest: {item_id}")
            source_bbox = to_bbox(
                manifest.get("bbox_px") or manifest.get("raw_bbox_px"),
                field="bbox_px",
                item_id=item_id,
            )
            current_bbox = to_bbox(
                manifest["crop_bbox_px"],
                field="crop_bbox_px",
                item_id=item_id,
            )
            tight_bbox = to_bbox(
                manifest.get("ctd_tight_bbox_px") or source_bbox,
                field="ctd_tight_bbox_px",
                item_id=item_id,
            )
            proposals.append(
                {
                    "sequence": len(proposals) + 1,
                    "sheet_index": sheet_index,
                    "cell_index": int(decision["cell_index"]),
                    "id": item_id,
                    "ocr_text": str(manifest.get("ocr_text") or ""),
                    "notes": str(decision.get("notes") or ""),
                    "source_image_path": str(
                        manifest.get("source_image_path")
                        or manifest["source_page_path"]
                    ).replace("\\", "/"),
                    "source_bbox_px": source_bbox,
                    "current_crop_bbox_px": current_bbox,
                    "ctd_tight_bbox_px": tight_bbox,
                    "proposed_bbox_px": source_bbox,
                    "padding_px": 0,
                }
            )
    return proposals


def render_sheet(
    rows: list[dict[str, Any]],
    *,
    library_dir: Path,
    cols: int,
    sheet_rows: int,
    output: Path,
    page_cache: dict[Path, Image.Image],
) -> None:
    sheet_width = cols * CELL_WIDTH
    sheet_height = sheet_rows * CELL_HEIGHT
    canvas = Image.new("RGB", (sheet_width, sheet_height), (245, 247, 250))
    draw = ImageDraw.Draw(canvas)

    for item_index, row in enumerate(rows):
        col = item_index % cols
        grid_row = item_index // cols
        x = col * CELL_WIDTH
        y = grid_row * CELL_HEIGHT
        draw.rectangle(
            (x, y, x + CELL_WIDTH - 1, y + CELL_HEIGHT - 1),
            outline=(90, 105, 120),
            width=1,
        )
        source = (library_dir / row["source_image_path"]).resolve()
        if source not in page_cache:
            page_cache[source] = Image.open(source).convert("RGB")
        page = page_cache[source]
        current_bbox = [int(value) for value in row["current_crop_bbox_px"]]
        proposed_bbox = [int(value) for value in row["proposed_bbox_px"]]
        tight_bbox = [int(value) for value in row["ctd_tight_bbox_px"]]
        validate_bbox(page, current_bbox, label=f"{row['id']} current")
        validate_bbox(page, proposed_bbox, label=f"{row['id']} proposed")
        validate_bbox(page, tight_bbox, label=f"{row['id']} CTD tight")

        draw.text(
            (x + 10, y + 7),
            (
                f"#{int(row['sequence']):04d}  "
                f"sheet {int(row['sheet_index']):03d} "
                f"cell {int(row['cell_index']):02d}"
            ),
            font=FONT_BOLD,
            fill=(20, 25, 30),
        )
        draw.text(
            (x + 10, y + 32),
            str(row["id"]),
            font=FONT_SMALL,
            fill=(20, 25, 30),
        )
        draw.text(
            (x + 10, y + 52),
            (
                f"bbox {proposed_bbox}  "
                "cyan=current red=proposal orange=CTD"
            ),
            font=FONT_SMALL,
            fill=(20, 25, 30),
        )

        context, origin = context_crop(page, current_bbox, proposed_bbox)
        context_draw = ImageDraw.Draw(context)
        overlay_bbox(context_draw, current_bbox, origin, (0, 165, 215), 3)
        overlay_bbox(context_draw, proposed_bbox, origin, (235, 40, 40), 3)
        overlay_bbox(context_draw, tight_bbox, origin, (255, 155, 0), 2)
        canvas.paste(fit(context, 208, 242), (x + 8, y + 80))
        current = page.crop(tuple(current_bbox))
        proposed = page.crop(tuple(proposed_bbox))
        canvas.paste(fit(current, 178, 242), (x + 244, y + 80))
        canvas.paste(fit(proposed, 178, 242), (x + 430, y + 80))
        draw.text(
            (x + 56, y + 326),
            "ORIGINAL CONTEXT",
            font=FONT_SMALL,
            fill=(60, 70, 80),
        )
        draw.text(
            (x + 272, y + 326),
            "CURRENT PADDED",
            font=FONT_SMALL,
            fill=(0, 105, 165),
        )
        draw.text(
            (x + 466, y + 326),
            "PROPOSED",
            font=FONT_SMALL,
            fill=(200, 30, 30),
        )
        note = str(row.get("notes") or "").replace("\n", " ")
        if len(note) > 87:
            note = note[:84] + "..."
        draw.text(
            (x + 10, y + 344),
            note,
            font=FONT_SMALL,
            fill=(60, 70, 80),
        )
    canvas.save(output)


def main() -> None:
    args = parse_args()
    dataset_dir = args.dataset_dir.resolve()
    library_dir = args.library_dir.resolve()
    journal = args.journal.resolve()
    output_dir = args.output_dir.resolve()
    manifest_path = (
        args.manifest.resolve()
        if args.manifest
        else dataset_dir / "manifest_masked.jsonl"
    )
    if args.cols < 1 or args.rows < 1:
        raise ValueError("--cols and --rows must both be positive")
    if output_dir.exists() and any(output_dir.iterdir()) and not args.replace:
        raise FileExistsError(
            f"Output directory is not empty: {output_dir}; use --replace"
        )
    output_dir.mkdir(parents=True, exist_ok=True)

    journal_rows = read_jsonl(journal)
    manifest_rows = read_jsonl(manifest_path)
    manifest_by_id = {str(row["id"]): row for row in manifest_rows}
    if len(manifest_by_id) != len(manifest_rows):
        raise ValueError("Manifest contains duplicate IDs")
    proposals = build_proposals(journal_rows, manifest_by_id)
    if not proposals:
        raise ValueError("Journal does not contain any recrop decisions")

    proposals_path = output_dir / "proposals.jsonl"
    write_jsonl(proposals_path, proposals)
    page_cache: dict[Path, Image.Image] = {}
    cells_per_sheet = args.cols * args.rows
    sheet_count = math.ceil(len(proposals) / cells_per_sheet)
    for sheet_index in range(sheet_count):
        chunk = proposals[
            sheet_index * cells_per_sheet : (sheet_index + 1) * cells_per_sheet
        ]
        render_sheet(
            chunk,
            library_dir=library_dir,
            cols=args.cols,
            sheet_rows=args.rows,
            output=(
                output_dir
                / f"recrop_bbox_proposals_{sheet_index + 1:05d}.png"
            ),
            page_cache=page_cache,
        )
    for image in page_cache.values():
        image.close()

    proposals_sha256 = hashlib.sha256(proposals_path.read_bytes()).hexdigest()
    summary = {
        "schema_version": 1,
        "journal": str(journal),
        "journal_sha256": hashlib.sha256(journal.read_bytes()).hexdigest(),
        "manifest": str(manifest_path),
        "manifest_sha256": hashlib.sha256(
            manifest_path.read_bytes()
        ).hexdigest(),
        "proposal_count": len(proposals),
        "sheet_count": sheet_count,
        "cells_per_sheet": cells_per_sheet,
        "proposals": proposals_path.name,
        "proposals_sha256": proposals_sha256,
    }
    (output_dir / "proposal_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"proposals={len(proposals)} sheets={sheet_count} "
        f"output={output_dir}"
    )


if __name__ == "__main__":
    main()
