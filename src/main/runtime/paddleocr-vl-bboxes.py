#!/usr/bin/env python3
"""Export PaddleOCR-VL geometry candidates for manga translation.

OCR transcripts are included only as low-trust alignment hints. The
translation model still reads the source image as the authority.
"""

from __future__ import annotations

import argparse
import atexit
import gc
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
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


DLL_DIRECTORY_HANDLES = []
TORCH_ROCM_SAFE_MODE_CONFIGURED = False
SELECTED_CUDA_DEVICE_INDEX = None
MLX_VLM_MODEL_REPO = "PaddlePaddle/PaddleOCR-VL-1.6"


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
    parser.add_argument(
        "--pipeline-version",
        default="v1.5",
        choices=["v1", "v1.5", "v1.6"],
    )
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
        choices=["legacy", "conservative", "none"],
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

    with maybe_mlx_vlm_server(args) as mlx_server:
      pipeline = PaddleOCRVL(**build_pipeline_kwargs(args, mlx_server))
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


def build_pipeline_kwargs(args: argparse.Namespace, mlx_server=None) -> dict:
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
    if is_mlx_vlm_backend():
      if mlx_server is None:
        raise RuntimeError("Apple MLX OCR requires a running MLX-VLM server.")
      pipeline_kwargs.update(
          {
              "pipeline_version": "v1.6",
              "vl_rec_backend": "mlx-vlm-server",
              "vl_rec_server_url": mlx_server.url,
              "vl_rec_api_model_name": mlx_server.model_name,
          }
      )
    return pipeline_kwargs


def is_mlx_vlm_backend() -> bool:
    return os.environ.get("MANGA_TRANSLATOR_OCR_GPU_BACKEND", "").strip().lower() in {
        "mlx",
        "metal",
        "mps",
        "apple",
        "mlx-vlm",
        "mlx-vlm-server",
    }


def resolve_mlx_vlm_model_name() -> str:
    cache_home = os.environ.get("PADDLE_PDX_CACHE_HOME", "").strip()
    if cache_home:
      local_model = Path(cache_home) / "official_models" / "PaddleOCR-VL-1.6"
      if (local_model / "config.json").is_file() and (local_model / "model.safetensors").is_file():
        return str(local_model)
    return MLX_VLM_MODEL_REPO


def reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
      listener.bind(("127.0.0.1", 0))
      return int(listener.getsockname()[1])


class MlxVlmServer:
    def __init__(self) -> None:
      self.port = reserve_loopback_port()
      self.url = f"http://127.0.0.1:{self.port}/"
      self.model_name = resolve_mlx_vlm_model_name()
      self.process = None
      self.log_file = None
      self.log_path = None

    def start(self) -> None:
      temp_root = Path(os.environ.get("TMP") or tempfile.gettempdir())
      temp_root.mkdir(parents=True, exist_ok=True)
      self.log_file = tempfile.NamedTemporaryFile(
          mode="w+",
          encoding="utf-8",
          prefix="manga-mlx-vlm-",
          suffix=".log",
          dir=temp_root,
          delete=False,
      )
      self.log_path = Path(self.log_file.name)
      command = [
          sys.executable,
          "-c",
          build_mlx_server_watchdog_code(os.getpid()),
          "--host",
          "127.0.0.1",
          "--port",
          str(self.port),
      ]
      self.process = subprocess.Popen(
          command,
          stdin=subprocess.DEVNULL,
          stdout=self.log_file,
          stderr=subprocess.STDOUT,
          env=os.environ.copy(),
      )
      atexit.register(self.close)
      try:
        self.wait_until_ready()
      except Exception:
        self.close()
        raise

    def wait_until_ready(self) -> None:
      timeout_seconds = max(
          10.0,
          float(os.environ.get("MANGA_TRANSLATOR_MLX_VLM_START_TIMEOUT_SECONDS", "120")),
      )
      deadline = time.monotonic() + timeout_seconds
      health_url = f"{self.url}health"
      last_error = ""
      while time.monotonic() < deadline:
        if self.process is not None and self.process.poll() is not None:
          raise RuntimeError(
              f"MLX-VLM server exited before startup (code {self.process.returncode}). "
              f"{self.read_log_tail()}"
          )
        try:
          with urllib.request.urlopen(health_url, timeout=2) as response:
            if 200 <= response.status < 300:
              return
        except (OSError, urllib.error.URLError) as exc:
          last_error = str(exc)
        time.sleep(0.2)
      raise RuntimeError(
          f"MLX-VLM server did not become ready within {timeout_seconds:.0f}s: {last_error}. "
          f"{self.read_log_tail()}"
      )

    def read_log_tail(self) -> str:
      if self.log_file is not None:
        self.log_file.flush()
      if self.log_path is None or not self.log_path.exists():
        return "No MLX-VLM server log was produced."
      text = self.log_path.read_text(encoding="utf-8", errors="replace")
      return text[-4000:].strip()

    def close(self) -> None:
      process = self.process
      self.process = None
      if process is not None and process.poll() is None:
        process.terminate()
        try:
          process.wait(timeout=10)
        except subprocess.TimeoutExpired:
          process.kill()
          process.wait(timeout=5)
      if self.log_file is not None:
        self.log_file.close()
        self.log_file = None
      if self.log_path is not None:
        try:
          self.log_path.unlink(missing_ok=True)
        except OSError:
          pass
        self.log_path = None
      try:
        atexit.unregister(self.close)
      except Exception:
        pass


