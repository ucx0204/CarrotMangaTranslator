#!/usr/bin/env python3
"""Probe whether Hayai OCR can shrink oversized Koharu effect rectangles.

The detector geometry stays authoritative.  This experiment removes one outer
strip at a time and only accepts a smaller crop when Hayai returns exactly the
same normalized text as the untrimmed crop.  It is intentionally conservative:
the probe is for finding removable picture/background margins, not for deleting
or re-segmenting recognized glyphs.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

from PIL import Image, ImageDraw, ImageFont, ImageOps

import evaluate_koharu_region_boxes as base
import score_effect_regions_with_hayai as hayai


TRIM_FRACTIONS = (0.06, 0.10, 0.16, 0.24, 0.32)


def area(box: Sequence[float]) -> float:
    return max(0.0, float(box[2]) - float(box[0])) * max(
        0.0, float(box[3]) - float(box[1])
    )


def trim_variants(box: Sequence[float]) -> list[dict[str, Any]]:
    left, top, right, bottom = map(float, box)
    width = right - left
    height = bottom - top
    variants: list[dict[str, Any]] = []
    for side in ("left", "right", "top", "bottom"):
        dimension = width if side in {"left", "right"} else height
        for fraction in TRIM_FRACTIONS:
            delta = max(2.0, round(dimension * fraction))
            candidate = [left, top, right, bottom]
            if side == "left":
                candidate[0] += delta
            elif side == "right":
                candidate[2] -= delta
            elif side == "top":
                candidate[1] += delta
            else:
                candidate[3] -= delta
            if candidate[2] - candidate[0] < 16 or candidate[3] - candidate[1] < 16:
                continue
            variants.append(
                {
                    "side": side,
                    "fraction": fraction,
                    "bbox": candidate,
                }
            )
    return variants


def score_crops(
    model: Any,
    tokenizer: Any,
    processor: Any,
    device: Any,
    crops: Sequence[Image.Image],
    batch_size: int,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for offset in range(0, len(crops), batch_size):
        batch = crops[offset : offset + batch_size]
        texts, scores, _ = hayai.score_batch(
            model,
            tokenizer,
            processor,
            device,
            batch,
            max_new_tokens=64,
            max_num_patches=256,
        )
        for text, score in zip(texts, scores):
            records.append(
                {
                    "hayaiText": text,
                    "normalizedText": hayai.normalize_text(text),
                    **score,
                }
            )
    return records


def refine_one(
    image: Image.Image,
    initial_box: Sequence[float],
    target_text: str,
    baseline_probability: float,
    model: Any,
    tokenizer: Any,
    processor: Any,
    device: Any,
    batch_size: int,
    maximum_iterations: int,
) -> tuple[list[float], list[dict[str, Any]]]:
    current = list(map(float, initial_box))
    history: list[dict[str, Any]] = []
    minimum_probability = max(0.05, baseline_probability * 0.45)
    for iteration in range(1, maximum_iterations + 1):
        variants = trim_variants(current)
        crops = [hayai.clip_crop(image, item["bbox"]) for item in variants]
        scored = score_crops(
            model, tokenizer, processor, device, crops, batch_size
        )
        accepted: list[dict[str, Any]] = []
        for variant, score in zip(variants, scored):
            candidate = {**variant, **score}
            if (
                score["normalizedText"] == target_text
                and float(score["geometricMeanTokenProbability"])
                >= minimum_probability
            ):
                accepted.append(candidate)
        if not accepted:
            break
        winner = min(
            accepted,
            key=lambda value: (
                area(value["bbox"]),
                -float(value["geometricMeanTokenProbability"]),
            ),
        )
        previous_area = area(current)
        current = list(map(float, winner["bbox"]))
        history.append(
            {
                "iteration": iteration,
                "previousArea": round(previous_area, 3),
                "newArea": round(area(current), 3),
                "areaRatio": round(area(current) / max(1.0, previous_area), 6),
                **winner,
            }
        )
    return current, history


def run(args: argparse.Namespace) -> None:
    input_dir = Path(args.input_dir).resolve()
    scores = base.read_json(Path(args.scores).resolve())
    score_index = {
        (str(item["pageId"]), str(item["outputId"])): item
        for item in scores["items"]
    }
    requested = {
        tuple(value.split(":", 1))
        for value in args.region
    }
    if any(len(value) != 2 for value in requested):
        raise base.EvaluationError("--region must use PAGE:OUTPUT_ID, for example P168:FX003")

    model, tokenizer, processor, device = hayai.load_model()
    results: list[dict[str, Any]] = []
    for page_id, output_id in sorted(requested):
        page = base.read_json(input_dir / "pages" / f"{page_id}.json")
        region = next(
            (
                value
                for value in page.get("onomatopoeiaRegions", [])
                if str(value["outputId"]) == output_id
            ),
            None,
        )
        score = score_index.get((page_id, output_id))
        if region is None or score is None:
            raise base.EvaluationError(f"missing region or score: {page_id}:{output_id}")
        with Image.open(page["path"]) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
        refined, history = refine_one(
            image=image,
            initial_box=region["bbox"],
            target_text=str(score["normalizedText"]),
            baseline_probability=float(score["geometricMeanTokenProbability"]),
            model=model,
            tokenizer=tokenizer,
            processor=processor,
            device=device,
            batch_size=args.batch_size,
            maximum_iterations=args.maximum_iterations,
        )
        result = {
            "pageId": page_id,
            "outputId": output_id,
            "targetText": score["normalizedText"],
            "baselineProbability": score["geometricMeanTokenProbability"],
            "originalBbox": region["bbox"],
            "refinedBbox": [round(value, 3) for value in refined],
            "originalArea": round(area(region["bbox"]), 3),
            "refinedArea": round(area(refined), 3),
            "retainedAreaRatio": round(
                area(refined) / max(1.0, area(region["bbox"])), 6
            ),
            "history": history,
        }
        results.append(result)
        if args.diagnostic_dir:
            diagnostic_dir = Path(args.diagnostic_dir).resolve()
            diagnostic_dir.mkdir(parents=True, exist_ok=True)
            diagnostic = image.copy()
            draw = ImageDraw.Draw(diagnostic)
            line_width = max(3, int(round(min(image.size) * 0.004)))
            draw.rectangle(
                tuple(map(float, region["bbox"])),
                outline=(236, 72, 153),
                width=line_width,
            )
            draw.rectangle(
                tuple(map(float, refined)),
                outline=(6, 182, 212),
                width=line_width,
            )
            try:
                font = ImageFont.truetype("C:/Windows/Fonts/malgunbd.ttf", 24)
            except OSError:
                font = ImageFont.load_default()
            label = (
                f"{page_id}:{output_id} pink=original cyan=Hayai-stable "
                f"retained={result['retainedAreaRatio']:.3f}"
            )
            label_box = draw.textbbox((0, 0), label, font=font, stroke_width=2)
            draw.rectangle(
                (0, 0, label_box[2] + 20, label_box[3] + 18),
                fill=(255, 255, 255),
            )
            draw.text(
                (10, 8),
                label,
                fill=(20, 20, 20),
                font=font,
                stroke_width=1,
                stroke_fill=(255, 255, 255),
            )
            diagnostic.save(
                diagnostic_dir / f"{page_id}-{output_id}-trim.png",
                optimize=True,
            )
        console_text = str(score["normalizedText"]).encode(
            "unicode_escape"
        ).decode("ascii")
        print(
            f"[hayai-trim] {page_id}:{output_id} {console_text!r} "
            f"retained={result['retainedAreaRatio']:.3f} steps={len(history)}",
            flush=True,
        )

    output = {
        "schemaVersion": "hayai-effect-trim-probe-v1",
        "items": results,
    }
    output_path = Path(args.output).resolve()
    base.write_json(output_path, output)
    print(json.dumps(output, ensure_ascii=True, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--scores", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--region", action="append", required=True)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--maximum-iterations", type=int, default=12)
    parser.add_argument("--diagnostic-dir")
    return parser


if __name__ == "__main__":
    try:
        run(build_parser().parse_args())
    except base.EvaluationError as error:
        print(f"[hayai-effect-trim] {error}")
        raise SystemExit(2) from error
