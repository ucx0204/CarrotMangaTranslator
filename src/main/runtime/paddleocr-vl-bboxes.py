#!/usr/bin/env python3
"""Export PaddleOCR-VL geometry candidates for manga translation.

OCR transcripts are included only as low-trust alignment hints. The
translation model still reads the source image as the authority.
"""

from __future__ import annotations

import argparse
from collections import deque
import gc
import json
import math
import os
import sys
from pathlib import Path

# The bundled Windows interpreter is isolated by python312._pth, so it does
# not add this script's directory to sys.path automatically.
RUNTIME_MODULE_PATH = str(Path(__file__).resolve().parent)
if RUNTIME_MODULE_PATH not in sys.path:
    sys.path.insert(0, RUNTIME_MODULE_PATH)

from paddleocr_review_contexts import build_textline_review_context_ids

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


DLL_DIRECTORY_HANDLES = []
TORCH_ROCM_SAFE_MODE_CONFIGURED = False
SELECTED_CUDA_DEVICE_INDEX = None


def configure_windows_dll_search_path() -> None:
    raw_dirs = os.environ.get("MANGA_TRANSLATOR_OCR_DLL_DIRS", "")
    if not raw_dirs or not hasattr(os, "add_dll_directory"):
        return
    for entry in raw_dirs.split(os.pathsep):
        candidate = entry.strip()
        if candidate and os.path.isdir(candidate):
            DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(candidate))


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run PaddleOCR-VL and write geometry hint JSON.")
    parser.add_argument("--image", default=None, help="Input image path.")
    parser.add_argument("--output", default=None, help="Output JSON path.")
    parser.add_argument("--batch", default=None, help="JSON batch manifest with image/output items.")
    parser.add_argument("--progress", default=None, help="Optional JSONL progress output path.")
    parser.add_argument("--pipeline-version", default="v1.5", choices=["v1", "v1.5"])
    parser.add_argument("--device", default=None, help="Optional Paddle device, e.g. gpu:0 or cpu.")
    parser.add_argument(
        "--source-language",
        default=os.environ.get("MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE", "ja"),
        help="Translation source language code, e.g. ja, en, zh-Hans, fr.",
    )
    parser.add_argument("--bbox-mode", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE", "vl"), choices=["vl", "ocr"])
    parser.add_argument("--engine", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ENGINE", "paddle"))
    parser.add_argument("--dtype", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE", "float32"))
    parser.add_argument("--ocr-version", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_VERSION", "PP-OCRv6"))
    parser.add_argument(
        "--text-detection-model-name",
        default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME"),
    )
    parser.add_argument(
        "--text-recognition-model-name",
        default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME"),
    )
    parser.add_argument(
        "--merge-mode",
        default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE"),
        choices=["legacy", "conservative", "semantic", "none"],
    )
    return parser


def main() -> int:
    args = build_argument_parser().parse_args()
    if args.device:
      os.environ["MANGA_TRANSLATOR_PADDLEOCR_DEVICE"] = args.device

    configure_windows_dll_search_path()
    if Image is None:
      raise RuntimeError("Pillow is not installed, so image dimensions cannot be read.")

    batch_items = load_batch_items(args)
    if not batch_items:
      raise RuntimeError("Provide --image/--output or --batch with at least one item.")

    ensure_requested_device(args)

    if args.bbox_mode == "ocr":
      textline_detector = create_textline_detector(args, required=True)
      source = "paddleocr-ppocrv6-transformers" if is_transformers_engine(args) else "paddleocr-ppocrv6"
      try:
        summaries = run_batch_pages(
            args,
            batch_items,
            lambda item: write_page_bboxes_from_ocr(
                image_path=Path(item["image"]),
                output_path=Path(item["output"]),
                ocr=textline_detector,
                source=source,
                merge_mode=resolve_textline_merge_mode(args, default="conservative"),
                args=args,
            ),
        )
      finally:
        close_textline_detector(textline_detector)

      print(json.dumps({"items": summaries, "count": len(summaries)}, ensure_ascii=False), flush=True)
      return 0

    if is_transformers_engine(args):
      raise RuntimeError("PaddleOCRVL bbox mode does not support the Transformers engine yet. Use --bbox-mode ocr.")

    try:
      from paddleocr import PaddleOCRVL
    except Exception as exc:  # pragma: no cover - depends on optional local install.
      raise RuntimeError(
          "PaddleOCR-VL is not installed. Install paddleocr/paddlex and PaddlePaddle, "
          "or provide MANGA_TRANSLATOR_OCR_BBOX_CMD."
      ) from exc

    pipeline = PaddleOCRVL(**build_pipeline_kwargs(args))
    textline_detector = create_textline_detector(args)
    try:
      summaries = run_batch_pages(
          args,
          batch_items,
          lambda item: write_page_bboxes(
              image_path=Path(item["image"]),
              output_path=Path(item["output"]),
              pipeline=pipeline,
              textline_detector=textline_detector,
              args=args,
          ),
      )
    finally:
      close = getattr(pipeline, "close", None)
      if callable(close):
        close()
      close_textline_detector(textline_detector)

    print(json.dumps({"items": summaries, "count": len(summaries)}, ensure_ascii=False), flush=True)
    return 0


def emit_progress(progress_path: str | None, payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    print(line, flush=True)
    if not progress_path:
      return

    target = Path(progress_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as file:
      file.write(line)
      file.write("\n")
      file.flush()


def run_batch_pages(args: argparse.Namespace, batch_items: list[dict], process_page) -> list[dict]:
    """Process pages in order and stop the batch on the first page failure."""

    summaries = []
    total = len(batch_items)
    gpu_transformers = is_gpu_transformers_run(args)
    for index, item in enumerate(batch_items, start=1):
      emit_progress(
          args.progress,
          {
              "phase": "start",
              "index": index,
              "total": total,
              "output": str(item["output"]),
              "count": 0,
          },
      )
      try:
        summary = process_page(item)
      except Exception:
        release_gpu_memory()
        emit_progress(
            args.progress,
            {
                "phase": "error",
                "index": index,
                "total": total,
                "output": str(item["output"]),
                "count": 0,
            },
        )
        raise
      summaries.append(summary)
      emit_progress(
          args.progress,
          {
              "phase": "done",
              "index": index,
              "total": total,
              "output": summary["output"],
              "count": summary["count"],
          },
      )
      if gpu_transformers:
        release_gpu_memory()
    return summaries


def is_gpu_transformers_run(args: argparse.Namespace | None) -> bool:
    device = str(getattr(args, "device", "") or "").lower()
    return device.startswith("gpu") and bool(args and is_transformers_engine(args))


def release_gpu_memory() -> None:
    """Best-effort GPU allocator cleanup between pages (torch and paddle)."""

    gc.collect()
    try:
      import torch
      if torch.cuda.is_available():
        torch.cuda.empty_cache()
    except Exception:
      pass
    try:
      import paddle
      if paddle.device.is_compiled_with_cuda():
        paddle.device.cuda.empty_cache()
    except Exception:
      pass


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
    if is_transformers_engine(args):
      raise RuntimeError("PaddleOCRVL bbox mode does not support the Transformers engine yet. Use --bbox-mode ocr.")
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


def is_transformers_engine(args: argparse.Namespace) -> bool:
    return str(getattr(args, "engine", "") or "").strip().lower() == "transformers"


def parse_device_id(device: str | None) -> int:
    text = str(device or "").strip().lower()
    if ":" not in text:
      return 0
    try:
      return max(0, int(text.rsplit(":", 1)[1]))
    except Exception:
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


def select_preferred_cuda_device(args: argparse.Namespace) -> int:
    """Pick the largest-VRAM CUDA/HIP device when several are visible.

    Windows ROCm enumerates iGPUs next to the discrete GPU and device 0 is
    not guaranteed to be the discrete card, so default runs pick by VRAM.
    Explicit --device gpu:N (N > 0) or visible-devices env vars win.
    """

    global SELECTED_CUDA_DEVICE_INDEX
    explicit_index = parse_device_id(getattr(args, "device", None))
    try:
      import torch

      if has_visible_devices_override() or explicit_index > 0:
        torch.cuda.set_device(explicit_index)
        SELECTED_CUDA_DEVICE_INDEX = explicit_index
        return explicit_index

      best_index = 0
      count = int(torch.cuda.device_count())
      if count > 1:
        best_bytes = -1
        for index in range(count):
          total_bytes = int(torch.cuda.get_device_properties(index).total_memory)
          if total_bytes > best_bytes:
            best_bytes = total_bytes
            best_index = index
        if best_index != 0:
          print(
              f"[paddleocr-vl-bboxes] selected CUDA/HIP device {best_index} (largest VRAM) out of {count} visible devices.",
              file=sys.stderr,
          )
      torch.cuda.set_device(best_index)
      SELECTED_CUDA_DEVICE_INDEX = best_index
      return best_index
    except Exception as exc:
      print(
          f"[paddleocr-vl-bboxes] warning: could not select preferred GPU device: {exc}",
          file=sys.stderr,
      )
      SELECTED_CUDA_DEVICE_INDEX = explicit_index
      return explicit_index


def resolve_engine_device_id(device: str | None) -> int:
    explicit = parse_device_id(device)
    if explicit > 0:
      return explicit
    if isinstance(SELECTED_CUDA_DEVICE_INDEX, int):
      return SELECTED_CUDA_DEVICE_INDEX
    return explicit


def resolve_transformers_attention_implementation() -> str:
    value = os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ATTN", "eager")
    return str(value or "eager").strip() or "eager"


def is_truthy_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
      return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


def configure_torch_for_transformers_ocr(args: argparse.Namespace | None) -> None:
    """Apply conservative ROCm/PyTorch settings before model construction."""

    if not args or not is_transformers_engine(args):
      return

    try:
      import torch
    except Exception:
      return

    torch.set_grad_enabled(False)

    device = str(getattr(args, "device", "") or "").lower()
    is_gpu = device.startswith("gpu")
    is_rocm = bool(getattr(torch.version, "hip", None))
    if not is_gpu or not is_rocm:
      return

    if not is_truthy_env("MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN", True):
      return

    global TORCH_ROCM_SAFE_MODE_CONFIGURED
    try:
      torch.backends.cudnn.enabled = False
      torch.backends.cudnn.benchmark = False
      torch.backends.cudnn.deterministic = True
      miopen_backend = getattr(torch.backends, "miopen", None)
      if miopen_backend is not None and hasattr(miopen_backend, "enabled"):
        miopen_backend.enabled = False
    except Exception as exc:
      print(
          f"[paddleocr-vl-bboxes] warning: could not disable MIOpen/cuDNN backend: {exc}",
          file=sys.stderr,
      )
      return

    if not TORCH_ROCM_SAFE_MODE_CONFIGURED:
      print(
          "[paddleocr-vl-bboxes] ROCm safe GPU mode: disabled MIOpen/cuDNN convolution backend for PaddleOCR Transformers.",
          file=sys.stderr,
      )
      TORCH_ROCM_SAFE_MODE_CONFIGURED = True


def resolve_text_det_limit(args: argparse.Namespace | None) -> int:
    transformers_engine = bool(args and is_transformers_engine(args))
    fallback = "1600"
    try:
      return max(
          320,
          int(os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT", fallback)),
      )
    except Exception:
      return int(fallback)


def predict_with_torch_inference_mode(ocr: object, image_path: Path, transformers_engine: bool) -> object:
    if not transformers_engine:
      return ocr.predict(str(image_path))
    try:
      import torch
      with torch.inference_mode():
        return ocr.predict(str(image_path))
    except ImportError:
      return ocr.predict(str(image_path))


def materialize_result_sequence(value: object) -> list:
    """Convert list-like OCR output without invoking numpy's ambiguous bool."""

    if value is None or isinstance(value, (str, bytes, bytearray, dict)):
      return []
    try:
      return list(value)
    except (TypeError, ValueError):
      return []


def read_result_sequence(data: dict, key: str, *aliases: str) -> list:
    """Read a canonical OCR array; aliases apply only when it is absent."""

    if key in data and data.get(key) is not None:
      return materialize_result_sequence(data.get(key))
    for alias in aliases:
      if alias in data and data.get(alias) is not None:
        return materialize_result_sequence(data.get(alias))
    return []


def collect_recognized_ocr_entries(result: object) -> list[tuple[object, str, float | None]]:
    """Align filtered recognition metadata while preserving detector geometry."""

    data = dict(result)
    dt_polys = read_result_sequence(data, "dt_polys")
    rec_texts = read_result_sequence(data, "rec_texts", "texts")
    rec_scores = read_result_sequence(data, "rec_scores", "scores")
    has_rec_polys = "rec_polys" in data and data.get("rec_polys") is not None
    if not has_rec_polys:
      texts_aligned = len(rec_texts) == len(dt_polys)
      scores_aligned = len(rec_scores) == len(dt_polys)
      return [
          (
              poly,
              normalized_result_text(rec_texts[index]) if texts_aligned else "",
              normalized_result_score(rec_scores[index])
              if scores_aligned
              else None,
          )
          for index, poly in enumerate(dt_polys)
      ]

    # PaddleOCR appends rec_texts, rec_scores, and the matching dt polygon
    # together only after recognition confidence filtering. Match that subset
    # back onto dt_polys instead of shifting later strings by raw array index.
    rec_polys = read_result_sequence(data, "rec_polys")
    texts_aligned = len(rec_texts) == len(rec_polys)
    scores_aligned = len(rec_scores) == len(rec_polys)
    recognized = [
        (
            poly,
            normalized_result_text(rec_texts[index])
            if texts_aligned
            else "",
            normalized_result_score(rec_scores[index])
            if scores_aligned
            else None,
        )
        for index, poly in enumerate(rec_polys)
    ]
    recognized_by_polygon: dict[tuple, deque[int]] = {}
    for index, (poly, _text, _score) in enumerate(recognized):
      signature = ocr_polygon_signature(poly)
      if signature is not None:
        recognized_by_polygon.setdefault(signature, deque()).append(index)

    consumed = [False] * len(recognized)
    entries: list[tuple[object, str, float | None]] = []
    for poly in dt_polys:
      signature = ocr_polygon_signature(poly)
      matches = recognized_by_polygon.get(signature) if signature is not None else None
      if matches:
        recognized_index = matches.popleft()
        consumed[recognized_index] = True
        _rec_poly, text, score = recognized[recognized_index]
        entries.append((poly, text, score))
      else:
        entries.append((poly, "", None))
    entries.extend(
        entry for index, entry in enumerate(recognized) if not consumed[index]
    )
    return entries


def collect_legacy_indexed_ocr_entries(result: object) -> list[tuple[object, str, float | None]]:
    """Preserve the PaddleOCR-VL auxiliary detector's index-pairing contract."""

    data = dict(result)
    dt_polys = read_result_sequence(data, "dt_polys")
    rec_texts = read_result_sequence(data, "rec_texts", "texts")
    rec_scores = read_result_sequence(data, "rec_scores", "scores")
    return [
        (
            poly,
            normalized_result_text(rec_texts[index]) if index < len(rec_texts) else "",
            normalized_result_score(rec_scores[index]) if index < len(rec_scores) else None,
        )
        for index, poly in enumerate(dt_polys)
    ]


def normalized_result_text(value: object) -> str:
    return "" if value is None else str(value).strip()


def normalized_result_score(value: object) -> float | None:
    try:
      score = float(value)
    except (TypeError, ValueError):
      return None
    return score if math.isfinite(score) else None


def ocr_polygon_signature(poly: object) -> tuple | None:
    points = materialize_result_sequence(poly)
    if not points:
      return None
    normalized_points: list[tuple[float, float]] = []
    for point in points:
      coordinates = materialize_result_sequence(point)
      if len(coordinates) < 2:
        return None
      try:
        x = float(coordinates[0])
        y = float(coordinates[1])
      except (TypeError, ValueError):
        return None
      if not math.isfinite(x) or not math.isfinite(y):
        return None
      normalized_points.append((x, y))

    # The same polygon may start at a different vertex or wind in the opposite
    # direction. Canonicalize both without losing duplicate-polygon ordering.
    variants: list[tuple[float, ...]] = []
    for winding in (normalized_points, list(reversed(normalized_points))):
      for offset in range(len(winding)):
        rotated = winding[offset:] + winding[:offset]
        variants.append(tuple(value for point in rotated for value in point))
    return min(variants)


def should_retry_with_eager_attention(exc: Exception, ocr_kwargs: dict) -> bool:
    engine_config = ocr_kwargs.get("engine_config")
    if not isinstance(engine_config, dict):
      return False
    if has_eager_attention_config(engine_config):
      return False
    return is_unsupported_attention_implementation_error(exc)


def has_eager_attention_config(engine_config: dict) -> bool:
    top_level = str(engine_config.get("attn_implementation") or "").strip().lower()
    model_kwargs = engine_config.get("model_kwargs")
    model_level = ""
    if isinstance(model_kwargs, dict):
      model_level = str(model_kwargs.get("attn_implementation") or "").strip().lower()
    return top_level == "eager" and model_level == "eager"


def apply_attention_implementation_to_engine_config(engine_config: dict, attn_implementation: str) -> None:
    value = str(attn_implementation or "eager").strip() or "eager"
    engine_config["attn_implementation"] = value
    model_kwargs = engine_config.get("model_kwargs")
    if not isinstance(model_kwargs, dict):
      model_kwargs = {}
      engine_config["model_kwargs"] = model_kwargs
    model_kwargs["attn_implementation"] = value


def describe_transformers_attention_config(ocr_kwargs: dict) -> str:
    engine_config = ocr_kwargs.get("engine_config")
    if not isinstance(engine_config, dict):
      return "attention config unavailable"
    model_kwargs = engine_config.get("model_kwargs")
    model_level = None
    if isinstance(model_kwargs, dict):
      model_level = model_kwargs.get("attn_implementation")
    return (
        f"attn_implementation={engine_config.get('attn_implementation')!r}, "
        f"model_kwargs.attn_implementation={model_level!r}"
    )


def is_unsupported_attention_implementation_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "attn_implementation" in text
        or "scaled_dot_product_attention" in text
        or "does not support an attention implementation" in text
    )


def write_page_bboxes(
    image_path: Path,
    output_path: Path,
    pipeline: object,
    textline_detector: object,
    args: argparse.Namespace | None = None,
) -> dict:
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
        item = {
            "id": len(items) + 1,
            "label": label or "text",
            "x1": clamp(x1, 0, width),
            "y1": clamp(y1, 0, height),
            "x2": clamp(x2, 0, width),
            "y2": clamp(y2, 0, height),
        }
        ocr_text = clean_ocr_text(extract_block_text(block))
        if ocr_text:
          item["ocrText"] = ocr_text
        items.append(item)

    items.extend(
        collect_textline_candidates(
            image_path=image_path,
            existing_items=items,
            width=width,
            height=height,
            ocr=textline_detector,
            args=args,
        )
    )
    finalize_ocr_text_fields(items)
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


def write_page_bboxes_from_ocr(
    image_path: Path,
    output_path: Path,
    ocr: object,
    source: str,
    merge_mode: str = "conservative",
    args: argparse.Namespace | None = None,
) -> dict:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(image_path) as image:
      width, height = image.size

    if ocr is None:
      raise RuntimeError("PaddleOCR textline detector is unavailable.")

    raw_candidates: list[dict] = []
    results = predict_with_torch_inference_mode(
        ocr,
        image_path,
        source == "paddleocr-ppocrv6-transformers",
    )
    for result in results:
      # OCR-only modes keep the raw detector boxes, so align every recognized
      # string through rec_polys even when the recognizer itself is Paddle
      # static/CUDA. The legacy indexed contract remains confined to the
      # PaddleOCR-VL auxiliary detector below.
      entries = collect_recognized_ocr_entries(result)
      for poly, text, score in entries:
        box = bbox_from_poly(poly, width, height)
        if not box:
          continue
        if text and is_probable_symbol_noise(text):
          continue
        x1, y1, x2, y2 = box
        box_width = x2 - x1
        box_height = y2 - y1
        if box_width < 6 or box_height < 6 or box_width * box_height < 200:
          continue
        text = filter_candidate_ocr_text(text, score, args)
        raw_candidates.append(
            {
                "label": "ocr_textline",
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "_score": score,
                "_text": text,
            }
        )

    source_language = resolve_source_language(args)
    use_semantic_partition = (
        normalize_textline_merge_mode(merge_mode) == "semantic"
        and is_japanese_source_language(source_language)
    )
    if use_semantic_partition:
      # Reproduce the established semantic Paddle candidate order without
      # accepting its union-find grouping as authoritative.  The old group is
      # retained only as evidence for the later image-aware review.
      semantic_candidates = merge_textline_candidates(
          raw_candidates,
          width,
          height,
          mode="semantic",
          source_language=source_language,
      )
      preserve_paddle_group_evidence(semantic_candidates)
      # Give every ordered detector row its public, stable identity before
      # partitioning. The heuristic may exclude OCR noise, so final ids
      # intentionally keep gaps instead of being renumbered after filtering.
      for index, item in enumerate(semantic_candidates):
        item["id"] = index + 1
      finalize_textline_output_fields(
          semantic_candidates,
          args,
          preserve_private_evidence=True,
      )
      partition = partition_textline_candidates_heuristic(
          semantic_candidates,
          width,
          height,
          source_language=source_language,
      )
      items = materialize_textline_heuristic_partition(partition)
    else:
      items = merge_textline_candidates(
          raw_candidates,
          width,
          height,
          mode=merge_mode,
          source_language=source_language,
      )
      for index, item in enumerate(items):
        item["id"] = index + 1
      finalize_textline_output_fields(items, args)
      renumber_items(items)

    payload = {
        "source": source,
        "coordinateSpace": "pixels",
        "width": width,
        "height": height,
        "items": items,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"output": str(output_path), "count": len(items)}


def ensure_requested_device(args: argparse.Namespace) -> None:
    device = getattr(args, "device", None)
    if not device or not device.lower().startswith("gpu"):
      return

    if is_transformers_engine(args):
      try:
        import torch
      except Exception as exc:
        raise RuntimeError(
            "GPU OCR was requested with Transformers engine, but PyTorch is not importable."
        ) from exc

      if not torch.cuda.is_available():
        raise RuntimeError(
            "GPU OCR was requested with Transformers engine, but torch.cuda is not available."
        )

      if not getattr(torch.version, "hip", None):
        print(
            "[paddleocr-vl-bboxes] warning: torch is not a ROCm/HIP build; continuing for non-AMD Transformers GPU.",
            file=sys.stderr,
        )

      configure_torch_for_transformers_ocr(args)
      select_preferred_cuda_device(args)

      _probe = torch.ones((1,), device="cuda")
      torch.cuda.synchronize()

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


# PaddleOCR 전용 lang 문자열은 이 어댑터 안에서만 사용한다. 앱 다른 계층에는
# 언어 코드(ja/en/zh-Hans/...)만 흐른다. 키는 소문자 언어 코드.
# PaddleOCR 3.7 API에는 스크립트 계열 모델명(latin/arabic/cyrillic)이 아니라
# 실제 lang 코드(ar/ru/hi 등)를 넘겨야 한다. 알려지지 않은 스크립트는 유효한
# en 프로필로 폴백해 검출 geometry가 계속 동작하게 한다.
PADDLE_OCR_LANG_BY_SOURCE_LANGUAGE = {
    "ja": "japan",
    "ko": "korean",
    "en": "en",
    "fr": "fr",
    "de": "de",
    "it": "it",
    "es": "es",
    "pt": "pt",
    "ru": "ru",
    "ar": "ar",
    "fa": "fa",
    "ur": "ur",
    "hi": "hi",
    "mr": "mr",
    "ne": "ne",
    "uk": "uk",
    "bg": "bg",
    "sr": "rs_cyrillic",
    "be": "be",
    "mn": "mn",
    "ta": "ta",
    "te": "te",
    "ka": "ka",
    "th": "th",
    "el": "el",
    "fil": "tl",
}

PADDLE_OCR_V5_LANGS = {
    "korean",
    "th",
    "el",
    "te",
    "ta",
    "ar",
    "fa",
    "ur",
    "ru",
    "uk",
    "bg",
    "rs_cyrillic",
    "be",
    "mn",
    "hi",
    "mr",
    "ne",
}


def resolve_source_language(args: argparse.Namespace | None = None) -> str:
    value = ""
    if args is not None:
      value = str(getattr(args, "source_language", "") or "").strip()
    if not value:
      value = os.environ.get("MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE", "").strip()
    return (value or "ja").lower()


def resolve_paddle_ocr_lang(source_language: str) -> str:
    normalized = str(source_language or "ja").strip().lower()
    subtags = normalized.split("-")
    base = subtags[0]
    if base == "zh":
      traditional = "hant" in subtags or any(region in subtags for region in ("tw", "hk", "mo"))
      return "chinese_cht" if traditional else "ch"
    # 지역 태그(en-US, ja-JP, ar-SA)는 Paddle가 이해하는 기본 코드로 내린다.
    return PADDLE_OCR_LANG_BY_SOURCE_LANGUAGE.get(base, "en")


def resolve_paddle_ocr_version(source_language: str, requested_version: str | None) -> str:
    lang = resolve_paddle_ocr_lang(source_language)
    if lang == "ka":
      return "PP-OCRv3"
    if lang in PADDLE_OCR_V5_LANGS:
      return "PP-OCRv5"
    return requested_version or "PP-OCRv6"


def should_use_configured_model_names(
    ocr_version: str,
    text_detection_model_name: str,
    text_recognition_model_name: str,
) -> bool:
    names = [name for name in (text_detection_model_name, text_recognition_model_name) if name]
    if not names:
      return False
    if ocr_version == "PP-OCRv6":
      return True
    # 저사양 모드가 주입한 v6 고정 모델은 ko/ar/ru/hi 등의 lang을 무시한다.
    # 명시적인 비-v6 커스텀 모델 이름은 사용자가 의도한 것으로 보고 보존한다.
    return not any("pp-ocrv6" in name.lower() for name in names)


def resolve_source_script(source_language: str) -> str:
    base = str(source_language or "ja").strip().lower().split("-", 1)[0]
    if base == "ja":
      return "japanese"
    if base == "ko":
      return "korean"
    if base == "zh":
      return "chinese"
    return "latin"


def verify_transformers_textline_imports() -> None:
    """Resolve the lazy imports used by PaddleX before model construction.

    Transformers wraps failures from optional image dependencies in a generic
    AutoImageProcessor import error. Importing torchvision and resolving the
    lazy attributes here keeps the original DLL/native-op traceback visible.
    """
    import torchvision  # noqa: F401
    import transformers

    _ = transformers.AutoImageProcessor
    _ = transformers.AutoModelForObjectDetection


def create_textline_detector(
    args: argparse.Namespace | None = None,
    *,
    required: bool = False,
) -> object:
    if os.environ.get("MANGA_TRANSLATOR_DISABLE_PADDLEOCR_LINES", "").lower() in {"1", "true", "yes", "on"}:
      return None

    ocr_kwargs = {}
    transformers_engine = False
    try:
      from paddleocr import PaddleOCR
      device = getattr(args, "device", None) if args else None
      if not device and os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_DEVICE"):
        device = os.environ["MANGA_TRANSLATOR_PADDLEOCR_DEVICE"]
      transformers_engine = bool(args and is_transformers_engine(args))
      configure_torch_for_transformers_ocr(args)
      if transformers_engine:
        verify_transformers_textline_imports()
      source_language = resolve_source_language(args)
      requested_ocr_version = getattr(args, "ocr_version", None) or os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_VERSION", "PP-OCRv6")
      ocr_version = resolve_paddle_ocr_version(source_language, requested_ocr_version)
      ocr_kwargs = {
          "lang": resolve_paddle_ocr_lang(source_language),
          "ocr_version": ocr_version,
          "use_doc_orientation_classify": False,
          "use_doc_unwarping": False,
          "use_textline_orientation": False,
          "text_det_limit_side_len": resolve_text_det_limit(args),
          "text_det_limit_type": "max",
          "text_recognition_batch_size": int(os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH", "1")),
      }
      if device:
        ocr_kwargs["device"] = device
      text_detection_model_name = str(getattr(args, "text_detection_model_name", "") or "").strip()
      text_recognition_model_name = str(getattr(args, "text_recognition_model_name", "") or "").strip()
      if should_use_configured_model_names(ocr_version, text_detection_model_name, text_recognition_model_name):
        if text_detection_model_name:
          ocr_kwargs["text_detection_model_name"] = text_detection_model_name
        if text_recognition_model_name:
          ocr_kwargs["text_recognition_model_name"] = text_recognition_model_name
      elif text_detection_model_name or text_recognition_model_name:
        print(
            f"[paddleocr-vl-bboxes] ignoring incompatible configured PP-OCRv6 model names for lang={ocr_kwargs['lang']} version={ocr_version}.",
            file=sys.stderr,
        )
      if transformers_engine:
        device_type = "gpu" if device and str(device).lower().startswith("gpu") else "cpu"
        attn_implementation = resolve_transformers_attention_implementation()
        ocr_kwargs["engine"] = "transformers"
        engine_config = {
            "dtype": getattr(args, "dtype", "float32"),
            "device_type": device_type,
            "device_id": resolve_engine_device_id(device),
            "trust_remote_code": True,
            "model_kwargs": {
                "trust_remote_code": True,
            },
        }
        apply_attention_implementation_to_engine_config(engine_config, attn_implementation)
        ocr_kwargs["engine_config"] = engine_config
      else:
        engine = str(getattr(args, "engine", "") or "").strip()
        if engine and engine != "paddle":
          ocr_kwargs["engine"] = engine
      try:
        return PaddleOCR(**ocr_kwargs)
      except Exception as exc:
        if transformers_engine and should_retry_with_eager_attention(exc, ocr_kwargs):
          print(
              "[paddleocr-vl-bboxes] Transformers attention implementation is not supported; retrying with attn_implementation='eager'.",
              file=sys.stderr,
          )
          apply_attention_implementation_to_engine_config(ocr_kwargs["engine_config"], "eager")
          return PaddleOCR(**ocr_kwargs)
        raise
    except Exception as exc:
      detail = ""
      if transformers_engine:
        detail = f" ({describe_transformers_attention_config(ocr_kwargs)})"
      print(f"[paddleocr-vl-bboxes] textline detector unavailable{detail}: {exc}", file=sys.stderr)
      if required:
        raise
      return None


def close_textline_detector(ocr: object) -> None:
    close = getattr(ocr, "close", None)
    if callable(close):
      close()


def collect_textline_candidates(
    image_path: Path,
    existing_items: list[dict],
    width: int,
    height: int,
    ocr: object = None,
    args: argparse.Namespace | None = None,
) -> list[dict]:
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
      results = predict_with_torch_inference_mode(
          ocr,
          image_path,
          os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ENGINE", "").strip().lower() == "transformers",
      )
      for result in results:
        # PaddleOCR-VL's optional textline supplement is the legacy path. Keep
        # its established index-pairing contract separate from OCR-only
        # semantic modes, which align recognition rows through rec_polys.
        entries = collect_legacy_indexed_ocr_entries(result)
        for poly, text, score in entries:
          box = bbox_from_poly(poly, width, height)
          if not box:
            continue
          if text and is_probable_symbol_noise(text):
            continue
          x1, y1, x2, y2 = box
          box_width = x2 - x1
          box_height = y2 - y1
          if box_width < 6 or box_height < 6 or box_width * box_height < 200:
            continue
          covering_item = find_covering_existing_item(box, existing_items)
          if covering_item is not None:
            if text:
              covering_item.setdefault("_texts", []).append(text)
            continue
          text = filter_candidate_ocr_text(text, score, args)
          raw_candidates.append(
              {
                  "label": "ocr_textline",
                  "x1": x1,
                  "y1": y1,
                  "x2": x2,
                  "y2": y2,
                  "_score": score,
                  "_text": text,
              }
          )
    except Exception as exc:
      print(f"[paddleocr-vl-bboxes] textline detector failed: {exc}", file=sys.stderr)

    grouped = merge_textline_candidates(
        raw_candidates,
        width,
        height,
        mode=resolve_textline_merge_mode(None, default="legacy"),
        source_language=resolve_source_language(args),
    )
    for index, item in enumerate(grouped):
      item["id"] = len(existing_items) + index + 1
      score = item.pop("_score", None)
      single_text = item.pop("_text", "")
      grouped_texts = item.pop("_texts", [])
      ocr_text = clean_ocr_text(single_text or merge_ocr_texts(grouped_texts))
      ocr_text = filter_candidate_ocr_text(ocr_text, score, args)
      if ocr_text:
        item["ocrText"] = ocr_text
      if isinstance(score, float):
        item["score"] = round(score, 4)
    return grouped


def finalize_ocr_text_fields(items: list[dict]) -> None:
    for item in items:
      grouped_text = merge_ocr_texts(item.pop("_texts", []))
      if grouped_text and not item.get("ocrText"):
        item["ocrText"] = grouped_text


def finalize_textline_output_fields(
    items: list[dict],
    args: argparse.Namespace | None = None,
    preserve_private_evidence: bool = False,
) -> None:
    """Expose one OCR string/score per detector row without changing geometry."""

    for item in items:
      score = item.get("_score")
      single_text = item.get("_text", "")
      grouped_texts = item.get("_texts", [])
      ocr_text = clean_ocr_text(single_text or merge_ocr_texts(grouped_texts))
      ocr_text = filter_candidate_ocr_text(ocr_text, score, args)
      if ocr_text:
        item["ocrText"] = ocr_text
      if isinstance(score, float):
        item["score"] = round(score, 4)
      if preserve_private_evidence:
        # Match the serialized OCR cache contract:
        # partitioning sees the filtered public text and rounded public score.
        item["_text"] = ocr_text
        if isinstance(score, float):
          item["_score"] = round(score, 4)
        else:
          item.pop("_score", None)
        item.pop("_texts", None)
      else:
        item.pop("_score", None)
        item.pop("_text", None)
        item.pop("_texts", None)


def preserve_paddle_group_evidence(items: list[dict]) -> None:
    """Move preliminary Paddle groups aside before axis-v4 assigns final groups."""

    for item in items:
      group_id = str(item.get("groupId") or "").strip().upper()
      order = item.get("orderInGroup")
      group_size = item.get("groupSize")
      if (
          group_id.startswith("G")
          and group_id[1:].isdigit()
          and isinstance(order, int)
          and not isinstance(order, bool)
          and isinstance(group_size, int)
          and not isinstance(group_size, bool)
          and 1 <= order <= group_size
      ):
        item["paddleGroupId"] = group_id
        item["paddleOrder"] = order
        item["paddleGroupSize"] = group_size
      item.pop("groupId", None)
      item.pop("orderInGroup", None)
      item.pop("groupSize", None)
      item.pop("rolePrior", None)
      item.pop("containerType", None)
      item.pop("semanticGroup", None)


def materialize_textline_heuristic_partition(partition: dict) -> list[dict]:
    """Flatten confirmed/deferred fragments while retaining every raw OCR box."""

    review_context_by_candidate_id = build_textline_review_context_ids(partition)
    items: list[dict] = []
    for fragment_index, group in enumerate(partition.get("groups", []), start=1):
      fragment_id = f"B{fragment_index:03d}"
      group_id = f"G{fragment_index:03d}"
      group_size = len(group)
      for review_order, candidate in enumerate(group, start=1):
        item = dict(candidate)
        item.pop("_score", None)
        item.pop("_text", None)
        item.pop("_texts", None)
        item.update(
            {
                "reviewFragmentId": fragment_id,
                "reviewStatus": "confirmed",
                "reviewReasons": [],
                "reviewOrder": review_order,
                # Even a one-row fragment receives a group lock.  It prevents
                # the later JS fallback grouper from joining two fragments that
                # axis-v4 deliberately kept separate.  The prompt projector
                # still treats size-one groups as ordinary singleton slots.
                "groupId": group_id,
                "orderInGroup": review_order,
                "groupSize": group_size,
                "rolePrior": "ordinary_mergeable",
                "containerType": "same_text_container",
                "semanticGroup": True,
            }
        )
        review_context_id = review_context_by_candidate_id.get(item.get("id"))
        if review_context_id:
          item["reviewContextId"] = review_context_id
        items.append(item)

    for fragment_index, entry in enumerate(partition.get("deferred", []), start=1):
      fragment_id = f"D{fragment_index:03d}"
      reasons = [
          str(reason)
          for reason in entry.get("reasons", [])
          if str(reason).strip()
      ]
      for review_order, candidate in enumerate(entry.get("items", []), start=1):
        item = dict(candidate)
        item.pop("_score", None)
        item.pop("_text", None)
        item.pop("_texts", None)
        item.update(
            {
                "reviewFragmentId": fragment_id,
                "reviewStatus": "deferred",
                "reviewReasons": reasons,
                "reviewOrder": review_order,
            }
        )
        items.append(item)

    return items


def extract_block_text(block: object) -> str:
    for key in (
        "ocrText",
        "text",
        "content",
        "block_content",
        "rec_text",
        "transcription",
        "markdown",
    ):
      value = read_object_value(block, key)
      text = flatten_text_value(value)
      if text:
        return text
    return ""


def read_object_value(value: object, key: str) -> object:
    if isinstance(value, dict):
      return value.get(key)
    return getattr(value, key, None)


def flatten_text_value(value: object) -> str:
    if value is None:
      return ""
    if isinstance(value, str):
      return value
    if isinstance(value, (list, tuple)):
      return " ".join(flatten_text_value(item) for item in value)
    if isinstance(value, dict):
      for key in ("text", "content", "value", "rec_text", "transcription"):
        text = flatten_text_value(value.get(key))
        if text:
          return text
      return ""
    return str(value)


def clean_ocr_text(text: str) -> str:
    cleaned = " ".join(str(text or "").replace("\r", "\n").split())
    return cleaned[:160]


def merge_ocr_texts(texts: list[object]) -> str:
    cleaned: list[str] = []
    for text in texts:
      value = clean_ocr_text(str(text))
      if value:
        cleaned.append(value)
    return " ".join(cleaned)


def filter_candidate_ocr_text(
    text: str,
    score: float | None,
    args: argparse.Namespace | None = None,
) -> str:
    cleaned = clean_ocr_text(text)
    if not cleaned:
      return ""
    if not is_tiny_recognition_model(args):
      return cleaned
    script = resolve_source_script(resolve_source_language(args))
    if is_suspicious_tiny_rec_text(cleaned, score, script):
      return ""
    return cleaned


def is_tiny_recognition_model(args: argparse.Namespace | None = None) -> bool:
    value = ""
    if args is not None:
      value = str(getattr(args, "text_recognition_model_name", "") or "")
    if not value:
      value = os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME", "")
    return "tiny_rec" in value.strip().lower()


def is_suspicious_tiny_rec_text(
    text: str,
    score: float | None,
    script: str = "japanese",
) -> bool:
    normalized = "".join(char for char in text.strip() if not char.isspace())
    if not normalized:
      return True
    if isinstance(score, float) and score < 0.55:
      return True
    if script != "japanese":
      # kana/ASCII/간체 artifact 필터는 일본어 전용이다. 라틴 문자 원문에서
      # ASCII를 지우거나 중국어 원문에서 한자를 지우면 정상 텍스트가 사라진다.
      return False
    kana_count = count_kana_chars(normalized)
    if len(normalized) <= 1 and kana_count == 0:
      return True
    if contains_common_simplified_chinese_artifact(normalized):
      return True
    ascii_letter_count = sum(1 for char in normalized if char.isascii() and char.isalpha())
    if ascii_letter_count > 0:
      return True
    if kana_count == 0:
      return not is_reliable_tiny_no_kana_text(normalized, score)
    return False


def is_reliable_tiny_no_kana_text(text: str, score: float | None) -> bool:
    if not isinstance(score, float) or score < 0.93:
      return False
    if len(text) < 2 or len(text) > 8:
      return False
    return all(is_japanese_text_char(char) or char.isdigit() for char in text)


def is_japanese_text_char(char: str) -> bool:
    code = ord(char)
    if 0x3040 <= code <= 0x30FF:
      return True
    if 0x3400 <= code <= 0x4DBF or 0x4E00 <= code <= 0x9FFF:
      return True
    if char in "々〆ヶ〇ー・、。！？!?:：…":
      return True
    return False


def count_kana_chars(text: str) -> int:
    count = 0
    for char in text:
      code = ord(char)
      if 0x3040 <= code <= 0x30FF:
        count += 1
    return count


def contains_common_simplified_chinese_artifact(text: str) -> bool:
    return any(char in text for char in "飞仗办们门说这过见长敌应历歷赵场样與与为间它恶兒儿")


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


def merge_textline_candidates(
    candidates: list[dict],
    width: int,
    height: int,
    mode: str = "legacy",
    source_language: str = "ja",
) -> list[dict]:
    """Merge low-level OCR text lines into cleaner geometry hints.

    The ordinary OCR detector is intentionally used only as a fallback for
    small missed text. On handwritten diagrams it often returns one candidate
    per scribbled line, which makes the translator render a pile of tiny SFX
    labels. Grouping close text lines gives the model a better semantic unit
    while still preserving the OCR-detected source area.
    """

    normalized_mode = normalize_textline_merge_mode(mode)
    if len(candidates) < 2 or normalized_mode == "none":
      return candidates
    grouping_mode = normalized_mode

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
        if should_merge_textline_boxes(candidates[left], candidates[right], width, height, mode=grouping_mode):
          union(left, right)

    groups: dict[int, list[dict]] = {}
    for index, item in enumerate(candidates):
      groups.setdefault(find(index), []).append(item)

    ordered_groups = (
        sorted(
            groups.values(),
            key=lambda group: (
                min(int(item["y1"]) for item in group),
                min(int(item["x1"]) for item in group),
                max(int(item["y2"]) for item in group),
                max(int(item["x2"]) for item in group),
            ),
        )
        if normalized_mode == "semantic"
        else list(groups.values())
    )
    merged: list[dict] = []
    semantic_group_number = 1
    for group in ordered_groups:
      if normalized_mode == "semantic":
        sort_textline_group(group, source_language)
      else:
        # Preserve the legacy/conservative ordering contract used by the
        # existing NVIDIA and custom OCR paths. Source-aware vertical ordering
        # belongs only to the explicit semantic OCR-only mode.
        group.sort(key=lambda item: (int(item["y1"]), int(item["x1"])))
      if normalized_mode == "semantic" and is_japanese_source_language(source_language):
        group_id = f"G{semantic_group_number:03d}" if len(group) > 1 else ""
        for order, candidate in enumerate(group, start=1):
          item = dict(candidate)
          if group_id:
            item.update(
                {
                    "groupId": group_id,
                    "orderInGroup": order,
                    "groupSize": len(group),
                    "rolePrior": "ordinary_mergeable",
                    "containerType": "same_text_container",
                    # This marks a conservative semantic group produced by the
                    # semantic OCR-only path. The translation prompt may present the
                    # members as one output slot while retaining every raw box
                    # for visual verification and false-group recovery.
                    "semanticGroup": True,
                }
            )
          merged.append(item)
        if group_id:
          semantic_group_number += 1
        continue
      if len(group) == 1:
        item = dict(group[0])
        merged.append(item)
        continue
      x1 = min(int(item["x1"]) for item in group)
      y1 = min(int(item["y1"]) for item in group)
      x2 = max(int(item["x2"]) for item in group)
      y2 = max(int(item["y2"]) for item in group)
      scores = [item.get("_score") for item in group if isinstance(item.get("_score"), float)]
      texts = [item.get("_text") for item in group if item.get("_text")]
      merged.append(
          {
              "label": "ocr_textgroup",
              "x1": clamp(x1, 0, width),
              "y1": clamp(y1, 0, height),
              "x2": clamp(x2, 0, width),
              "y2": clamp(y2, 0, height),
              "_score": sum(scores) / len(scores) if scores else None,
              "_texts": texts,
          }
      )

    merged.sort(key=lambda item: (int(item["y1"]), int(item["x1"])))
    return merged


def partition_textline_candidates_heuristic(
    candidates: list[dict],
    width: int,
    height: int,
    source_language: str = "ja",
) -> dict:
    """Build high-precision OCR text clusters without a vision-model call.

    This is a Docstrum-style local-neighbour pass over OCR line boxes.  It is
    deliberately precision-first: only mutually adjacent, axis-aligned lines
    may form a component.  Small reading aids can be attached after the main
    components exist, but low-confidence or oversized candidates can never
    bridge two components.
    """

    descriptors = [
        heuristic_textline_descriptor(item, index)
        for index, item in enumerate(candidates)
    ]
    references = {
        orientation: heuristic_reference_scale(descriptors, orientation)
        for orientation in ("vertical", "horizontal")
    }
    sparse_page = sum(
        1
        for item in descriptors
        if int(item["japaneseCount"]) > 0 and float(item["score"]) >= 0.65
    ) <= 4
    for descriptor in descriptors:
      role, reason = classify_heuristic_textline(
          descriptor,
          references,
          sparse_page=sparse_page,
      )
      descriptor["role"] = role
      descriptor["reason"] = reason

    # A page-wide font estimate is not sufficient for ruby: a large display
    # line can have its own, proportionally small reading aid.  Detect those
    # local satellites before building any graph so they can never steal a
    # nearest-neighbour slot or bridge two body-text components.
    demote_local_heuristic_satellites(descriptors)

    excluded: list[dict] = []
    primary: list[dict] = []
    display: list[dict] = []
    auxiliary: list[dict] = []
    standalone: list[dict] = []
    for descriptor in descriptors:
      role = str(descriptor["role"])
      if role == "primary":
        primary.append(descriptor)
      elif role == "display":
        display.append(descriptor)
      elif role == "auxiliary":
        auxiliary.append(descriptor)
      elif role == "standalone":
        standalone.append(descriptor)
      else:
        excluded.append(descriptor)

    connectable = primary + display
    edges = retain_mutual_heuristic_edges(collect_heuristic_edges(connectable))
    components = collect_constrained_heuristic_components(connectable, edges)
    for descriptor in auxiliary:
      if heuristic_japanese_purity(descriptor) < 0.6:
        descriptor["reason"] = "mixed_ascii_ocr_noise"
        excluded.append(descriptor)
        continue
      target = select_heuristic_auxiliary_component(descriptor, components)
      if target is None:
        descriptor["reason"] = "unattached_auxiliary"
        standalone.append(descriptor)
        continue
      target.append(descriptor)

    for component in components:
      if is_probable_page_metadata_component(component):
        for descriptor in component:
          descriptor["reason"] = "page_metadata_text"

    grouped_descriptors = [
        component
        for component in components
        if not any(
            item.get("role") == "display"
            or item.get("orientation") == "horizontal"
            for item in component
        )
        and not is_probable_page_metadata_component(component)
    ]
    deferred_descriptors = [
        component
        for component in components
        if any(
            item.get("role") == "display"
            or item.get("orientation") == "horizontal"
            for item in component
        )
        or is_probable_page_metadata_component(component)
    ] + [[item] for item in standalone]
    grouped_descriptors.sort(key=heuristic_component_sort_key)
    deferred_descriptors.sort(key=heuristic_component_sort_key)
    review_edges = collect_heuristic_component_review_edges(
        grouped_descriptors,
        width=width,
        height=height,
    )
    groups: list[list[dict]] = []
    for component in grouped_descriptors:
      group = [descriptor["item"] for descriptor in component]
      sort_textline_group(group, source_language)
      groups.append(group)
    deferred: list[dict] = []
    for component in deferred_descriptors:
      group = [descriptor["item"] for descriptor in component]
      sort_textline_group(group, source_language)
      deferred.append(
          {
              "items": group,
              "reasons": sorted(
                  {
                      str(descriptor.get("reason") or "uncertain_text_role")
                      for descriptor in component
                  }
              ),
          }
      )

    return {
        "groups": groups,
        "deferred": deferred,
        # These are questions, not merge instructions.  A later image-aware
        # audit may answer same/different for each component pair; deterministic
        # code remains responsible for the exact union of the original boxes.
        "reviewEdges": review_edges,
        "excluded": [
            {
                "item": descriptor["item"],
                "reason": descriptor.get("reason") or "excluded_by_heuristic",
            }
            for descriptor in sorted(excluded, key=lambda item: int(item["index"]))
        ],
        "diagnostics": {
            "algorithm": "axis_mutual_neighbour_v4",
            "inputCount": len(candidates),
            "groupCount": len(groups),
            "deferredGroupCount": len(deferred),
            "groupedCandidateCount": sum(len(group) for group in groups),
            "deferredCandidateCount": sum(
                len(entry["items"]) for entry in deferred
            ),
            "excludedCandidateCount": len(excluded),
            "edgeCount": len(edges),
            "reviewEdgeCount": len(review_edges),
            "reviewPolicy": "nearby_component_pair_v1",
            "referenceScale": references,
        },
    }


def collect_heuristic_component_review_edges(
    components: list[list[dict]],
    *,
    width: int,
    height: int,
) -> list[dict]:
    """Collect bounded component-pair questions without changing grouping.

    The confirmed graph intentionally rejects staggered neighbouring columns
    because auto-merging them caused diagonal and multi-balloon failures.  A
    small image-aware audit can still reconsider nearby component pairs.  This
    function only selects those questions; it never joins their components.
    """

    summaries = [
        heuristic_review_component(component, index)
        for index, component in enumerate(components)
    ]
    candidates: list[dict] = []
    for left_index, left in enumerate(summaries):
      for right in summaries[left_index + 1:]:
        edge = build_heuristic_component_review_edge(
            left,
            right,
            width=width,
            height=height,
        )
        if edge is not None:
          candidates.append(edge)

    # Keep only the closest plausible question in each cardinal direction for
    # every component.  An edge survives when either endpoint selects it.  The
    # later model therefore receives a sparse local graph rather than every
    # pair on the page, while asymmetric layouts remain reviewable.
    nearest: dict[tuple[int, str], dict] = {}
    for edge in candidates:
      for component_key, slot_key in (
          ("leftComponent", "leftSlot"),
          ("rightComponent", "rightSlot"),
      ):
        component = edge[component_key]
        key = (int(component["index"]), str(edge[slot_key]))
        sort_key = (
            float(edge["cost"]),
            int(edge["leftComponent"]["index"]),
            int(edge["rightComponent"]["index"]),
        )
        previous = nearest.get(key)
        if previous is None or sort_key < previous["sortKey"]:
          nearest[key] = {"edge": edge, "sortKey": sort_key}

    retained = []
    for edge in candidates:
      left_key = (
          int(edge["leftComponent"]["index"]),
          str(edge["leftSlot"]),
      )
      right_key = (
          int(edge["rightComponent"]["index"]),
          str(edge["rightSlot"]),
      )
      if (
          nearest[left_key]["edge"] is not edge
          and nearest[right_key]["edge"] is not edge
      ):
        continue
      retained.append(edge)

    retained.sort(
        key=lambda edge: (
            min(edge["leftComponent"]["candidateIds"]),
            min(edge["rightComponent"]["candidateIds"]),
        )
    )
    return [
        {
            "edgeId": f"R{index:03d}",
            "componentCandidateIds": [
                edge["leftComponent"]["candidateIds"],
                edge["rightComponent"]["candidateIds"],
            ],
            "anchorCandidateIds": edge["anchorCandidateIds"],
            "reason": edge["reason"],
            "metrics": edge["metrics"],
        }
        for index, edge in enumerate(retained, start=1)
    ]


def heuristic_review_component(component: list[dict], index: int) -> dict:
    x1 = min(int(item["box"][0]) for item in component)
    y1 = min(int(item["box"][1]) for item in component)
    x2 = max(int(item["box"][2]) for item in component)
    y2 = max(int(item["box"][3]) for item in component)
    primary_scales = sorted(
        float(item["scale"])
        for item in component
        if item.get("role") == "primary"
    )
    scales = primary_scales or sorted(float(item["scale"]) for item in component)
    return {
        "index": index,
        "component": component,
        "candidateIds": sorted(heuristic_descriptor_candidate_id(item) for item in component),
        "box": (x1, y1, x2, y2),
        "width": max(1.0, float(x2 - x1)),
        "height": max(1.0, float(y2 - y1)),
        "centerX": (x1 + x2) / 2,
        "centerY": (y1 + y2) / 2,
        "scale": median_number(scales),
    }


def heuristic_descriptor_candidate_id(descriptor: dict) -> int:
    value = descriptor["item"].get("id")
    if isinstance(value, int) and not isinstance(value, bool):
      return value
    return int(descriptor["index"]) + 1


def build_heuristic_component_review_edge(
    left: dict,
    right: dict,
    *,
    width: int,
    height: int,
) -> dict | None:
    ax1, ay1, ax2, ay2 = left["box"]
    bx1, by1, bx2, by2 = right["box"]
    font = max(1.0, min(float(left["scale"]), float(right["scale"])))
    scale_ratio = min(float(left["scale"]), float(right["scale"])) / max(
        float(left["scale"]),
        float(right["scale"]),
    )
    # This is only a review queue, not an automatic union.  Allow a moderate
    # font-size contrast so an emphasized first column beside ordinary text is
    # still visible to the image-aware audit (fixed-set P17 is 31.5/64).
    if scale_ratio < 0.42:
      return None
    union_width = max(ax2, bx2) - min(ax1, bx1)
    union_height = max(ay2, by2) - min(ay1, by1)
    if union_width > max(180.0, width * 0.32):
      return None
    if union_height > max(260.0, height * 0.38):
      return None

    gap_x = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0.0, max(ay1, by1) - min(ay2, by2))
    x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
    y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
    horizontal_cost = None
    if y_overlap >= 0.28 and gap_x / font <= 1.45:
      horizontal_cost = (
          gap_x / font
          + (1.0 - y_overlap) * 0.75
          + abs(float(left["centerY"]) - float(right["centerY"]))
          / max(float(left["height"]), float(right["height"]))
          * 0.35
      )
    vertical_cost = None
    if (
        x_overlap >= 0.42
        and gap_y / font <= 1.35
        and abs(float(left["centerX"]) - float(right["centerX"])) / font <= 0.9
    ):
      vertical_cost = gap_y / font + (1.0 - x_overlap) * 0.75
    if horizontal_cost is None and vertical_cost is None:
      return None

    if vertical_cost is not None and (
        horizontal_cost is None or vertical_cost < horizontal_cost
    ):
      kind = "same_axis_continuation"
      cost = vertical_cost
      if float(left["centerY"]) <= float(right["centerY"]):
        left_slot, right_slot = "down", "up"
      else:
        left_slot, right_slot = "up", "down"
    else:
      kind = "staggered_vertical_components"
      cost = float(horizontal_cost)
      if float(left["centerX"]) <= float(right["centerX"]):
        left_slot, right_slot = "right", "left"
      else:
        left_slot, right_slot = "left", "right"

    anchor_left, anchor_right = min(
        (
            (left_item, right_item)
            for left_item in left["component"]
            if left_item.get("role") == "primary"
            for right_item in right["component"]
            if right_item.get("role") == "primary"
        ),
        key=lambda pair: heuristic_review_anchor_cost(pair[0], pair[1]),
    )
    return {
        "leftComponent": left,
        "rightComponent": right,
        "leftSlot": left_slot,
        "rightSlot": right_slot,
        "cost": cost,
        "anchorCandidateIds": [
            heuristic_descriptor_candidate_id(anchor_left),
            heuristic_descriptor_candidate_id(anchor_right),
        ],
        "reason": kind,
        "metrics": {
            "scaleRatio": round(scale_ratio, 4),
            "xGapInFonts": round(gap_x / font, 4),
            "yGapInFonts": round(gap_y / font, 4),
            "xOverlap": round(x_overlap, 4),
            "yOverlap": round(y_overlap, 4),
        },
    }


def heuristic_review_anchor_cost(left: dict, right: dict) -> tuple[float, int, int]:
    ax1, ay1, ax2, ay2 = left["box"]
    bx1, by1, bx2, by2 = right["box"]
    gap_x = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0.0, max(ay1, by1) - min(ay2, by2))
    return (
        gap_x + gap_y,
        heuristic_descriptor_candidate_id(left),
        heuristic_descriptor_candidate_id(right),
    )


def heuristic_textline_descriptor(item: dict, index: int) -> dict:
    x1, y1, x2, y2 = box_tuple(item)
    item_width = max(1.0, float(x2 - x1))
    item_height = max(1.0, float(y2 - y1))
    if item_height >= item_width * 1.2:
      orientation = "vertical"
      scale = item_width
    elif item_width >= item_height * 1.2:
      orientation = "horizontal"
      scale = item_height
    else:
      orientation = "ambiguous"
      scale = min(item_width, item_height)
    text = str(item.get("_text") or item.get("ocrText") or "").strip()
    raw_score = item.get("_score", item.get("score"))
    score = float(raw_score) if isinstance(raw_score, (int, float)) else 1.0
    return {
        "index": index,
        "item": item,
        "box": (x1, y1, x2, y2),
        "width": item_width,
        "height": item_height,
        "centerX": (x1 + x2) / 2,
        "centerY": (y1 + y2) / 2,
        "orientation": orientation,
        "scale": scale,
        "text": text,
        "japaneseCount": count_japanese_chars(text),
        "score": score,
    }


def heuristic_reference_scale(descriptors: list[dict], orientation: str) -> float:
    def eligible(
        minimum_japanese_count: int,
        minimum_score: float = 0.65,
    ) -> list[float]:
      return sorted(
          float(item["scale"])
          for item in descriptors
          if item["orientation"] == orientation
          and int(item["japaneseCount"]) >= minimum_japanese_count
          and float(item["score"]) >= minimum_score
      )

    values = eligible(2)
    used_sparse_fallback = False
    if not values:
      # Sparse SFX/dialogue pages often contain only one-character detections.
      # They still provide a better scale estimate than the sentinel value 1.
      values = eligible(1, 0.88)
      used_sparse_fallback = True
    if not values:
      return 1.0
    middle = median_number(values)
    trimmed = [value for value in values if middle * 0.45 <= value <= middle * 2.2]
    values = trimmed or values
    if used_sparse_fallback:
      return median_number(values)
    return percentile_number(values, 0.65)


def percentile_number(values: list[float], fraction: float) -> float:
    if not values:
      return 0.0
    ordered = sorted(float(value) for value in values)
    position = max(0.0, min(1.0, fraction)) * (len(ordered) - 1)
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def classify_heuristic_textline(
    descriptor: dict,
    references: dict[str, float],
    *,
    sparse_page: bool = False,
) -> tuple[str, str]:
    if int(descriptor["japaneseCount"]) == 0:
      return ("excluded", "non_japanese_or_numeric_noise")
    score = float(descriptor["score"])
    japanese_count = int(descriptor["japaneseCount"])
    orientation = str(descriptor["orientation"])
    if orientation == "ambiguous":
      if is_isolated_single_japanese_glyph(descriptor) and not sparse_page:
        return ("standalone", "dense_page_single_glyph")
      if (
          (score >= 0.88 and japanese_count >= 1 and sparse_page)
          or (score >= 0.78 and japanese_count >= 2)
      ):
        return ("standalone", "ambiguous_shape_kept_separate")
      return ("standalone", "ambiguous_low_confidence_shape")
    reference = max(1.0, float(references.get(orientation) or 1.0))
    scale_ratio = float(descriptor["scale"]) / reference
    if scale_ratio < 0.65:
      if score >= 0.58:
        return ("auxiliary", "small_reading_aid")
      return ("standalone", "small_low_confidence_text")
    if is_isolated_single_japanese_glyph(descriptor) and not sparse_page:
      return ("standalone", "dense_page_single_glyph")
    if scale_ratio > 2.0:
      if (
          (score >= 0.88 and japanese_count >= 1 and sparse_page)
          or (score >= 0.82 and japanese_count >= 2)
      ):
        return ("display", "oversized_display_text")
      return ("standalone", "oversized_uncertain_sfx")
    if score < 0.70 and japanese_count <= 3:
      return ("standalone", "low_confidence_short_text")
    if score < 0.62:
      return ("standalone", "low_confidence_no_bridge")
    return ("primary", "ordinary_axis_candidate")


def demote_local_heuristic_satellites(descriptors: list[dict]) -> None:
    """Demote kana-sized local satellites without using them as graph edges."""

    anchors = [
        item
        for item in descriptors
        if item.get("role") in {"primary", "display"}
        and float(item["score"]) >= 0.78
        and int(item["japaneseCount"]) >= 2
    ]
    for descriptor in descriptors:
      if descriptor.get("role") != "primary":
        continue
      japanese_count = max(1, int(descriptor["japaneseCount"]))
      if count_kana_chars(str(descriptor["text"])) / japanese_count < 0.8:
        continue
      if float(descriptor["score"]) < 0.58:
        continue
      for anchor in anchors:
        if anchor is descriptor:
          continue
        if anchor["orientation"] != descriptor["orientation"]:
          continue
        scale_ratio = float(descriptor["scale"]) / max(1.0, float(anchor["scale"]))
        if scale_ratio > 0.62:
          continue
        if heuristic_auxiliary_attachment_cost(descriptor, anchor) is None:
          continue
        descriptor["role"] = "auxiliary"
        descriptor["reason"] = "local_reading_aid"
        break


def heuristic_japanese_purity(descriptor: dict) -> float:
    text = str(descriptor.get("text") or "")
    japanese_count = int(descriptor.get("japaneseCount") or 0)
    ascii_alphanumeric_count = sum(
        1 for char in text if char.isascii() and char.isalnum()
    )
    relevant_count = japanese_count + ascii_alphanumeric_count
    if relevant_count <= 0:
      return 0.0
    return japanese_count / relevant_count


def is_isolated_single_japanese_glyph(descriptor: dict) -> bool:
    if int(descriptor.get("japaneseCount") or 0) != 1:
      return False
    compact = "".join(
        char for char in str(descriptor.get("text") or "") if not char.isspace()
    )
    return len(compact) == 1


def is_probable_page_metadata_component(component: list[dict]) -> bool:
    if len(component) != 1:
      return False
    compact = "".join(
        char
        for char in str(component[0].get("text") or "")
        if not char.isspace()
    )
    if len(compact) > 24:
      return False
    if "次回更新" in compact or "次回へ" in compact:
      return True
    has_footer_marker = any(char.isdigit() for char in compact) or "●" in compact
    return has_footer_marker and ("つづく" in compact or "続く" in compact)


def collect_heuristic_edges(primary: list[dict]) -> list[dict]:
    edges: list[dict] = []
    for left_index, left in enumerate(primary):
      for right in primary[left_index + 1:]:
        edge = build_heuristic_edge(left, right)
        if edge is not None:
          edges.append(edge)
    return edges


def build_heuristic_edge(left: dict, right: dict) -> dict | None:
    orientation = str(left["orientation"])
    if orientation != right["orientation"] or orientation == "ambiguous":
      return None
    # Large display text may connect to display text of the same scale, but it
    # must never become a bridge into ordinary dialogue.
    if left.get("role") != right.get("role"):
      return None
    left_scale = float(left["scale"])
    right_scale = float(right["scale"])
    scale_ratio = min(left_scale, right_scale) / max(left_scale, right_scale)
    if scale_ratio < 0.6:
      return None
    if left.get("role") == "display":
      return build_display_heuristic_edge(left, right, scale_ratio)
    if orientation == "vertical":
      return build_vertical_heuristic_edge(left, right)
    return build_horizontal_heuristic_edge(left, right)


def build_display_heuristic_edge(
    left: dict,
    right: dict,
    scale_ratio: float,
) -> dict | None:
    if scale_ratio < 0.75:
      return None
    orientation = str(left["orientation"])
    ax1, ay1, ax2, ay2 = left["box"]
    bx1, by1, bx2, by2 = right["box"]
    font = max(1.0, min(float(left["scale"]), float(right["scale"])))
    if orientation == "vertical":
      gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
      overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
      start_delta = abs(ay1 - by1) / font
      if overlap >= 0.88 and gap / font <= 0.25 and start_delta <= 0.25:
        return make_heuristic_edge(left, right, "column", gap / font + start_delta)
      return None
    gap = max(0.0, max(ay1, by1) - min(ay2, by2))
    overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
    start_delta = abs(ax1 - bx1) / font
    if overlap >= 0.88 and gap / font <= 0.25 and start_delta <= 0.25:
      return make_heuristic_edge(left, right, "row_stack", gap / font + start_delta)
    return None


def build_vertical_heuristic_edge(left: dict, right: dict) -> dict | None:
    ax1, ay1, ax2, ay2 = left["box"]
    bx1, by1, bx2, by2 = right["box"]
    font = max(1.0, min(float(left["scale"]), float(right["scale"])))
    gap_x = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0.0, max(ay1, by1) - min(ay2, by2))
    x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
    y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
    top_delta = abs(ay1 - by1) / font
    center_x_delta = abs(float(left["centerX"]) - float(right["centerX"]))
    if (
        y_overlap >= 0.72
        and gap_x / font <= 0.55
        and top_delta <= 0.65
    ):
      return make_heuristic_edge(left, right, "column", gap_x / font + top_delta)
    if (
        x_overlap >= 0.62
        and gap_y / font <= 0.55
        and center_x_delta / font <= 0.38
    ):
      return make_heuristic_edge(left, right, "same_column", gap_y / font)
    return None


def build_horizontal_heuristic_edge(left: dict, right: dict) -> dict | None:
    ax1, ay1, ax2, ay2 = left["box"]
    bx1, by1, bx2, by2 = right["box"]
    font = max(1.0, min(float(left["scale"]), float(right["scale"])))
    gap_x = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0.0, max(ay1, by1) - min(ay2, by2))
    x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
    y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
    center_y_delta = abs(float(left["centerY"]) - float(right["centerY"]))
    min_width = max(1.0, min(float(left["width"]), float(right["width"])))
    center_x_delta = abs(float(left["centerX"]) - float(right["centerX"]))
    if (
        y_overlap >= 0.74
        and gap_x / font <= 0.42
        and center_y_delta / font <= 0.42
    ):
      return make_heuristic_edge(left, right, "same_row", gap_x / font)
    if (
        x_overlap >= 0.7
        and (y_overlap >= 0.42 or gap_y / font <= 0.24)
        and center_x_delta / min_width <= 0.35
    ):
      return make_heuristic_edge(left, right, "row_stack", gap_y / font)
    return None


def make_heuristic_edge(left: dict, right: dict, kind: str, cost: float) -> dict:
    left_slot, right_slot = heuristic_edge_slots(left, right, kind)
    return {
        "left": left,
        "right": right,
        "kind": kind,
        "cost": float(cost),
        "leftSlot": left_slot,
        "rightSlot": right_slot,
    }


def heuristic_edge_slots(left: dict, right: dict, kind: str) -> tuple[str, str]:
    if kind in {"same_column", "row_stack"}:
      if float(left["centerY"]) <= float(right["centerY"]):
        return ("down", "up")
      return ("up", "down")
    if float(left["centerX"]) <= float(right["centerX"]):
      return ("right", "left")
    return ("left", "right")


def retain_mutual_heuristic_edges(edges: list[dict]) -> list[dict]:
    nearest: dict[tuple[int, str], dict] = {}
    for edge in edges:
      for endpoint, slot_key in (("left", "leftSlot"), ("right", "rightSlot")):
        descriptor = edge[endpoint]
        key = (int(descriptor["index"]), str(edge[slot_key]))
        previous = nearest.get(key)
        edge_key = (
            float(edge["cost"]),
            int(edge["left"]["index"]),
            int(edge["right"]["index"]),
        )
        if previous is None or edge_key < previous["sortKey"]:
          nearest[key] = {"edge": edge, "sortKey": edge_key}
    retained = []
    for edge in edges:
      left_key = (int(edge["left"]["index"]), str(edge["leftSlot"]))
      right_key = (int(edge["right"]["index"]), str(edge["rightSlot"]))
      if nearest[left_key]["edge"] is edge and nearest[right_key]["edge"] is edge:
        retained.append(edge)
    retained.sort(
        key=lambda edge: (
            float(edge["cost"]),
            int(edge["left"]["index"]),
            int(edge["right"]["index"]),
        )
    )
    return retained


def collect_constrained_heuristic_components(
    primary: list[dict],
    edges: list[dict],
) -> list[list[dict]]:
    parent = {int(item["index"]): int(item["index"]) for item in primary}
    members = {int(item["index"]): [item] for item in primary}

    def find(value: int) -> int:
      while parent[value] != value:
        parent[value] = parent[parent[value]]
        value = parent[value]
      return value

    for edge in edges:
      left_root = find(int(edge["left"]["index"]))
      right_root = find(int(edge["right"]["index"]))
      if left_root == right_root:
        continue
      combined = members[left_root] + members[right_root]
      if not is_valid_heuristic_component(combined):
        continue
      keep_root, drop_root = sorted((left_root, right_root))
      parent[drop_root] = keep_root
      members[keep_root] = combined
      del members[drop_root]

    components = list(members.values())
    components.sort(key=heuristic_component_sort_key)
    return components


def is_valid_heuristic_component(component: list[dict]) -> bool:
    if len(component) > 12:
      return False
    orientations = {str(item["orientation"]) for item in component}
    if len(orientations) != 1:
      return False
    x1 = min(int(item["box"][0]) for item in component)
    y1 = min(int(item["box"][1]) for item in component)
    x2 = max(int(item["box"][2]) for item in component)
    y2 = max(int(item["box"][3]) for item in component)
    envelope_area = max(1.0, float((x2 - x1) * (y2 - y1)))
    occupied_area = sum(float(item["width"] * item["height"]) for item in component)
    return occupied_area / envelope_area >= 0.14


def select_heuristic_auxiliary_component(
    auxiliary: dict,
    components: list[list[dict]],
) -> list[dict] | None:
    matches: list[tuple[float, int, list[dict]]] = []
    for component_index, component in enumerate(components):
      costs = [
          cost
          for item in component
          if (cost := heuristic_auxiliary_attachment_cost(auxiliary, item)) is not None
      ]
      if costs:
        matches.append((min(costs), component_index, component))
    if not matches:
      return None
    matches.sort(key=lambda entry: (entry[0], entry[1]))
    if len(matches) > 1 and matches[1][0] <= matches[0][0] * 1.25:
      return None
    return matches[0][2]


def heuristic_auxiliary_attachment_cost(
    auxiliary: dict,
    primary: dict,
) -> float | None:
    if auxiliary["orientation"] != primary["orientation"]:
      return None
    ax1, ay1, ax2, ay2 = auxiliary["box"]
    bx1, by1, bx2, by2 = primary["box"]
    if auxiliary["orientation"] == "vertical":
      contained = axis_overlap_ratio(ay1, ay2, by1, by2)
      x_gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
      center_delta = abs(float(auxiliary["centerX"]) - float(primary["centerX"]))
      if contained < 0.72 or x_gap > float(primary["scale"]) * 0.45:
        return None
      if center_delta > float(primary["scale"]) * 0.85:
        return None
      return center_delta / max(1.0, float(primary["scale"]))
    contained = axis_overlap_ratio(ax1, ax2, bx1, bx2)
    y_gap = max(0.0, max(ay1, by1) - min(ay2, by2))
    center_delta = abs(float(auxiliary["centerY"]) - float(primary["centerY"]))
    if contained < 0.72 or y_gap > float(primary["scale"]) * 0.45:
      return None
    if center_delta > float(primary["scale"]) * 0.85:
      return None
    return center_delta / max(1.0, float(primary["scale"]))


def heuristic_component_sort_key(component: list[dict]) -> tuple:
    return (
        min(int(item["box"][1]) for item in component),
        -max(int(item["box"][2]) for item in component),
        min(int(item["index"]) for item in component),
    )


def sort_textline_group(group: list[dict], source_language: str) -> None:
    """Sort merged OCR fragments in source-language reading order."""

    if is_japanese_source_language(source_language) and is_vertical_textline_group(group):
      group[:] = sort_japanese_vertical_textline_group(group)
      return
    group.sort(key=textline_canonical_key)


def is_japanese_source_language(value: object) -> bool:
    return str(value or "ja").strip().lower().split("-", 1)[0] == "ja"


def is_vertical_textline_group(group: list[dict]) -> bool:
    vertical_count = 0
    horizontal_count = 0
    for item in group:
      item_width, item_height = textline_box_size(item)
      if item_height >= item_width * 1.2:
        vertical_count += 1
      elif item_width >= item_height * 1.2:
        horizontal_count += 1
    return (
        vertical_count > 0
        and vertical_count * 2 >= len(group)
        and vertical_count > horizontal_count
    )


def sort_japanese_vertical_textline_group(group: list[dict]) -> list[dict]:
    """Order Japanese columns right-to-left and fragments within them top-down."""

    canonical = sorted(group, key=textline_canonical_key)
    vertical_items = [item for item in canonical if is_vertical_textline_box(item)]
    parent = list(range(len(vertical_items)))

    def find(index: int) -> int:
      while parent[index] != index:
        parent[index] = parent[parent[index]]
        index = parent[index]
      return index

    for left in range(len(vertical_items)):
      for right in range(left + 1, len(vertical_items)):
        if are_same_vertical_column(vertical_items[left], vertical_items[right]):
          left_root = find(left)
          right_root = find(right)
          if left_root != right_root:
            parent[right_root] = left_root

    columns_by_root: dict[int, list[dict]] = {}
    for index, item in enumerate(vertical_items):
      columns_by_root.setdefault(find(index), []).append(item)
    columns = list(columns_by_root.values())

    # Square punctuation and short fragments must not bridge two established
    # columns. Assign each one to only its closest compatible column.
    for item in canonical:
      if is_vertical_textline_box(item):
        continue
      compatible = [
          column
          for column in columns
          if is_compatible_with_vertical_column(item, column)
      ]
      if compatible:
        closest = min(
            compatible,
            key=lambda column: (
                abs(textline_center_x(item) - textline_column_center_x(column)),
                -textline_column_center_x(column),
            ),
        )
        closest.append(item)
      else:
        columns.append([item])

    columns.sort(
        key=lambda column: (
            -textline_column_center_x(column),
            min(textline_canonical_key(item) for item in column),
        )
    )
    ordered: list[dict] = []
    for column in columns:
      column.sort(key=textline_column_item_key)
      ordered.extend(column)
    return ordered


def is_vertical_textline_box(item: dict) -> bool:
    item_width, item_height = textline_box_size(item)
    return item_height >= item_width * 1.2


def are_same_vertical_column(a: dict, b: dict) -> bool:
    aw, ah = textline_box_size(a)
    bw, bh = textline_box_size(b)
    center_delta = abs(textline_center_x(a) - textline_center_x(b))
    center_tolerance = max(4.0, min(aw, bw) * 0.12)
    if (
        center_delta <= center_tolerance
        and textline_horizontal_overlap_ratio(a, b) >= 0.45
    ):
      return True

    # The semantic merge predicate permits modest detector x-jitter for
    # narrow, strongly vertical fragments in one column. Use the same relaxed
    # range while ordering those fragments, otherwise a lower box shifted a
    # few pixels to the right becomes a false "right-hand column" and is read
    # before the upper box. Borderline-wide boxes remain separate columns so
    # genuine Japanese right-to-left column order is preserved.
    _, ay1, _, ay2 = box_tuple(a)
    _, by1, _, by2 = box_tuple(b)
    gap_y = max(0, max(ay1, by1) - min(ay2, by2))
    y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
    width_ratio = min(aw, bw) / max(aw, bw)
    strongly_vertical = ah >= aw * 1.5 and bh >= bw * 1.5
    return (
        strongly_vertical
        and y_overlap < 0.72
        and textline_horizontal_overlap_ratio(a, b) >= 0.62
        and gap_y <= max(14, min(aw, bw) * 0.9)
        and width_ratio >= 0.5
        and center_delta <= max(4, min(aw, bw) * 0.35)
    )


def is_compatible_with_vertical_column(item: dict, column: list[dict]) -> bool:
    item_width, _ = textline_box_size(item)
    column_widths = sorted(textline_box_size(candidate)[0] for candidate in column)
    column_width = median_number(column_widths)
    center_delta = abs(textline_center_x(item) - textline_column_center_x(column))
    center_tolerance = max(6.0, min(item_width, column_width) * 0.55)
    overlap = max(textline_horizontal_overlap_ratio(item, candidate) for candidate in column)
    return center_delta <= center_tolerance and overlap >= 0.2


def textline_column_center_x(column: list[dict]) -> float:
    vertical_centers = sorted(
        textline_center_x(item)
        for item in column
        if is_vertical_textline_box(item)
    )
    centers = vertical_centers or sorted(textline_center_x(item) for item in column)
    return median_number(centers)


def median_number(values: list[float]) -> float:
    if not values:
      return 0.0
    middle = len(values) // 2
    if len(values) % 2 == 1:
      return float(values[middle])
    return (float(values[middle - 1]) + float(values[middle])) / 2


def textline_box_size(item: dict) -> tuple[float, float]:
    x1, y1, x2, y2 = box_tuple(item)
    return (max(1.0, float(x2 - x1)), max(1.0, float(y2 - y1)))


def textline_center_x(item: dict) -> float:
    x1, _, x2, _ = box_tuple(item)
    return (x1 + x2) / 2


def textline_horizontal_overlap_ratio(a: dict, b: dict) -> float:
    ax1, _, ax2, _ = box_tuple(a)
    bx1, _, bx2, _ = box_tuple(b)
    return axis_overlap_ratio(ax1, ax2, bx1, bx2)


def textline_canonical_key(item: dict) -> tuple:
    x1, y1, x2, y2 = box_tuple(item)
    score = item.get("_score")
    score_key = float(score) if isinstance(score, (int, float)) else -1.0
    return (y1, x1, y2, x2, str(item.get("_text") or ""), score_key)


def textline_column_item_key(item: dict) -> tuple:
    x1, y1, x2, y2 = box_tuple(item)
    center_y = (y1 + y2) / 2
    return (y1, center_y, x1, x2, y2, str(item.get("_text") or ""))


def normalize_textline_merge_mode(value: object) -> str:
    text = str(value or "legacy").strip().lower()
    return text if text in {"legacy", "conservative", "semantic", "none"} else "legacy"


def resolve_textline_merge_mode(args: argparse.Namespace | None, default: str = "legacy") -> str:
    value = getattr(args, "merge_mode", None) if args is not None else None
    if value:
      return normalize_textline_merge_mode(value)
    return normalize_textline_merge_mode(os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE", default))


def should_merge_textline_boxes(a: dict, b: dict, page_width: int, page_height: int, mode: str = "legacy") -> bool:
    normalized_mode = normalize_textline_merge_mode(mode)
    if normalized_mode == "semantic":
      return should_merge_textline_boxes_semantic(a, b, page_width, page_height)
    if normalized_mode == "conservative":
      return should_merge_textline_boxes_conservative(a, b, page_width, page_height)

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


def should_merge_textline_boxes_conservative(a: dict, b: dict, page_width: int, page_height: int) -> bool:
    """Merge nearby OCR fragments without bridging adjacent speech bubbles."""

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
    if union_w * union_h > page_width * page_height * 0.045:
      return False
    if union_h > page_height * 0.22 or union_w > page_width * 0.26:
      return False

    gap_x = max(0, max(ax1, bx1) - min(ax2, bx2))
    gap_y = max(0, max(ay1, by1) - min(ay2, by2))
    x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
    y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)

    horizontal_a = aw >= ah * 0.75
    horizontal_b = bw >= bh * 0.75
    vertical_a = ah > aw * 1.25
    vertical_b = bh > bw * 1.25

    if horizontal_a and horizontal_b:
      if y_overlap >= 0.72 and gap_x <= max(8, min(ah, bh) * 0.35):
        return True
      if x_overlap >= 0.62 and gap_y <= max(14, min(ah, bh) * 0.55):
        return True
      return False

    if vertical_a and vertical_b:
      if y_overlap >= 0.72 and gap_x <= max(10, min(aw, bw) * 0.48):
        return True
      if x_overlap >= 0.62 and gap_y <= max(14, min(aw, bw) * 0.9):
        return True
      return False

    overlap = overlap_ratio((ax1, ay1, ax2, ay2), (bx1, by1, bx2, by2))
    if overlap > 0.42:
      return True
    return gap_x <= 6 and gap_y <= 6


def should_merge_textline_boxes_semantic(a: dict, b: dict, page_width: int, page_height: int) -> bool:
    """Build cautious reading-order groups while leaving final grouping to Gemma.

    Comic SFX detectors often produce a broad, almost-square box next to a
    narrow dialogue column.  The conservative renderer merge intentionally
    tolerates that shape mismatch, but semantic hints must not tell the vision
    model that those two areas are already one text container.
    """

    if not should_merge_textline_boxes_conservative(a, b, page_width, page_height):
      return False

    ax1, ay1, ax2, ay2 = box_tuple(a)
    bx1, by1, bx2, by2 = box_tuple(b)
    aw, ah = textline_box_size(a)
    bw, bh = textline_box_size(b)
    vertical_a = ah > aw * 1.25
    vertical_b = bh > bw * 1.25
    horizontal_a = aw >= ah * 0.75
    horizontal_b = bw >= bh * 0.75

    if vertical_a and vertical_b:
      gap_x = max(0, max(ax1, bx1) - min(ax2, bx2))
      gap_y = max(0, max(ay1, by1) - min(ay2, by2))
      x_overlap = axis_overlap_ratio(ax1, ax2, bx1, bx2)
      y_overlap = axis_overlap_ratio(ay1, ay2, by1, by2)
      # Adjacent columns may legitimately have very different widths because
      # one of them is furigana. Keep the original reading-band edge.
      if y_overlap >= 0.72 and gap_x <= max(10, min(aw, bw) * 0.48):
        return True

      # Same-column fragments should share a text scale and center. The two
      # real smoke regressions were a 40 px dialogue column paired with a
      # 102 px SFX box and a 37 px column paired with a 109 px SFX box.
      width_ratio = min(aw, bw) / max(aw, bw)
      center_x_delta = abs(textline_center_x(a) - textline_center_x(b))
      return (
          x_overlap >= 0.62
          and gap_y <= max(14, min(aw, bw) * 0.9)
          and width_ratio >= 0.5
          and center_x_delta <= max(4, min(aw, bw) * 0.35)
      )

    if horizontal_a and horizontal_b:
      return True

    # Do not pre-group mixed horizontal/vertical shapes merely because they
    # share a reading band. A wide standalone SFX beside a vertical dialogue
    # line is common in manga; Gemma can still merge separate top-level slots
    # when the image proves one container, while a false semantic union forces
    # one huge or misplaced overlay box.
    overlap = overlap_ratio((ax1, ay1, ax2, ay2), (bx1, by1, bx2, by2))
    return overlap > 0.42


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


def find_covering_existing_item(box: tuple[int, int, int, int], existing_items: list[dict]) -> dict | None:
    x1, y1, x2, y2 = box
    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2
    best_item = None
    best_overlap = 0.0
    for item in existing_items:
      item_x1 = float(item.get("x1", 0))
      item_y1 = float(item.get("y1", 0))
      item_x2 = float(item.get("x2", 0))
      item_y2 = float(item.get("y2", 0))
      if item_x1 <= center_x <= item_x2 and item_y1 <= center_y <= item_y2:
        overlap = overlap_ratio(box, (item_x1, item_y1, item_x2, item_y2))
        if best_item is None or overlap > best_overlap:
          best_item = item
          best_overlap = overlap
        continue
      overlap = overlap_ratio(box, (item_x1, item_y1, item_x2, item_y2))
      if overlap > 0.35 and overlap > best_overlap:
        best_item = item
        best_overlap = overlap
    return best_item


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