@contextmanager
def maybe_mlx_vlm_server(args: argparse.Namespace):
    if not is_mlx_vlm_backend():
      yield None
      return
    if str(getattr(args, "device", "") or "").lower() != "cpu":
      raise RuntimeError("Apple MLX OCR requires Paddle layout detection to use the CPU device.")
    server = MlxVlmServer()
    server.start()
    try:
      yield server
    finally:
      server.close()


def build_mlx_server_watchdog_code(parent_pid: int) -> str:
    """Stop the local server if the OCR worker is killed by its Node parent."""

    return "\n".join(
        [
            "import os, threading, time",
            f"parent_pid = {int(parent_pid)}",
            "def watch_parent():",
            "    while os.getppid() == parent_pid:",
            "        time.sleep(1)",
            "    os._exit(1)",
            "threading.Thread(target=watch_parent, daemon=True).start()",
            "from mlx_vlm.server.cli import main",
            "main()",
        ]
    )


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
        score = None
        try:
          score = float(rec_scores[index]) if index < len(rec_scores) else None
        except Exception:
          score = None
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

    items = merge_textline_candidates(raw_candidates, width, height, mode=merge_mode)
    for index, item in enumerate(items):
      item["id"] = index + 1
      score = item.pop("_score", None)
      single_text = item.pop("_text", "")
      grouped_texts = item.pop("_texts", [])
      ocr_text = clean_ocr_text(single_text or merge_ocr_texts(grouped_texts))
      ocr_text = filter_candidate_ocr_text(ocr_text, score, args)
      if ocr_text:
        item["ocrText"] = ocr_text
      if isinstance(score, float):
        item["score"] = round(score, 4)

    finalize_ocr_text_fields(items)
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
          covering_item = find_covering_existing_item(box, existing_items)
          if covering_item is not None:
            if text:
              covering_item.setdefault("_texts", []).append(text)
            continue
          score = None
          try:
            score = float(rec_scores[index]) if index < len(rec_scores) else None
          except Exception:
            score = None
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


def merge_textline_candidates(candidates: list[dict], width: int, height: int, mode: str = "legacy") -> list[dict]:
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
        if should_merge_textline_boxes(candidates[left], candidates[right], width, height, mode=normalized_mode):
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


def normalize_textline_merge_mode(value: object) -> str:
    text = str(value or "legacy").strip().lower()
    return text if text in {"legacy", "conservative", "none"} else "legacy"


def resolve_textline_merge_mode(args: argparse.Namespace | None, default: str = "legacy") -> str:
    value = getattr(args, "merge_mode", None) if args is not None else None
    if value:
      return normalize_textline_merge_mode(value)
    return normalize_textline_merge_mode(os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE", default))


def should_merge_textline_boxes(a: dict, b: dict, page_width: int, page_height: int, mode: str = "legacy") -> bool:
    if normalize_textline_merge_mode(mode) == "conservative":
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
