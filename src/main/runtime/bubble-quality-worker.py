from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np
import torch
from PIL import Image
from transformers import (
    RTDetrImageProcessor,
    RTDetrV2ForObjectDetection,
    Sam2Model,
    Sam2Processor,
    Sam3TrackerModel,
    Sam3TrackerProcessor,
)
from transformers import logging as transformers_logging


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rtdetr-model-dir", required=True)
    parser.add_argument("--sam-model-dir", required=True)
    parser.add_argument("--sam-model", choices=("sam2.1", "sam3"), required=True)
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), required=True)
    return parser.parse_args()


def resolve_device(name: str) -> torch.device:
    if name == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    if name == "mps" and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class BubbleQualityModels:
    def __init__(self, args: argparse.Namespace) -> None:
        self.device = resolve_device(args.device)
        self.detector_processor = RTDetrImageProcessor.from_pretrained(
            args.rtdetr_model_dir, local_files_only=True
        )
        self.detector = RTDetrV2ForObjectDetection.from_pretrained(
            args.rtdetr_model_dir, local_files_only=True
        ).to(self.device)
        self.detector.eval()
        if args.sam_model == "sam3":
            self.sam_processor = Sam3TrackerProcessor.from_pretrained(
                args.sam_model_dir, local_files_only=True
            )
            self.sam = Sam3TrackerModel.from_pretrained(
                args.sam_model_dir,
                local_files_only=True,
                torch_dtype=self._preferred_dtype(),
            ).to(self.device)
        else:
            self.sam_processor = Sam2Processor.from_pretrained(
                args.sam_model_dir, local_files_only=True
            )
            self.sam = Sam2Model.from_pretrained(
                args.sam_model_dir,
                local_files_only=True,
                torch_dtype=self._preferred_dtype(),
            ).to(self.device)
        self.sam.eval()

    def _preferred_dtype(self) -> torch.dtype:
        return torch.float32 if self.device.type == "cpu" else torch.float16

    def _detect_bubbles(self, image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
        inputs = self.detector_processor(
            images=image,
            size={"height": 640, "width": 640},
            return_tensors="pt",
        )
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with torch.inference_mode():
            outputs = self.detector(**inputs)
        result = self.detector_processor.post_process_object_detection(
            outputs,
            threshold=0.25,
            target_sizes=[(image.height, image.width)],
            use_focal_loss=bool(getattr(self.detector.config, "use_focal_loss", True)),
        )[0]
        labels = result["labels"].detach().cpu().numpy()
        keep = labels == 0
        return (
            result["boxes"].detach().cpu().numpy()[keep],
            result["scores"].detach().cpu().numpy()[keep],
        )

    def _segment_boxes(self, image: Image.Image, boxes: list[list[float]]) -> list[np.ndarray]:
        input_boxes = torch.tensor([boxes], dtype=torch.float32)
        inputs = self.sam_processor(
            image, input_boxes=input_boxes, return_tensors="pt"
        )
        for key in inputs:
            value = inputs[key]
            if isinstance(value, torch.Tensor) and value.is_floating_point():
                inputs[key] = value.to(self.sam.dtype)
        inputs = inputs.to(self.device)
        with torch.inference_mode():
            outputs = self.sam(multimask_output=False, **inputs)
        masks = self.sam_processor.post_process_masks(
            outputs.pred_masks, inputs["original_sizes"]
        )[0][:, 0]
        return [(mask > 0).detach().cpu().numpy() for mask in masks]


def match_hints_to_boxes(
    hints: list[dict], boxes: np.ndarray, scores: np.ndarray
) -> list[int | None]:
    matches: list[int | None] = []
    for hint in hints:
        hint_box = rect_to_xyxy(hint)
        best_index = None
        best_score = float("-inf")
        for index, box in enumerate(boxes):
            coverage = intersection_area(hint_box, box) / max(1.0, box_area(hint_box))
            center_inside = point_in_box(box_center(hint_box), box)
            if coverage < 0.15 and not center_inside:
                continue
            area_ratio = box_area(box) / max(1.0, box_area(hint_box))
            candidate_score = float(scores[index]) * 2.0 + coverage
            candidate_score -= max(0.0, area_ratio - 30.0) * 0.01
            if candidate_score > best_score:
                best_index = index
                best_score = candidate_score
        matches.append(best_index)
    return matches


def group_matched_boxes(
    matches: list[int | None], boxes: np.ndarray
) -> tuple[list[list[float]], list[list[int]]]:
    # Filled by caller-facing indices after stable grouping.
    box_order: list[int] = []
    groups: list[list[int]] = []
    for hint_index, box_index in enumerate(matches):
        if box_index is None:
            continue
        if box_index in box_order:
            groups[box_order.index(box_index)].append(hint_index)
        else:
            box_order.append(box_index)
            groups.append([hint_index])
    return [boxes[index].tolist() for index in box_order], groups


def paint_owned_masks(
    output: np.ndarray,
    masks: list[np.ndarray],
    boxes: list[list[float]],
    hint_groups: list[list[int]],
    hints: list[dict],
) -> None:
    best_distances = np.full(output.shape, np.inf, dtype=np.float32)
    yy, xx = np.indices(output.shape)
    for mask, box, hint_indices in zip(masks, boxes, hint_groups):
        clipped = clip_mask_to_box(mask, box, output.shape[1], output.shape[0])
        for hint_index in hint_indices:
            hint = hints[hint_index]
            center_x = float(hint["x"]) + float(hint["w"]) / 2.0
            center_y = float(hint["y"]) + float(hint["h"]) / 2.0
            distances = (xx - center_x) ** 2 + (yy - center_y) ** 2
            owned = clipped & (distances < best_distances)
            output[owned] = min(255, hint_index + 1)
            best_distances[owned] = distances[owned]


def clip_mask_to_box(
    mask: np.ndarray, box: list[float], width: int, height: int
) -> np.ndarray:
    x0, y0, x1, y1 = box
    left = max(0, min(width, int(np.floor(x0))))
    top = max(0, min(height, int(np.floor(y0))))
    right = max(0, min(width, int(np.ceil(x1))))
    bottom = max(0, min(height, int(np.ceil(y1))))
    allowed = np.zeros((height, width), dtype=bool)
    allowed[top:bottom, left:right] = True
    return np.asarray(mask, dtype=bool) & allowed


def rect_to_xyxy(rect: dict) -> np.ndarray:
    x = float(rect["x"])
    y = float(rect["y"])
    return np.array([x, y, x + float(rect["w"]), y + float(rect["h"])])


def box_area(box: np.ndarray | list[float]) -> float:
    return max(0.0, float(box[2]) - float(box[0])) * max(
        0.0, float(box[3]) - float(box[1])
    )


def intersection_area(left: np.ndarray, right: np.ndarray) -> float:
    width = max(0.0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0.0, min(left[3], right[3]) - max(left[1], right[1]))
    return float(width * height)


def box_center(box: np.ndarray) -> tuple[float, float]:
    return ((float(box[0]) + float(box[2])) / 2, (float(box[1]) + float(box[3])) / 2)


def point_in_box(point: tuple[float, float], box: np.ndarray) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    transformers_logging.set_verbosity_error()
    models = BubbleQualityModels(parse_args())
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("type") == "shutdown":
                return
            if request.get("type") != "refine":
                continue
            started = time.monotonic()
            image = Image.open(request["input"]).convert("RGB")
            detection_boxes, scores = models._detect_bubbles(image)
            matches = match_hints_to_boxes(
                request.get("hints", []), detection_boxes, scores
            )
            matched_boxes, groups = group_matched_boxes(matches, detection_boxes)
            output = np.zeros((image.height, image.width), dtype=np.uint8)
            if matched_boxes:
                masks = models._segment_boxes(image, matched_boxes)
                paint_owned_masks(
                    output,
                    masks,
                    matched_boxes,
                    groups,
                    request.get("hints", []),
                )
            Image.fromarray(output, mode="L").save(request["output"])
            respond(
                {
                    "id": request.get("id"),
                    "ok": True,
                    "matched": sum(match is not None for match in matches),
                    "elapsed_ms": round((time.monotonic() - started) * 1000),
                }
            )
        except Exception as error:
            respond(
                {
                    "id": request.get("id") if "request" in locals() else None,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                }
            )


if __name__ == "__main__":
    main()
