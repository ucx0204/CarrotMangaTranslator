#!/usr/bin/env python3
"""Export bbox-only PaddleOCR-VL candidates for manga translation.

The app intentionally passes only geometry hints to GPT. Source text is read
from the image by the translation model so a bad OCR transcript cannot poison
the translation pass.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
  from PIL import Image
except Exception:  # pragma: no cover - reported with the PaddleOCR install error path.
  Image = None


IGNORED_LABELS = {
    "image",
    "header_image",
    "footer_image",
    "chart",
    "table",
    "figure",
    "seal",
    "formula",
    "display_formula",
    "inline_formula",
    "number",
    "footer",
    "header",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run PaddleOCR-VL and write bbox-only JSON.")
    parser.add_argument("--image", default=None, help="Input image path.")
    parser.add_argument("--output", default=None, help="Output JSON path.")
    parser.add_argument("--batch", default=None, help="JSON batch manifest with image/output items.")
    parser.add_argument("--pipeline-version", default="v1.5", choices=["v1", "v1.5"])
    parser.add_argument("--device", default=None, help="Optional Paddle device, e.g. gpu:0 or cpu.")
    args = parser.parse_args()
    if args.device:
      os.environ["MANGA_TRANSLATOR_PADDLEOCR_DEVICE"] = args.device

    try:
      from paddleocr import PaddleOCRVL
    except Exception as exc:  # pragma: no cover - depends on optional local install.
      raise RuntimeError(
          "PaddleOCR-VL is not installed. Install paddleocr/paddlex and PaddlePaddle, "
          "or provide MANGA_TRANSLATOR_OCR_BBOX_CMD."
      ) from exc
    if Image is None:
      raise RuntimeError("Pillow is not installed, so image dimensions cannot be read.")

    batch_items = load_batch_items(args)
    if not batch_items:
      raise RuntimeError("Provide --image/--output or --batch with at least one item.")

    ensure_requested_device(args.device)

    pipeline = PaddleOCRVL(**build_pipeline_kwargs(args))
    textline_detector = create_textline_detector()
    try:
      summaries = []
      total = len(batch_items)
      for index, item in enumerate(batch_items, start=1):
        summary = write_page_bboxes(
            image_path=Path(item["image"]),
            output_path=Path(item["output"]),
            pipeline=pipeline,
            textline_detector=textline_detector,
        )
        summaries.append(summary)
        print(
            json.dumps(
                {
                    "index": index,
                    "total": total,
                    "output": summary["output"],
                    "count": summary["count"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    finally:
      close = getattr(pipeline, "close", None)
      if callable(close):
        close()
      close_textline_detector(textline_detector)

    print(json.dumps({"items": summaries, "count": len(summaries)}, ensure_ascii=False))
    return 0


def load_batch_items(args: argparse.Namespace) -> list[dict]:
    if args.batch:
      raw = json.loads(Path(args.batch).read_text(encoding="utf-8"))
      items = raw.get("items") if isinstance(raw, dict) else raw
      if not isinstance(items, list):
        raise RuntimeError("--batch must contain a list or an object with items.")
      result = []
      for item in items:
        if not isinstance(item, dict) or not item.get("image") or not item.get("output"):
          raise RuntimeError("Each batch item needs image and output.")
        result.append({"image": str(item["image"]), "output": str(item["output"])})
      return result
    if args.image and args.output:
      return [{"image": args.image, "output": args.output}]
    return []


def build_pipeline_kwargs(args: argparse.Namespace) -> dict:
    pipeline_kwargs = {
        "pipeline_version": args.pipeline_version,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_layout_detection": True,
        "use_chart_recognition": False,
        "use_seal_recognition": False,
        "use_ocr_for_image_block": False,
        "format_block_content": False,
        "merge_layout_blocks": False,
    }
    if args.device:
      pipeline_kwargs["device"] = args.device
    return pipeline_kwargs


def write_page_bboxes(image_path: Path, output_path: Path, pipeline: object, textline_detector: object) -> dict:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(image_path) as image:
      width, height = image.size

    results = pipeline.predict(
        str(image_path),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_layout_detection=True,
        use_chart_recognition=False,
        use_seal_recognition=False,
        use_ocr_for_image_block=False,
        format_block_content=False,
        merge_layout_blocks=False,
    )
    items = []
    for result in results:
      for block in result.get("parsing_res_list", []) or []:
        label = normalize_label(getattr(block, "label", None))
        if label in IGNORED_LABELS:
          continue
        bbox = getattr(block, "bbox", None)
        if not bbox or len(bbox) < 4:
          continue
        x1, y1, x2, y2 = [int(round(float(value))) for value in bbox[:4]]
        if x2 <= x1 or y2 <= y1:
          continue
        items.append(
            {
                "id": len(items) + 1,
                "label": label or "text",
                "x1": clamp(x1, 0, width),
                "y1": clamp(y1, 0, height),
                "x2": clamp(x2, 0, width),
                "y2": clamp(y2, 0, height),
            }
        )

    items.extend(
        collect_textline_candidates(
            image_path=image_path,
            existing_items=items,
            width=width,
            height=height,
            ocr=textline_detector,
        )
    )
    renumber_items(items)

    payload = {
        "source": "paddleocr-vl",
        "coordinateSpace": "pixels",
        "width": width,
        "height": height,
        "items": items,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"output": str(output_path), "count": len(items)}


def ensure_requested_device(device: str | None) -> None:
    if not device or not device.lower().startswith("gpu"):
      return
    try:
      import paddle
    except Exception as exc:
      raise RuntimeError("GPU OCR was requested, but PaddlePaddle is not importable.") from exc

    if not paddle.device.is_compiled_with_cuda():
      raise RuntimeError("GPU OCR was requested, but the installed PaddlePaddle package is CPU-only.")

    try:
      device_count = int(paddle.device.cuda.device_count())
    except Exception as exc:
      raise RuntimeError("GPU OCR was requested, but PaddlePaddle cannot query CUDA devices.") from exc

    if device_count <= 0:
      raise RuntimeError("GPU OCR was requested, but no CUDA device is visible to PaddlePaddle.")

    try:
      paddle.set_device(device)
    except Exception as exc:
      raise RuntimeError(f"GPU OCR was requested, but PaddlePaddle could not use device {device!r}.") from exc


def normalize_label(value: object) -> str:
    text = str(value or "text").strip().lower()
    return "".join(char if char.isalnum() or char in "-_" else "_" for char in text) or "text"


def clamp(value: int, lower: int, upper: int) -> int:
    return max(lower, min(upper, value))


def create_textline_detector() -> object:
    if os.environ.get("MANGA_TRANSLATOR_DISABLE_PADDLEOCR_LINES", "").lower() in {"1", "true", "yes", "on"}:
      return None

    try:
      from paddleocr import PaddleOCR
      ocr_kwargs = {
          "lang": "japan",
          "use_doc_orientation_classify": False,
          "use_doc_unwarping": False,
          "use_textline_orientation": False,
          "text_det_limit_side_len": int(os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT", "1600")),
          "text_det_limit_type": "max",
          "enable_mkldnn": False,
      }
      if os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_DEVICE"):
        ocr_kwargs["device"] = os.environ["MANGA_TRANSLATOR_PADDLEOCR_DEVICE"]
      return PaddleOCR(**ocr_kwargs)
    except Exception as exc:
      print(f"[paddleocr-vl-bboxes] textline detector unavailable: {exc}", file=sys.stderr)
      return None


def close_textline_detector(ocr: object) -> None:
    close = getattr(ocr, "close", None)
    if callable(close):
      close()


def collect_textline_candidates(image_path: Path, existing_items: list[dict], width: int, height: int, ocr: object = None) -> list[dict]:
    """Add ordinary OCR detection boxes that are not covered by VL layout.

    PaddleOCR-VL is good at grouping dialogue/caption text, but it can miss
    small manga SFX. PP-OCR text detection tends to catch those strokes. We
    only add boxes whose center is outside existing VL candidates so normal
    dialogue columns do not explode into one record per line.
    """

    if ocr is None:
      return []

    raw_candidates: list[dict] = []
    try:
      results = ocr.predict(str(image_path))
      for result in results:
        data = dict(result)
        rec_texts = data.get("rec_texts") or data.get("texts") or []
        rec_scores = data.get("rec_scores") or data.get("scores") or []
        for index, poly in enumerate(data.get("dt_polys") or []):
          box = bbox_from_poly(poly, width, height)
          if not box:
            continue
          text = str(rec_texts[index] if index < len(rec_texts) else "").strip()
          if text and is_probable_symbol_noise(text):
            continue
          x1, y1, x2, y2 = box
          box_width = x2 - x1
          box_height = y2 - y1
          if box_width < 6 or box_height < 6 or box_width * box_height < 200:
            continue
          if is_covered_by_existing_box(box, existing_items):
            continue
          score = None
          try:
            score = float(rec_scores[index]) if index < len(rec_scores) else None
          except Exception:
            score = None
          raw_candidates.append(
              {
                  "label": "ocr_textline",
                  "x1": x1,
                  "y1": y1,
                  "x2": x2,
                  "y2": y2,
                  "_score": score,
              }
          )
    except Exception as exc:
      print(f"[paddleocr-vl-bboxes] textline detector failed: {exc}", file=sys.stderr)

    grouped = merge_textline_candidates(raw_candidates, width, height)
    for index, item in enumerate(grouped):
      item["id"] = len(existing_items) + index + 1
      score = item.pop("_score", None)
      if isinstance(score, float):
        item["score"] = round(score, 4)
    return grouped


def renumber_items(items: list[dict]) -> None:
    for index, item in enumerate(items):
      item["id"] = index + 1


def is_probable_symbol_noise(text: str) -> bool:
    normalized = "".join(char for char in text.strip() if not char.isspace())
    if not normalized:
      return False
    if any(char in normalized for char in "←→↑↓↔↕⇔⇒⇐⇧⇩⇨⇦"):
      return True
    japanese_count = count_japanese_chars(normalized)
    if japanese_count > 0:
      return False
    return len(normalized) <= 3 and all(not char.isalnum() for char in normalized)


def count_japanese_chars(text: str) -> int:
    count = 0
    for char in text:
      code = ord(char)
      if (
          0x3040 <= code <= 0x30FF
          or 0x3400 <= code <= 0x4DBF
          or 0x4E00 <= code <= 0x9FFF
          or 0xF900 <= code <= 0xFAFF
      ):
        count += 1
    return count


def merge_textline_candidates(candidates: list[dict], width: int, height: int) -> list[dict]:
    """Merge low-level OCR text lines into cleaner geometry hints.

    The ordinary OCR detector is intentionally used only as a fallback for
    small missed text. On handwritten diagrams it often returns one candidate
    per scribbled line, which makes the translator render a pile of tiny SFX
    labels. Grouping close text lines gives the model a better semantic unit
    while still preserving the OCR-detected source area.
    """

    if len(candidates) < 2:
      return candidates

    parent = list(range(len(candidates)))

    def find(index: int) -> int:
      while parent[index] != index:
        parent[index] = parent[parent[index]]
        index = parent[index]
      return index

    def union(left: int, right: int) -> None:
      left_root = find(left)
      right_root = find(right)
      if left_root != right_root:
        parent[right_root] = left_root

    for left in range(len(candidates)):
      for right in range(left + 1, len(candidates)):
        if should_merge_textline_boxes(candidates[left], candidates[right], width, height):
          union(left, right)

    groups: dict[int, list[dict]] = {}
    for index, item in enumerate(candidates):
      groups.setdefault(find(index), []).append(item)

    merged: list[dict] = []
    for group in groups.values():
      group.sort(key=lambda item: (item["y1"], item["x1"]))
      if len(group) == 1:
        item = dict(group[0])
        merged.append(item)
        continue
      x1 = min(int(item["x1"]) for item in group)
      y1 = min(int(item["y1"]) for item in group)
      x2 = max(int(item["x2"]) for item in group)
      y2 = max(int(item["y2"]) for item in group)
      scores = [item.get("_score") for item in group if isinstance(item.get("_score"), float)]
      merged.append(
          {
              "label": "ocr_textgroup",
              "x1": clamp(x1, 0, width),
              "y1": clamp(y1, 0, height),
              "x2": clamp(x2, 0, width),
              "y2": clamp(y2, 0, height),
              "_score": sum(scores) / len(scores) if scores else None,
          }
      )

    merged.sort(key=lambda item: (int(item["y1"]), int(item["x1"])))
    return merged


def should_merge_textline_boxes(a: dict, b: dict, page_width: int, page_height: int) -> bool:
    ax1, ay1, ax2, ay2 = box_tuple(a)
    bx1, by1, bx2, by2 = box_tuple(b)
    aw = ax2 - ax1
    ah = ay2 - ay1
    bw = bx2 - bx1
    bh = by2 - by1
    if aw <= 0 or ah <= 0 or bw <= 0 or bh <= 0:
      return False

    union_x1 = min(ax1, bx1)
    union_y1 = min(ay1, by1)
    union_x2 = max(ax2, bx2)
    union_y2 = max(ay2, by2)
    union_w = union_x2 - union_x1
    union_h = union_y2 - union_y1
    if union_w * union_h > page_width * page_height * 0.1:
      return False
    if union_h > page_height * 0.34 or union_w > page_width * 0.45:
      return False

    horizontal_a = aw >= ah * 0.75
    horizontal_b = bw >= bh * 0.75
    vertical_a = ah > aw * 1.25
    vertical_b = bh > bw * 1.25

    gap_x = max(0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0, max(ay1, by1) - min(ay2, by2))
    center_x_delta = abs((ax1 + ax2) / 2 - (bx1 + bx2) / 2)
    center_y_delta = abs((ay1 + ay2) / 2 - (by1 + by2) / 2)

    if horizontal_a and horizontal_b:
      y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
      x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
      if y_overlap > 0.12:
        if center_x_delta <= 118:
          return True
        if x_overlap > 0.12 and center_y_delta <= max(32, min(ah, bh) * 0.45):
          return True
      if gap_y > 0 and gap_y <= max(18, min(ah, bh) * 0.32) and center_x_delta <= 112:
        return True
      return False

    if vertical_a and vertical_b:
      y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
      x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
      if x_overlap > 0.08 and center_y_delta <= max(220, (ah + bh) * 0.7):
        return True
      if gap_x <= max(18, min(aw, bw) * 0.65) and y_overlap > 0.2:
        return True
      return False

    overlap = overlap_ratio((ax1, ay1, ax2, ay2), (bx1, by1, bx2, by2))
    if overlap > 0.22:
      return True
    return gap_x <= 16 and gap_y <= 16


def box_tuple(item: dict) -> tuple[int, int, int, int]:
    return (int(item["x1"]), int(item["y1"]), int(item["x2"]), int(item["y2"]))


def axis_overlap_ratio(a1: float, a2: float, b1: float, b2: float) -> float:
    overlap = max(0.0, min(a2, b2) - max(a1, b1))
    shortest = max(1.0, min(a2 - a1, b2 - b1))
    return overlap / shortest


def bbox_from_poly(poly: object, width: int, height: int) -> tuple[int, int, int, int] | None:
    points = []
    if poly is None:
      return None
    for point in poly:
      try:
        x = float(point[0])
        y = float(point[1])
      except Exception:
        continue
      points.append((x, y))
    if not points:
      return None
    x1 = clamp(int(round(min(point[0] for point in points))), 0, width)
    y1 = clamp(int(round(min(point[1] for point in points))), 0, height)
    x2 = clamp(int(round(max(point[0] for point in points))), 0, width)
    y2 = clamp(int(round(max(point[1] for point in points))), 0, height)
    if x2 <= x1 or y2 <= y1:
      return None
    return (x1, y1, x2, y2)


def is_covered_by_existing_box(box: tuple[int, int, int, int], existing_items: list[dict]) -> bool:
    x1, y1, x2, y2 = box
    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2
    for item in existing_items:
      item_x1 = float(item.get("x1", 0))
      item_y1 = float(item.get("y1", 0))
      item_x2 = float(item.get("x2", 0))
      item_y2 = float(item.get("y2", 0))
      if item_x1 <= center_x <= item_x2 and item_y1 <= center_y <= item_y2:
        return True
      if overlap_ratio(box, (item_x1, item_y1, item_x2, item_y2)) > 0.35:
        return True
    return False


def overlap_ratio(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    left = max(a[0], b[0])
    top = max(a[1], b[1])
    right = min(a[2], b[2])
    bottom = min(a[3], b[3])
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    min_area = max(1.0, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))
    return overlap / min_area


if __name__ == "__main__":
    try:
      raise SystemExit(main())
    except Exception as exc:
      print(f"[paddleocr-vl-bboxes] {exc}", file=sys.stderr)
      raise
