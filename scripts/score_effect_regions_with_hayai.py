#!/usr/bin/env python3
"""Score grouped Koharu effect crops with Hayai OCR v2.

Hayai's public generate method returns text only.  This tool generates greedily,
then teacher-forces the generated token sequence to recover per-token
log-probabilities without changing the region geometry.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import unicodedata
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import torch
from PIL import Image, ImageOps
from transformers import AutoModel, AutoProcessor, PreTrainedTokenizerFast

import evaluate_koharu_region_boxes as base


MODEL_ID = "JustANormalTinkerer/hayai-ocr-v2"
MODEL_REVISION = "3608bb2075b9b39cb9f63e57251bca665de248cd"
PROCESSOR_ID = "google/siglip2-base-patch16-naflex"
SCHEMA_VERSION = "hayai-effect-crop-score-v1"


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value or ""))
    value = re.sub(r"[\r\n\t]+", " ", value)
    cjk = r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]"
    value = re.sub(rf"({cjk})\s+({cjk})", r"\1\2", value)
    return re.sub(r"\s+", " ", value).strip()


def is_text_character(character: str) -> bool:
    code = ord(character)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0x3040 <= code <= 0x30FF
        or 0xAC00 <= code <= 0xD7AF
        or character.isalpha()
        or character.isdigit()
    )


def clip_crop(image: Image.Image, box: Sequence[float]) -> Image.Image:
    left = max(0, int(math.floor(float(box[0]))))
    top = max(0, int(math.floor(float(box[1]))))
    right = min(image.width, int(math.ceil(float(box[2]))))
    bottom = min(image.height, int(math.ceil(float(box[3]))))
    if right <= left or bottom <= top:
        raise base.EvaluationError(f"empty Hayai crop: {list(box)}")
    return image.crop((left, top, right, bottom)).convert("RGB")


def load_model() -> tuple[Any, Any, Any, torch.device]:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = AutoModel.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        trust_remote_code=True,
    ).to(device).eval()
    tokenizer = PreTrainedTokenizerFast.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
    )
    processor = AutoProcessor.from_pretrained(PROCESSOR_ID)
    return model, tokenizer, processor, device


def teacher_forced_scores(
    model: Any,
    tokenizer: Any,
    model_inputs: Mapping[str, torch.Tensor],
    texts: Sequence[str],
    device: torch.device,
) -> list[dict[str, Any]]:
    bos_id = tokenizer.bos_token_id if tokenizer.bos_token_id is not None else 1
    eos_id = tokenizer.eos_token_id if tokenizer.eos_token_id is not None else 2
    pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos_id
    token_sequences = [
        tokenizer.encode(text, add_special_tokens=False) for text in texts
    ]
    inputs = [[bos_id, *tokens] for tokens in token_sequences]
    targets = [[*tokens, eos_id] for tokens in token_sequences]
    max_length = max(len(value) for value in inputs)
    input_tensor = torch.full(
        (len(inputs), max_length), pad_id, dtype=torch.long, device=device
    )
    target_tensor = torch.full_like(input_tensor, pad_id)
    target_mask = torch.zeros_like(input_tensor, dtype=torch.bool)
    for index, (input_ids, target_ids) in enumerate(zip(inputs, targets)):
        input_tensor[index, : len(input_ids)] = torch.tensor(
            input_ids, dtype=torch.long, device=device
        )
        target_tensor[index, : len(target_ids)] = torch.tensor(
            target_ids, dtype=torch.long, device=device
        )
        target_mask[index, : len(target_ids)] = True

    amp_dtype = torch.float16 if device.type == "cuda" else torch.float32
    with torch.no_grad(), torch.autocast(
        device_type=device.type,
        dtype=amp_dtype,
        enabled=device.type == "cuda",
    ):
        logits = model(
            pixel_values=model_inputs["pixel_values"],
            pixel_attention_mask=model_inputs["pixel_attention_mask"],
            spatial_shapes=model_inputs["spatial_shapes"],
            text_token_ids=input_tensor,
        )
        log_probabilities = torch.log_softmax(logits.float(), dim=-1)
        selected = torch.gather(
            log_probabilities, 2, target_tensor.unsqueeze(-1)
        ).squeeze(-1)

    records: list[dict[str, Any]] = []
    for index, tokens in enumerate(token_sequences):
        values = selected[index][target_mask[index]].detach().cpu().numpy()
        token_values = values[:-1] if len(values) > 1 else values
        mean_log_probability = float(np.mean(token_values))
        records.append(
            {
                "tokenCount": len(tokens),
                "meanTokenLogProbability": round(mean_log_probability, 6),
                "geometricMeanTokenProbability": round(
                    math.exp(mean_log_probability), 6
                ),
                "minimumTokenLogProbability": round(float(np.min(token_values)), 6),
                "eosLogProbability": round(float(values[-1]), 6),
            }
        )
    return records


def score_batch(
    model: Any,
    tokenizer: Any,
    processor: Any,
    device: torch.device,
    crops: Sequence[Image.Image],
    max_new_tokens: int,
    max_num_patches: int,
) -> tuple[list[str], list[dict[str, Any]], float]:
    model_inputs = processor(
        images=list(crops),
        max_num_patches=max_num_patches,
        return_tensors="pt",
    ).to(device)
    started = time.perf_counter()
    with torch.no_grad():
        texts = model.generate(
            pixel_values=model_inputs["pixel_values"],
            pixel_attention_mask=model_inputs["pixel_attention_mask"],
            spatial_shapes=model_inputs["spatial_shapes"],
            tokenizer=tokenizer,
            max_new_tokens=max_new_tokens,
            num_beams=1,
            repetition_penalty=1.0,
        )
    scores = teacher_forced_scores(
        model, tokenizer, model_inputs, texts, device
    )
    elapsed = time.perf_counter() - started
    return [str(value) for value in texts], scores, elapsed


def run(args: argparse.Namespace) -> None:
    input_dir = Path(args.input_dir).resolve()
    page_paths = sorted(
        (input_dir / "pages").glob("P*.json"),
        key=lambda path: base.natural_key(path.stem),
    )
    requested_pages = set(args.page_id or [])
    if requested_pages:
        page_paths = [path for path in page_paths if path.stem in requested_pages]
    if not page_paths:
        raise base.EvaluationError(f"no page reports under {input_dir / 'pages'}")

    work_items: list[dict[str, Any]] = []
    opened_page_id = ""
    opened_image: Image.Image | None = None
    for page_path in page_paths:
        page = base.read_json(page_path)
        page_id = str(page["pageId"])
        for region in page.get("onomatopoeiaRegions", []):
            work_items.append(
                {
                    "pageId": page_id,
                    "path": str(page["path"]),
                    "relativePath": str(page.get("relativePath", "")),
                    "outputId": str(region["outputId"]),
                    "regionId": str(region["regionId"]),
                    "bbox": list(region["bbox"]),
                    "groupedFromCount": int(region.get("groupedFromCount", 1)),
                    "sourceDetectionIds": list(region.get("sourceDetectionIds", [])),
                }
            )
    if args.limit is not None:
        work_items = work_items[: args.limit]
    if not work_items:
        raise base.EvaluationError("selected pages contain no effect regions")

    model, tokenizer, processor, device = load_model()
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    output_items: list[dict[str, Any]] = []
    total_inference_seconds = 0.0
    for offset in range(0, len(work_items), args.batch_size):
        batch = work_items[offset : offset + args.batch_size]
        crops: list[Image.Image] = []
        for item in batch:
            if opened_image is None or opened_page_id != item["pageId"]:
                if opened_image is not None:
                    opened_image.close()
                with Image.open(item["path"]) as source:
                    opened_image = ImageOps.exif_transpose(source).convert("RGB")
                opened_page_id = str(item["pageId"])
            crops.append(clip_crop(opened_image, item["bbox"]))
        texts, scores, elapsed = score_batch(
            model,
            tokenizer,
            processor,
            device,
            crops,
            args.max_new_tokens,
            args.max_num_patches,
        )
        total_inference_seconds += elapsed
        for item, text, score in zip(batch, texts, scores):
            normalized = normalize_text(text)
            text_character_count = sum(is_text_character(value) for value in normalized)
            output_items.append(
                {
                    **item,
                    "hayaiText": text,
                    "normalizedText": normalized,
                    "characterCount": len(normalized),
                    "textCharacterCount": text_character_count,
                    "textCharacterRatio": round(
                        text_character_count / max(1, len(normalized)), 6
                    ),
                    **score,
                }
            )
        completed = min(offset + len(batch), len(work_items))
        print(
            f"[hayai-score] {completed}/{len(work_items)} "
            f"batch={len(batch)} seconds={elapsed:.3f}",
            flush=True,
        )
    if opened_image is not None:
        opened_image.close()

    probabilities = [
        float(item["geometricMeanTokenProbability"]) for item in output_items
    ]
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "processorId": PROCESSOR_ID,
            "device": str(device),
            "maxNewTokens": args.max_new_tokens,
            "maxNumPatches": args.max_num_patches,
        },
        "summary": {
            "itemCount": len(output_items),
            "inferenceSeconds": round(total_inference_seconds, 3),
            "itemsPerSecond": round(
                len(output_items) / max(total_inference_seconds, 1e-9), 3
            ),
            "emptyTextCount": sum(not item["normalizedText"] for item in output_items),
            "probabilityQuantiles": {
                str(value): round(float(np.quantile(probabilities, value)), 6)
                for value in (0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0)
            },
            "peakCudaMemoryBytes": (
                int(torch.cuda.max_memory_allocated(device))
                if device.type == "cuda"
                else 0
            ),
        },
        "items": output_items,
    }
    output_path = Path(args.output).resolve()
    base.write_json(output_path, result)
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--page-id", action="append")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--max-num-patches", type=int, default=256)
    return parser


if __name__ == "__main__":
    try:
        run(build_parser().parse_args())
    except base.EvaluationError as error:
        print(f"[hayai-effect-score] {error}")
        raise SystemExit(2) from error
