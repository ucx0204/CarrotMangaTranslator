#!/usr/bin/env python3
"""Inspect and split over-merged Koharu speech-bubble masks.

This research tool deliberately uses no PaddleOCR geometry.  Koharu text
instances provide markers inside a Koharu bubble mask.  Marker-controlled
watershed exposes candidate lobes, and the distance-transform saddle between
adjacent lobes measures whether the shared connection is a narrow neck.
"""

from __future__ import annotations

import argparse
import html
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy import ndimage
from skimage.segmentation import find_boundaries, watershed

import evaluate_koharu_region_boxes as base


SCHEMA_VERSION = "koharu-dialogue-effect-separated-v11"
TEXT_CLASSES = frozenset({"text"})
MIN_TEXT_CONTAINMENT = 0.55
MERGE_INTERFACE_LENGTH_RATIO = 6.00
STRONG_APPEARANCE_SPLIT_DELTA = 36.0
TINY_LOBE_PEAK_RADIUS = 12.0
MIN_DUPLICATE_TEXT_MASK_OVERLAP = 0.75
MAX_NESTED_DUPLICATE_TEXT_AREA_RATIO = 0.01
FX_MAX_GROUP_GAP = 42.0
FX_MIN_GROUP_GAP = 8.0
FX_GAP_SCALE = 0.55
FX_MIN_AXIS_OVERLAP = 0.25
FX_MAX_LOW_SCORE_VERTICAL_PAGE_FRACTION = 0.45
FX_MAX_LOW_SCORE_VERTICAL_WIDTH_FRACTION = 0.35
FX_OVERSIZED_PROPOSAL_SCORE = 0.50
FX_TEXT_PRIORITY_BBOX_CONTAINMENT = 0.82
FX_TEXT_PRIORITY_MASK_CONTAINMENT = 0.08
FX_TEXT_PRIORITY_BBOX_IOU = 0.30
FX_BROAD_TEXT_MIN_CONTAINMENT = 0.75
FX_BROAD_TEXT_MIN_COUNT = 2
FX_BROAD_TEXT_MAX_SCORE = 0.50
FX_BROAD_DUPLICATE_BBOX_CONTAINMENT = 0.90
FX_BROAD_DUPLICATE_MASK_CONTAINMENT = 0.55
FX_PANEL_MIN_MASK_CONTAINMENT = 0.35
FX_PANEL_MIN_BBOX_CONTAINMENT = 0.50
FX_PANEL_MAX_ALIGNED_GAP = 96.0
FX_PANEL_ALIGNED_GAP_SCALE = 1.60
FX_PANEL_MIN_ALIGNED_OVERLAP = 0.50
FX_SPARSE_GRAPHIC_MIN_PAGE_AREA = 0.18
FX_SPARSE_GRAPHIC_MAX_MASK_DENSITY = 0.18
FX_SPARSE_GRAPHIC_MAX_SCORE = 0.50


def text_bubble_assignments(
    detections: Sequence[Mapping[str, Any]],
) -> dict[str, list[Mapping[str, Any]]]:
    bubbles = [value for value in detections if value["class"] == "bubble"]
    assignments: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for text in detections:
        if text["class"] not in TEXT_CLASSES:
            continue
        ranked: list[tuple[float, float, Mapping[str, Any]]] = []
        for bubble in bubbles:
            containment = base.mask_containment(text["mask"], bubble["mask"])
            box_containment = base.bbox_ioa(text["bbox"], bubble["bbox"])
            centered = base.center_in_mask(bubble["mask"], text["bbox"])
            score = max(containment, box_containment * (0.92 if centered else 0.65))
            if containment >= MIN_TEXT_CONTAINMENT or (centered and box_containment >= 0.60):
                ranked.append((score, float(bubble["score"]), bubble))
        if ranked:
            bubble = max(ranked, key=lambda value: value[:2])[2]
            assignments[str(bubble["id"])].append(text)
    return assignments


def marker_for_text(text_mask: np.ndarray, bubble_mask: np.ndarray) -> np.ndarray:
    """Return a stable marker near the middle of a Koharu text instance."""

    inside = np.logical_and(text_mask, bubble_mask)
    if not np.any(inside):
        return inside
    # Closing joins letters/columns without letting the marker escape the bubble.
    scale = max(1, int(round(min(bubble_mask.shape) * 0.0025)))
    closed = ndimage.binary_closing(inside, iterations=scale)
    closed = ndimage.binary_dilation(closed, iterations=max(1, scale))
    return np.logical_and(closed, bubble_mask)


def seeded_partition(
    bubble_mask: np.ndarray,
    texts: Sequence[Mapping[str, Any]],
) -> tuple[np.ndarray, np.ndarray]:
    markers = np.zeros(bubble_mask.shape, dtype=np.int32)
    for marker_id, text in enumerate(texts, 1):
        marker = marker_for_text(np.asarray(text["mask"], dtype=bool), bubble_mask)
        # Do not overwrite a previous marker in the rare case of overlapping text masks.
        markers[np.logical_and(marker, markers == 0)] = marker_id
    distance = ndimage.distance_transform_edt(bubble_mask)
    labels = watershed(-distance, markers=markers, mask=bubble_mask, watershed_line=False)
    return labels.astype(np.int32, copy=False), distance


def adjacency_statistics(
    labels: np.ndarray,
    distance: np.ndarray,
    grayscale: np.ndarray | None = None,
    excluded_mask: np.ndarray | None = None,
) -> list[dict[str, Any]]:
    """Measure the watershed saddle for every pair of touching basins."""

    maximum_by_label = {
        int(label): float(distance[labels == label].max(initial=0.0))
        for label in np.unique(labels)
        if int(label) > 0
    }
    intensity_by_label: dict[int, float] = {}
    gradient: np.ndarray | None = None
    boundary_exclusion: np.ndarray | None = None
    if grayscale is not None:
        smoothed = cv2.GaussianBlur(grayscale.astype(np.float32), (3, 3), 0)
        gradient_x = cv2.Sobel(smoothed, cv2.CV_32F, 1, 0, ksize=3)
        gradient_y = cv2.Sobel(smoothed, cv2.CV_32F, 0, 1, ksize=3)
        gradient = cv2.magnitude(gradient_x, gradient_y)
        gradient = ndimage.maximum_filter(gradient, size=3)
        safe_pixels = distance >= 5.0
        if excluded_mask is not None:
            boundary_exclusion = ndimage.binary_dilation(
                excluded_mask, iterations=7
            )
            safe_pixels = np.logical_and(
                safe_pixels,
                np.logical_not(ndimage.binary_dilation(excluded_mask, iterations=4)),
            )
        for label in maximum_by_label:
            pixels = grayscale[np.logical_and(labels == label, safe_pixels)]
            if pixels.size < 32:
                pixels = grayscale[labels == label]
            intensity_by_label[label] = (
                float(np.median(pixels)) if pixels.size else 0.0
            )
    pairs: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        first = labels[
            max(0, dy) : labels.shape[0] + min(0, dy),
            max(0, dx) : labels.shape[1] + min(0, dx),
        ]
        second = labels[
            max(0, -dy) : labels.shape[0] - max(0, dy),
            max(0, -dx) : labels.shape[1] - max(0, dx),
        ]
        changed = np.logical_and(first > 0, np.logical_and(second > 0, first != second))
        for row, column in np.argwhere(changed):
            left = int(first[row, column])
            right = int(second[row, column])
            pair = tuple(sorted((left, right)))
            y = int(row + max(0, dy))
            x = int(column + max(0, dx))
            pairs[pair].append((y, x))

    results: list[dict[str, Any]] = []
    for pair, coordinates in sorted(pairs.items()):
        samples = np.asarray([distance[y, x] for y, x in coordinates], dtype=np.float32)
        usable_coordinates = coordinates
        if boundary_exclusion is not None:
            usable_coordinates = [
                (y, x) for y, x in coordinates if not boundary_exclusion[y, x]
            ]
        gradient_samples = (
            np.asarray([gradient[y, x] for y, x in usable_coordinates], dtype=np.float32)
            if gradient is not None
            else np.asarray([], dtype=np.float32)
        )
        intensity_samples = (
            np.asarray([grayscale[y, x] for y, x in usable_coordinates], dtype=np.float32)
            if grayscale is not None
            else np.asarray([], dtype=np.float32)
        )
        # The upper tail is robust to one-pixel diagonal contacts and approximates
        # the radius of the strongest connection between the two basins.
        saddle = float(np.percentile(samples, 90)) if samples.size else 0.0
        smaller_peak = min(maximum_by_label[pair[0]], maximum_by_label[pair[1]])
        center_a = ndimage.center_of_mass(labels == pair[0])
        center_b = ndimage.center_of_mass(labels == pair[1])
        delta_y = abs(float(center_a[0]) - float(center_b[0]))
        delta_x = abs(float(center_a[1]) - float(center_b[1]))
        separator_axis = "x" if delta_x >= delta_y else "y"
        coordinate_index = 1 if separator_axis == "x" else 0
        separator_coordinate = float(
            np.median([value[coordinate_index] for value in coordinates])
        )
        interface_length_ratio = len(usable_coordinates) / max(
            1e-6, 2.0 * smaller_peak
        )
        results.append(
            {
                "labels": list(pair),
                "boundarySampleCount": int(samples.size),
                "saddleRadiusP90": round(saddle, 4),
                "smallerPeakRadius": round(smaller_peak, 4),
                "neckRatio": round(saddle / max(1e-6, smaller_peak), 6),
                "medianIntensity": [
                    round(intensity_by_label.get(pair[0], 0.0), 3),
                    round(intensity_by_label.get(pair[1], 0.0), 3),
                ],
                "intensityDelta": round(
                    abs(
                        intensity_by_label.get(pair[0], 0.0)
                        - intensity_by_label.get(pair[1], 0.0)
                    ),
                    3,
                ),
                "usableBoundarySampleCount": len(usable_coordinates),
                "boundaryGradientP50": round(
                    float(np.percentile(gradient_samples, 50))
                    if gradient_samples.size
                    else 0.0,
                    3,
                ),
                "boundaryGradientP75": round(
                    float(np.percentile(gradient_samples, 75))
                    if gradient_samples.size
                    else 0.0,
                    3,
                ),
                "boundaryGradientP90": round(
                    float(np.percentile(gradient_samples, 90))
                    if gradient_samples.size
                    else 0.0,
                    3,
                ),
                "boundaryStrongEdgeFraction": round(
                    float(np.mean(gradient_samples >= 220.0))
                    if gradient_samples.size
                    else 0.0,
                    6,
                ),
                "boundaryDarkFraction": round(
                    float(np.mean(intensity_samples <= 96.0))
                    if intensity_samples.size
                    else 0.0,
                    6,
                ),
                "interfaceLengthRatio": round(interface_length_ratio, 6),
                "separatorAxis": separator_axis,
                "separatorCoordinate": round(separator_coordinate, 3),
            }
        )
    return results


def add_light_interior_connectivity(
    adjacency: Sequence[dict[str, Any]],
    bubble_mask: np.ndarray,
    texts: Sequence[Mapping[str, Any]],
    grayscale: np.ndarray,
) -> None:
    """Describe whether text seeds occupy one uninterrupted light interior.

    Koharu can fuse two touching balloon masks.  Distance-transform necks alone
    cannot always distinguish that from two distant text groups inside one large
    balloon.  A real balloon outline usually separates the light fill into two
    components, while text glyphs themselves are explicitly filled back in so
    they do not create false barriers.
    """

    bubble = np.asarray(bubble_mask, dtype=bool)
    text_union = np.zeros(bubble.shape, dtype=bool)
    for text in texts:
        text_union = np.logical_or(
            text_union, np.asarray(text["mask"], dtype=bool)
        )
    light = np.logical_and(
        bubble,
        np.logical_or(grayscale >= 224.0, text_union),
    )
    light = ndimage.binary_closing(light, structure=np.ones((3, 3), dtype=bool))
    components, component_count = ndimage.label(
        light, structure=np.ones((3, 3), dtype=np.uint8)
    )
    component_by_label: dict[int, int] = {}
    support_by_label: dict[int, float] = {}
    for label, text in enumerate(texts, 1):
        seed = np.logical_and(
            ndimage.binary_dilation(
                np.asarray(text["mask"], dtype=bool), iterations=2
            ),
            bubble,
        )
        values = components[seed]
        values = values[values > 0]
        if not values.size:
            component_by_label[label] = 0
            support_by_label[label] = 0.0
            continue
        counts = np.bincount(values)
        dominant = int(np.argmax(counts[1:]) + 1)
        component_by_label[label] = dominant
        support_by_label[label] = float(counts[dominant] / values.size)

    for edge in adjacency:
        first, second = (int(value) for value in edge["labels"])
        first_component = component_by_label.get(first, 0)
        second_component = component_by_label.get(second, 0)
        edge["lightInteriorComponentCount"] = int(component_count)
        edge["lightInteriorComponents"] = [
            first_component,
            second_component,
        ]
        edge["lightInteriorSupport"] = [
            round(support_by_label.get(first, 0.0), 6),
            round(support_by_label.get(second, 0.0), 6),
        ]
        edge["sameLightInterior"] = bool(
            first_component > 0
            and first_component == second_component
            and support_by_label.get(first, 0.0) >= 0.50
            and support_by_label.get(second, 0.0) >= 0.50
        )


def add_page_enclosure_connectivity(
    adjacency: Sequence[dict[str, Any]],
    bubble_mask: np.ndarray,
    texts: Sequence[Mapping[str, Any]],
    grayscale: np.ndarray,
) -> None:
    """Probe closed light regions after removing text ink at several scales."""

    raw_box = base.mask_bbox(np.asarray(bubble_mask, dtype=bool))
    if raw_box is None:
        return
    padding = 16
    x1 = max(0, int(raw_box[0]) - padding)
    y1 = max(0, int(raw_box[1]) - padding)
    x2 = min(grayscale.shape[1], int(raw_box[2]) + padding + 1)
    y2 = min(grayscale.shape[0], int(raw_box[3]) + padding + 1)
    clean = grayscale[y1:y2, x1:x2].copy()
    local_texts: list[np.ndarray] = []
    for text in texts:
        local = np.asarray(text["mask"], dtype=bool)[y1:y2, x1:x2]
        local_texts.append(local)
        clean[ndimage.binary_dilation(local, iterations=2)] = 255.0

    signatures: dict[str, dict[tuple[int, int], bool | None]] = {}
    for threshold in (176.0, 208.0, 232.0):
        for radius in (1, 2, 3, 4):
            key = f"t{int(threshold)}-r{radius}"
            ink = clean < threshold
            ink = ndimage.binary_dilation(ink, iterations=radius)
            walkable = np.logical_not(ink)
            walkable[[0, -1], :] = False
            walkable[:, [0, -1]] = False
            components, _ = ndimage.label(
                walkable, structure=np.ones((3, 3), dtype=np.uint8)
            )
            component_by_label: dict[int, int] = {}
            support_by_label: dict[int, float] = {}
            for label, text_mask in enumerate(local_texts, 1):
                seed = np.logical_and(
                    ndimage.binary_dilation(text_mask, iterations=2),
                    walkable,
                )
                values = components[seed]
                values = values[values > 0]
                if not values.size:
                    component_by_label[label] = 0
                    support_by_label[label] = 0.0
                    continue
                counts = np.bincount(values)
                dominant = int(np.argmax(counts[1:]) + 1)
                component_by_label[label] = dominant
                support_by_label[label] = float(counts[dominant] / values.size)
            pair_values: dict[tuple[int, int], bool | None] = {}
            for edge in adjacency:
                first, second = (int(value) for value in edge["labels"])
                first_component = component_by_label.get(first, 0)
                second_component = component_by_label.get(second, 0)
                if (
                    not first_component
                    or not second_component
                    or support_by_label.get(first, 0.0) < 0.50
                    or support_by_label.get(second, 0.0) < 0.50
                ):
                    pair_values[(first, second)] = None
                else:
                    pair_values[(first, second)] = (
                        first_component == second_component
                    )
            signatures[key] = pair_values

    for edge in adjacency:
        pair = tuple(int(value) for value in edge["labels"])
        edge["sameEnclosureByScale"] = {
            key: values.get(pair) for key, values in signatures.items()
        }
        known = [
            bool(values[pair])
            for values in signatures.values()
            if values.get(pair) is not None
        ]
        edge["sameEnclosureVoteCount"] = sum(known)
        edge["differentEnclosureVoteCount"] = len(known) - sum(known)


def add_text_geometry(
    adjacency: Sequence[dict[str, Any]],
    texts: Sequence[Mapping[str, Any]],
    candidate_instances: Sequence[Mapping[str, Any]],
) -> None:
    """Attach source-text geometry to every watershed adjacency.

    Koharu sometimes emits several overlapping or adjoining ``text`` proposals
    for one continuous utterance.  Those proposal rectangles are more useful
    for recognizing that case than the watershed saddle alone.  This function
    only describes Koharu detections; it does not use Paddle geometry.
    """

    candidate_by_label = {
        int(str(value["candidateId"])[1:]): value
        for value in candidate_instances
    }
    for edge in adjacency:
        first_label, second_label = (int(value) for value in edge["labels"])
        first = texts[first_label - 1]
        second = texts[second_label - 1]
        first_box = [
            float(value)
            for value in candidate_by_label[first_label]["textPieceBbox"]
        ]
        second_box = [
            float(value)
            for value in candidate_by_label[second_label]["textPieceBbox"]
        ]
        first_width = max(1.0, first_box[2] - first_box[0])
        first_height = max(1.0, first_box[3] - first_box[1])
        second_width = max(1.0, second_box[2] - second_box[0])
        second_height = max(1.0, second_box[3] - second_box[1])
        horizontal_overlap = max(
            0.0,
            min(first_box[2], second_box[2])
            - max(first_box[0], second_box[0]),
        )
        vertical_overlap = max(
            0.0,
            min(first_box[3], second_box[3])
            - max(first_box[1], second_box[1]),
        )
        horizontal_gap = max(
            0.0,
            max(first_box[0], second_box[0])
            - min(first_box[2], second_box[2]),
        )
        vertical_gap = max(
            0.0,
            max(first_box[1], second_box[1])
            - min(first_box[3], second_box[3]),
        )
        first_box_area = first_width * first_height
        second_box_area = second_width * second_height
        box_intersection = horizontal_overlap * vertical_overlap
        first_mask = np.asarray(first["mask"], dtype=bool)
        second_mask = np.asarray(second["mask"], dtype=bool)
        first_mask_area = max(1, int(np.count_nonzero(first_mask)))
        second_mask_area = max(1, int(np.count_nonzero(second_mask)))
        mask_intersection = int(np.count_nonzero(np.logical_and(first_mask, second_mask)))
        smaller_box_area = min(first_box_area, second_box_area)
        smaller_mask_area = min(first_mask_area, second_mask_area)
        edge.update(
            {
                "textIds": [str(first["id"]), str(second["id"])],
                "textScores": [
                    round(float(first["score"]), 6),
                    round(float(second["score"]), 6),
                ],
                "textBboxes": [
                    [round(value, 3) for value in first_box],
                    [round(value, 3) for value in second_box],
                ],
                "sourceTextBboxes": [
                    [round(float(value), 3) for value in first["bbox"]],
                    [round(float(value), 3) for value in second["bbox"]],
                ],
                "textAreaRatio": round(
                    smaller_box_area / max(first_box_area, second_box_area), 6
                ),
                "textHorizontalGap": round(horizontal_gap, 3),
                "textVerticalGap": round(vertical_gap, 3),
                "textHorizontalOverlap": round(
                    horizontal_overlap / min(first_width, second_width), 6
                ),
                "textVerticalOverlap": round(
                    vertical_overlap / min(first_height, second_height), 6
                ),
                "textBboxIntersectionOverSmaller": round(
                    box_intersection / max(1.0, smaller_box_area), 6
                ),
                "textMaskIntersectionOverSmaller": round(
                    mask_intersection / max(1, smaller_mask_area), 6
                ),
            }
        )


def crop_box(box: Sequence[float], width: int, height: int, margin: int = 18) -> tuple[int, int, int, int]:
    return (
        max(0, int(np.floor(float(box[0]))) - margin),
        max(0, int(np.floor(float(box[1]))) - margin),
        min(width, int(np.ceil(float(box[2]))) + margin),
        min(height, int(np.ceil(float(box[3]))) + margin),
    )


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = Path("C:/Windows/Fonts/malgunbd.ttf" if bold else "C:/Windows/Fonts/malgun.ttf")
    try:
        return ImageFont.truetype(str(path), size=size)
    except OSError:
        return ImageFont.load_default()


def overlay_raw(
    image: Image.Image,
    bubble: Mapping[str, Any],
    texts: Sequence[Mapping[str, Any]],
) -> Image.Image:
    panel = image.convert("RGBA")
    rgba = np.asarray(panel).copy()
    mask = np.asarray(bubble["mask"], dtype=bool)
    rgba[mask, :3] = (0.72 * rgba[mask, :3] + 0.28 * np.asarray([6, 182, 212])).astype(np.uint8)
    panel = Image.fromarray(rgba, mode="RGBA")
    draw = ImageDraw.Draw(panel, "RGBA")
    draw.rectangle(tuple(bubble["bbox"]), outline=(6, 182, 212, 255), width=4)
    font = load_font(20, bold=True)
    draw.text((bubble["bbox"][0] + 6, bubble["bbox"][1] + 6), str(bubble["id"]), fill=(0, 0, 0, 255), font=font, stroke_width=3, stroke_fill=(255, 255, 255, 230))
    for text in texts:
        draw.rectangle(tuple(text["bbox"]), outline=(34, 197, 94, 255), width=4)
        draw.text((text["bbox"][0] + 4, text["bbox"][1] + 4), str(text["id"]), fill=(255, 255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0, 220))
    return panel


def overlay_partition(
    image: Image.Image,
    labels: np.ndarray,
    texts: Sequence[Mapping[str, Any]],
) -> Image.Image:
    palette = np.asarray(
        [
            [34, 197, 94],
            [236, 72, 153],
            [249, 115, 22],
            [139, 92, 246],
            [14, 165, 233],
            [234, 179, 8],
        ],
        dtype=np.float32,
    )
    rgba = np.asarray(image.convert("RGBA")).copy()
    for label in np.unique(labels):
        if int(label) <= 0:
            continue
        mask = labels == int(label)
        color = palette[(int(label) - 1) % len(palette)]
        rgba[mask, :3] = (0.66 * rgba[mask, :3] + 0.34 * color).astype(np.uint8)
    panel = Image.fromarray(rgba, mode="RGBA")
    draw = ImageDraw.Draw(panel, "RGBA")
    boundaries = find_boundaries(labels, mode="inner")
    boundary_rgba = np.asarray(panel).copy()
    boundary_rgba[boundaries, :3] = (255, 255, 0)
    boundary_rgba[boundaries, 3] = 255
    panel = Image.fromarray(boundary_rgba, mode="RGBA")
    draw = ImageDraw.Draw(panel, "RGBA")
    font = load_font(20, bold=True)
    for marker_id, text in enumerate(texts, 1):
        draw.rectangle(tuple(text["bbox"]), outline=(255, 255, 255, 255), width=3)
        draw.text((text["bbox"][0] + 4, text["bbox"][1] + 4), f"I{marker_id}:{text['id']}", fill=(255, 255, 255, 255), font=font, stroke_width=3, stroke_fill=(0, 0, 0, 230))
    return panel


def render_diagnostic(
    image: Image.Image,
    bubble: Mapping[str, Any],
    texts: Sequence[Mapping[str, Any]],
    labels: np.ndarray,
    output_path: Path,
) -> None:
    panels = [image.convert("RGBA"), overlay_raw(image, bubble, texts), overlay_partition(image, labels, texts)]
    headings = ["A · 원문", "B · Koharu 원본 bubble (과병합)", "C · text-seeded 후보 인스턴스"]
    box = crop_box(bubble["bbox"], image.width, image.height)
    cropped = [panel.crop(box) for panel in panels]
    panel_width = max(value.width for value in cropped)
    header_height = 64
    canvas = Image.new("RGBA", (panel_width * 3, max(value.height for value in cropped) + header_height), "white")
    draw = ImageDraw.Draw(canvas)
    font = load_font(21, bold=True)
    for index, (panel, heading) in enumerate(zip(cropped, headings)):
        x = index * panel_width
        canvas.alpha_composite(panel, (x, header_height))
        draw.text((x + 12, 18), heading, fill=(20, 20, 20, 255), font=font)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, quality=96)


def instance_records(
    labels: np.ndarray,
    texts: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for label, text in enumerate(texts, 1):
        mask = labels == label
        bubble_box = base.mask_bbox(mask)
        source_text_mask = np.asarray(text["mask"], dtype=bool)
        text_piece = np.logical_and(mask, source_text_mask)
        text_box = base.mask_bbox(text_piece)
        if bubble_box is None:
            continue
        if text_box is None:
            # Overlapping Koharu text masks can cause a marker to own only the
            # dilated fringe of its source mask.  Keep a stable core record;
            # broad-interface merging will normally reunite it with its peers.
            text_piece = source_text_mask
            text_box = base.mask_bbox(text_piece) or bubble_box
        rows, columns = np.nonzero(text_piece)
        records.append(
            {
                "candidateId": f"I{label:02d}",
                "textId": str(text["id"]),
                "textScore": round(float(text["score"]), 6),
                "sourceTextBbox": [
                    round(float(value), 3) for value in text["bbox"]
                ],
                "bubbleBbox": [round(float(value), 3) for value in bubble_box],
                "textPieceBbox": [round(float(value), 3) for value in text_box],
                "textCentroid": [
                    round(float(columns.mean()), 3),
                    round(float(rows.mean()), 3),
                ],
                "maskArea": int(np.count_nonzero(mask)),
                "textMaskArea": int(np.count_nonzero(text_piece)),
            }
        )
    return records


class DisjointSet:
    def __init__(self, values: Sequence[int]) -> None:
        self.parent = {int(value): int(value) for value in values}

    def find(self, value: int) -> int:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, first: int, second: int) -> None:
        first_root = self.find(first)
        second_root = self.find(second)
        if first_root != second_root:
            self.parent[max(first_root, second_root)] = min(first_root, second_root)


def merge_decision(edge: Mapping[str, Any]) -> tuple[bool, str]:
    intensity_delta = float(edge["intensityDelta"])
    if intensity_delta >= STRONG_APPEARANCE_SPLIT_DELTA:
        return False, "appearance-contrast"
    mask_overlap = float(edge.get("textMaskIntersectionOverSmaller", 0.0))
    if mask_overlap >= MIN_DUPLICATE_TEXT_MASK_OVERLAP:
        return True, "duplicate-text-mask"
    # A second Koharu proposal can be only a tiny, nested echo of a much larger
    # text proposal.  Treating that echo as an independent rectangle forces the
    # larger rectangle to be cut through its own text (P110/K017 is the clearest
    # example).  The low area-ratio guard keeps ordinary adjacent or intentionally
    # separate lines out of this rule.
    bbox_containment = float(edge.get("textBboxIntersectionOverSmaller", 0.0))
    text_area_ratio = float(edge.get("textAreaRatio", 1.0))
    if (
        bbox_containment >= 0.95
        and text_area_ratio <= MAX_NESTED_DUPLICATE_TEXT_AREA_RATIO
    ):
        return True, "nested-low-area-duplicate"
    return False, "distinct-text-proposals"


def pad_box(box: Sequence[float], width: int, height: int, padding: float = 5.0) -> list[float]:
    return base.clip_bbox(
        [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding],
        width,
        height,
    )


def boxes_intersect(first: Sequence[float], second: Sequence[float]) -> bool:
    return base.bbox_intersection(first, second) > 0.0


def clip_overlapping_pair(
    first_box: list[float],
    first_centroid: Sequence[float],
    second_box: list[float],
    second_centroid: Sequence[float],
    separation_margin: float = 0.0,
) -> tuple[str, float]:
    """Make two rectangles disjoint with one cut that keeps both anchors."""

    overlap_x = min(first_box[2], second_box[2]) - max(first_box[0], second_box[0])
    overlap_y = min(first_box[3], second_box[3]) - max(first_box[1], second_box[1])
    if overlap_x <= 0 or overlap_y <= 0:
        return "none", 0.0
    candidates: list[tuple[float, str, int, int, int]] = []
    for axis, axis_index, low_index, high_index, overlap in (
        ("x", 0, 0, 2, overlap_x),
        ("y", 1, 1, 3, overlap_y),
    ):
        first_anchor = min(
            max(float(first_centroid[axis_index]), first_box[low_index]),
            first_box[high_index],
        )
        second_anchor = min(
            max(float(second_centroid[axis_index]), second_box[low_index]),
            second_box[high_index],
        )
        separation = abs(first_anchor - second_anchor)
        candidates.append(
            (
                separation / max(1e-6, overlap),
                axis,
                axis_index,
                low_index,
                high_index,
            )
        )
    for _, axis, axis_index, low_index, high_index in sorted(
        candidates, reverse=True
    ):
        first_anchor = min(
            max(float(first_centroid[axis_index]), first_box[low_index]),
            first_box[high_index],
        )
        second_anchor = min(
            max(float(second_centroid[axis_index]), second_box[low_index]),
            second_box[high_index],
        )
        if first_anchor == second_anchor:
            first_anchor = (first_box[low_index] + first_box[high_index]) / 2.0
            second_anchor = (second_box[low_index] + second_box[high_index]) / 2.0
        if first_anchor <= second_anchor:
            lower_box, upper_box = first_box, second_box
        else:
            lower_box, upper_box = second_box, first_box
        overlap_low = max(lower_box[low_index], upper_box[low_index])
        overlap_high = min(lower_box[high_index], upper_box[high_index])
        if overlap_high <= overlap_low:
            continue
        coordinate = min(
            max((first_anchor + second_anchor) / 2.0, overlap_low),
            overlap_high,
        )
        half_margin = max(0.0, separation_margin) / 2.0
        proposed_lower_high = min(lower_box[high_index], coordinate - half_margin)
        proposed_upper_low = max(upper_box[low_index], coordinate + half_margin)
        if (
            proposed_lower_high <= lower_box[low_index]
            or upper_box[high_index] <= proposed_upper_low
        ):
            continue
        lower_box[high_index] = proposed_lower_high
        upper_box[low_index] = proposed_upper_low
        return axis, coordinate
    raise base.EvaluationError("unable to separate overlapping OCR rectangles")


def pixels_inside_box(
    rows: np.ndarray, columns: np.ndarray, box: Sequence[float]
) -> np.ndarray:
    return np.logical_and.reduce(
        (
            columns >= float(box[0]),
            rows >= float(box[1]),
            columns < float(box[2]),
            rows < float(box[3]),
        )
    )


def build_text_protection_mask(
    source_mask: np.ndarray, grayscale: np.ndarray
) -> np.ndarray:
    """Protect Koharu text plus nearby same-polarity glyph pixels from cuts."""

    source = np.asarray(source_mask, dtype=bool)
    if not np.any(source):
        return source.copy()
    near_source = ndimage.binary_dilation(source, iterations=3)
    ring = np.logical_and(
        ndimage.binary_dilation(source, iterations=2),
        np.logical_not(source),
    )
    source_mean = float(np.mean(grayscale[source]))
    ring_mean = (
        float(np.mean(grayscale[ring])) if np.any(ring) else source_mean
    )
    # Manga frequently uses white lettering on a solid black balloon.  Protect
    # the glyph polarity indicated by the mask-to-ring contrast; treating every
    # dark neighbour as ink would incorrectly protect the entire black fill.
    if source_mean > ring_mean + 5.0:
        nearby_glyph = grayscale > 160.0
    else:
        nearby_glyph = grayscale < 192.0
    nearby_ink = np.logical_and(nearby_glyph, near_source)
    return np.logical_or(
        ndimage.binary_dilation(source, iterations=1),
        ndimage.binary_dilation(nearby_ink, iterations=1),
    )


def glyph_safe_overlapping_pair_cut(
    first_box: list[float],
    first_centroid: Sequence[float],
    first_owned_mask: np.ndarray,
    second_box: list[float],
    second_centroid: Sequence[float],
    second_owned_mask: np.ndarray,
    protected_mask: np.ndarray,
    separation_margin: float = 2.0,
) -> tuple[str, float, dict[str, Any]] | None:
    """Find a whitespace seam instead of bisecting a Japanese glyph.

    Every half-pixel coordinate in the overlapping band is tested.  A seam is
    accepted only when the resulting two rectangles lose no protected text/ink
    pixels.  Ownership retention and rectangle shrinkage are tie-breakers; they
    never override the zero-loss requirement.
    """

    overlap_x = min(first_box[2], second_box[2]) - max(first_box[0], second_box[0])
    overlap_y = min(first_box[3], second_box[3]) - max(first_box[1], second_box[1])
    if overlap_x <= 0 or overlap_y <= 0:
        return "none", 0.0, {
            "protectedPixelLoss": 0,
            "firstOwnedRetention": 1.0,
            "secondOwnedRetention": 1.0,
        }

    before_first = list(first_box)
    before_second = list(second_box)
    before_union = np.zeros(protected_mask.shape, dtype=bool)
    first_y0 = max(0, int(np.floor(first_box[1])))
    first_y1 = min(protected_mask.shape[0], int(np.ceil(first_box[3])))
    first_x0 = max(0, int(np.floor(first_box[0])))
    first_x1 = min(protected_mask.shape[1], int(np.ceil(first_box[2])))
    second_y0 = max(0, int(np.floor(second_box[1])))
    second_y1 = min(protected_mask.shape[0], int(np.ceil(second_box[3])))
    second_x0 = max(0, int(np.floor(second_box[0])))
    second_x1 = min(protected_mask.shape[1], int(np.ceil(second_box[2])))
    before_union[first_y0:first_y1, first_x0:first_x1] = True
    before_union[second_y0:second_y1, second_x0:second_x1] = True
    protected_rows, protected_columns = np.nonzero(
        np.logical_and(protected_mask, before_union)
    )
    first_rows, first_columns = np.nonzero(first_owned_mask)
    second_rows, second_columns = np.nonzero(second_owned_mask)
    first_owned_count = max(1, len(first_rows))
    second_owned_count = max(1, len(second_rows))
    half_margin = max(0.0, separation_margin) / 2.0

    candidates: list[
        tuple[
            tuple[float, ...],
            str,
            float,
            list[float],
            list[float],
            dict[str, Any],
        ]
    ] = []
    for axis, axis_index, low_index, high_index, overlap in (
        ("x", 0, 0, 2, overlap_x),
        ("y", 1, 1, 3, overlap_y),
    ):
        first_anchor = min(
            max(float(first_centroid[axis_index]), first_box[low_index]),
            first_box[high_index],
        )
        second_anchor = min(
            max(float(second_centroid[axis_index]), second_box[low_index]),
            second_box[high_index],
        )
        if abs(first_anchor - second_anchor) < 1e-6:
            continue
        if first_anchor < second_anchor:
            lower_is_first = True
            lower_box = first_box
            upper_box = second_box
        else:
            lower_is_first = False
            lower_box = second_box
            upper_box = first_box
        lower_anchor = min(first_anchor, second_anchor)
        upper_anchor = max(first_anchor, second_anchor)
        overlap_low = max(lower_box[low_index], upper_box[low_index])
        overlap_high = min(lower_box[high_index], upper_box[high_index])
        if overlap_high <= overlap_low:
            continue
        coordinate_ticks = np.arange(
            int(np.ceil(overlap_low * 2.0)),
            int(np.floor(overlap_high * 2.0)) + 1,
            dtype=np.int32,
        )
        for tick in coordinate_ticks:
            coordinate = float(tick) / 2.0
            proposed_lower = list(lower_box)
            proposed_upper = list(upper_box)
            proposed_lower[high_index] = min(
                proposed_lower[high_index], coordinate - half_margin
            )
            proposed_upper[low_index] = max(
                proposed_upper[low_index], coordinate + half_margin
            )
            if (
                proposed_lower[high_index] <= proposed_lower[low_index]
                or proposed_upper[high_index] <= proposed_upper[low_index]
                or lower_anchor >= proposed_lower[high_index]
                or upper_anchor < proposed_upper[low_index]
            ):
                continue
            proposed_first = proposed_lower if lower_is_first else proposed_upper
            proposed_second = proposed_upper if lower_is_first else proposed_lower
            protected_after = np.logical_or(
                pixels_inside_box(
                    protected_rows, protected_columns, proposed_first
                ),
                pixels_inside_box(
                    protected_rows, protected_columns, proposed_second
                ),
            )
            protected_loss = int(np.count_nonzero(np.logical_not(protected_after)))
            first_retained = int(
                np.count_nonzero(
                    pixels_inside_box(first_rows, first_columns, proposed_first)
                )
            )
            second_retained = int(
                np.count_nonzero(
                    pixels_inside_box(second_rows, second_columns, proposed_second)
                )
            )
            first_retention = first_retained / first_owned_count
            second_retention = second_retained / second_owned_count
            old_area = base.bbox_area(before_first) + base.bbox_area(before_second)
            new_area = base.bbox_area(proposed_first) + base.bbox_area(proposed_second)
            area_removed = max(0.0, old_area - new_area)
            anchor_midpoint = (first_anchor + second_anchor) / 2.0
            score = (
                float(protected_loss),
                -min(first_retention, second_retention),
                -(first_retention + second_retention),
                area_removed,
                abs(coordinate - anchor_midpoint),
            )
            candidates.append(
                (
                    score,
                    axis,
                    coordinate,
                    proposed_first,
                    proposed_second,
                    {
                        "protectedPixelLoss": protected_loss,
                        "firstOwnedRetention": round(first_retention, 6),
                        "secondOwnedRetention": round(second_retention, 6),
                    },
                )
            )

    if not candidates:
        return None
    _, axis, coordinate, proposed_first, proposed_second, diagnostics = min(
        candidates, key=lambda value: value[0]
    )
    if int(diagnostics["protectedPixelLoss"]) != 0:
        return None
    first_box[:] = proposed_first
    second_box[:] = proposed_second
    return axis, coordinate, diagnostics


def duplicate_mask_proposals(
    first: Mapping[str, Any], second: Mapping[str, Any]
) -> bool:
    first_mask = np.asarray(first["mask"], dtype=bool)
    second_mask = np.asarray(second["mask"], dtype=bool)
    intersection = int(np.count_nonzero(np.logical_and(first_mask, second_mask)))
    smaller_area = min(
        int(np.count_nonzero(first_mask)), int(np.count_nonzero(second_mask))
    )
    return (
        base.bbox_iou(first["bbox"], second["bbox"]) >= 0.65
        and intersection / max(1, smaller_area) >= 0.75
    )


def build_uncontained_text_regions(
    detections: Sequence[Mapping[str, Any]],
    assignments: Mapping[str, Sequence[Mapping[str, Any]]],
    width: int,
    height: int,
) -> list[dict[str, Any]]:
    """Preserve narration/captions whose text mask has no speech bubble."""

    assigned_ids = {
        str(text["id"])
        for texts in assignments.values()
        for text in texts
    }
    candidates = sorted(
        (
            value
            for value in detections
            if value["class"] == "text" and str(value["id"]) not in assigned_ids
        ),
        key=lambda value: (-float(value["score"]), str(value["id"])),
    )
    candidate_groups = DisjointSet(range(len(candidates)))
    for first_index, first in enumerate(candidates):
        for second_index in range(first_index + 1, len(candidates)):
            second = candidates[second_index]
            intersection = base.bbox_intersection(first["bbox"], second["bbox"])
            smaller_box_area = min(
                base.bbox_area(first["bbox"]), base.bbox_area(second["bbox"])
            )
            bbox_containment = intersection / max(1e-6, smaller_box_area)
            if (
                duplicate_mask_proposals(first, second)
                or bbox_containment >= 0.90
            ):
                candidate_groups.union(first_index, second_index)

    grouped_candidates: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    for index, candidate in enumerate(candidates):
        grouped_candidates[candidate_groups.find(index)].append(candidate)

    regions: list[dict[str, Any]] = []
    for members in grouped_candidates.values():
        members = sorted(
            members,
            key=lambda value: (-float(value["score"]), str(value["id"])),
        )
        mask = np.zeros((height, width), dtype=bool)
        for detection in members:
            mask = np.logical_or(mask, np.asarray(detection["mask"], dtype=bool))
        raw_box = base.mask_bbox(mask)
        if raw_box is None:
            continue
        rows, columns = np.nonzero(mask)
        source_ids = [str(value["id"]) for value in members]
        source_scores = [round(float(value["score"]), 6) for value in members]
        regions.append(
            {
                "regionId": "",
                "kind": "uncontained-text",
                "sourceDetectionId": source_ids[0],
                "sourceDetectionIds": source_ids,
                "sourceDetectionScore": source_scores[0],
                "sourceDetectionScores": source_scores,
                "groupedFromCount": len(members),
                "sourceBbox": [round(float(value), 3) for value in raw_box],
                "bbox": base.padded_bbox(raw_box, width, height),
                "maskCentroid": [
                    round(float(columns.mean()), 3),
                    round(float(rows.mean()), 3),
                ],
                "pieceMaskArea": int(np.count_nonzero(mask)),
            }
        )
    regions.sort(
        key=lambda value: (float(value["bbox"][1]), -float(value["bbox"][0]))
    )
    for index, region in enumerate(regions, 1):
        region["regionId"] = f"T{index:02d}"
        region["bbox"] = [round(float(value), 3) for value in region["bbox"]]
    return regions


def build_onomatopoeia_regions(
    detections: Sequence[Mapping[str, Any]],
    width: int,
    height: int,
    rejected_proposals: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Group nearby sound-effect glyph proposals into crop-sized instances.

    This deliberately does not reuse the dialogue merge policy.  Koharu often
    emits a sound effect one glyph (or one stroke cluster) at a time, so aligned
    neighbours are joined here before any crop-level OCR/textness filtering.
    """

    candidates = sorted(
        (value for value in detections if value["class"] == "onomatopoeia"),
        key=lambda value: (-float(value["score"]), str(value["id"])),
    )
    text_detections = [value for value in detections if value["class"] == "text"]
    panel_detections = [value for value in detections if value["class"] == "panel"]
    kept: list[Mapping[str, Any]] = []
    for candidate in candidates:
        candidate_mask = np.asarray(candidate["mask"], dtype=bool)
        candidate_box = base.mask_bbox(candidate_mask)
        if candidate_box is None:
            continue
        candidate_width = float(candidate_box[2]) - float(candidate_box[0])
        candidate_height = float(candidate_box[3]) - float(candidate_box[1])
        oversized_low_score_vertical_strip = (
            candidate_height / max(1.0, float(height))
            >= FX_MAX_LOW_SCORE_VERTICAL_PAGE_FRACTION
            and candidate_width / max(1.0, float(width))
            <= FX_MAX_LOW_SCORE_VERTICAL_WIDTH_FRACTION
            and float(candidate["score"]) < FX_OVERSIZED_PROPOSAL_SCORE
        )
        if oversized_low_score_vertical_strip:
            if rejected_proposals is not None:
                rejected_proposals.append(
                    {
                        "sourceDetectionId": str(candidate["id"]),
                        "sourceDetectionScore": round(float(candidate["score"]), 6),
                        "bbox": [round(float(value), 3) for value in candidate_box],
                        "reason": "oversized-low-score-vertical-strip",
                    }
                )
            continue
        # A very broad, low-score FX proposal that encloses several independent
        # general-text detections is a layout-class error, not one sound effect.
        # Giving dialogue priority here also prevents its output box from
        # covering ordinary sentences (P166/K030 and P174/K019).
        enclosed_texts = [
            text
            for text in text_detections
            if base.bbox_ioa(text["bbox"], candidate_box)
            >= FX_BROAD_TEXT_MIN_CONTAINMENT
        ]
        if (
            float(candidate["score"]) < FX_BROAD_TEXT_MAX_SCORE
            and len(enclosed_texts) >= FX_BROAD_TEXT_MIN_COUNT
        ):
            if rejected_proposals is not None:
                rejected_proposals.append(
                    {
                        "sourceDetectionId": str(candidate["id"]),
                        "sourceDetectionScore": round(float(candidate["score"]), 6),
                        "bbox": [round(float(value), 3) for value in candidate_box],
                        "reason": "contains-multiple-general-text-regions",
                        "matchingTextDetectionIds": [
                            str(value["id"]) for value in enclosed_texts
                        ],
                        "matchingTextCount": len(enclosed_texts),
                    }
                )
            continue
        # Speech/narration is authoritative when Koharu emits the same glyphs
        # (or nearly the same crop) as both text and onomatopoeia.
        text_priority_match: dict[str, Any] | None = None
        for text in text_detections:
            text_mask = np.asarray(text["mask"], dtype=bool)
            box_containment = base.bbox_ioa(candidate_box, text["bbox"])
            box_iou = base.bbox_iou(candidate_box, text["bbox"])
            mask_containment = base.mask_containment(candidate_mask, text_mask)
            exact_duplicate = duplicate_mask_proposals(candidate, text)
            contained_by_text = (
                box_containment >= FX_TEXT_PRIORITY_BBOX_CONTAINMENT
                and (
                    mask_containment >= FX_TEXT_PRIORITY_MASK_CONTAINMENT
                    or box_iou >= FX_TEXT_PRIORITY_BBOX_IOU
                )
            )
            if not (exact_duplicate or contained_by_text):
                continue
            text_priority_match = {
                "sourceDetectionId": str(candidate["id"]),
                "sourceDetectionScore": round(float(candidate["score"]), 6),
                "bbox": [round(float(value), 3) for value in candidate_box],
                "reason": (
                    "duplicate-general-text"
                    if exact_duplicate
                    else "contained-by-general-text"
                ),
                "matchingTextDetectionId": str(text["id"]),
                "matchingTextScore": round(float(text["score"]), 6),
                "bboxContainment": round(box_containment, 6),
                "bboxIou": round(box_iou, 6),
                "maskContainment": round(mask_containment, 6),
            }
            break
        if text_priority_match is not None:
            if rejected_proposals is not None:
                rejected_proposals.append(text_priority_match)
            continue
        duplicate = False
        for existing in kept:
            box_containment = base.bbox_ioa(candidate["bbox"], existing["bbox"])
            reverse_box_containment = base.bbox_ioa(
                existing["bbox"], candidate["bbox"]
            )
            box_iou = base.bbox_iou(candidate["bbox"], existing["bbox"])
            mask_containment = base.mask_containment(
                np.asarray(candidate["mask"], dtype=bool),
                np.asarray(existing["mask"], dtype=bool),
            )
            reverse_mask_containment = base.mask_containment(
                np.asarray(existing["mask"], dtype=bool),
                np.asarray(candidate["mask"], dtype=bool),
            )
            if (
                box_containment >= 0.72 and mask_containment >= 0.42
            ) or (
                max(box_containment, reverse_box_containment) >= 0.90
                and box_iou >= 0.45
            ) or (
                reverse_box_containment
                >= FX_BROAD_DUPLICATE_BBOX_CONTAINMENT
                and reverse_mask_containment
                >= FX_BROAD_DUPLICATE_MASK_CONTAINMENT
                and float(candidate["score"]) <= float(existing["score"])
            ):
                duplicate = True
                break
        if not duplicate:
            kept.append(candidate)

    def owning_panel_id(
        mask: np.ndarray,
        raw_box: Sequence[float],
    ) -> str | None:
        ranked: list[tuple[float, float, float, str]] = []
        for panel in panel_detections:
            panel_mask = np.asarray(panel["mask"], dtype=bool)
            mask_containment = base.mask_containment(mask, panel_mask)
            box_containment = base.bbox_ioa(raw_box, panel["bbox"])
            centered = base.center_in_mask(panel_mask, raw_box)
            if not (
                mask_containment >= FX_PANEL_MIN_MASK_CONTAINMENT
                or box_containment >= FX_PANEL_MIN_BBOX_CONTAINMENT
                or (centered and box_containment >= 0.35)
            ):
                continue
            support = max(
                mask_containment,
                box_containment * (0.95 if centered else 0.75),
            )
            ranked.append(
                (
                    support,
                    mask_containment,
                    float(panel["score"]),
                    str(panel["id"]),
                )
            )
        return max(ranked)[3] if ranked else None

    pieces: list[dict[str, Any]] = []
    for piece_index, detection in enumerate(kept):
        mask = np.asarray(detection["mask"], dtype=bool)
        raw_box = base.mask_bbox(mask)
        if raw_box is None:
            continue
        rows, columns = np.nonzero(mask)
        pieces.append(
            {
                "pieceIndex": piece_index,
                "sourceDetectionId": str(detection["id"]),
                "sourceDetectionScore": round(
                    float(detection["score"]), 6
                ),
                "rawBbox": [float(value) for value in raw_box],
                "maskCentroid": [
                    round(float(columns.mean()), 3),
                    round(float(rows.mean()), 3),
                ],
                "pieceMaskArea": int(np.count_nonzero(mask)),
                "panelDetectionId": owning_panel_id(mask, raw_box),
            }
        )

    def axis_overlap_ratio(
        first_low: float,
        first_high: float,
        second_low: float,
        second_high: float,
    ) -> float:
        overlap = max(0.0, min(first_high, second_high) - max(first_low, second_low))
        return overlap / max(1.0, min(first_high - first_low, second_high - second_low))

    def axis_gap(
        first_low: float,
        first_high: float,
        second_low: float,
        second_high: float,
    ) -> float:
        return max(0.0, max(first_low, second_low) - min(first_high, second_high))

    groups = DisjointSet([int(piece["pieceIndex"]) for piece in pieces])
    grouping_edges: list[dict[str, Any]] = []
    for first_offset, first in enumerate(pieces):
        first_box = first["rawBbox"]
        first_width = max(1.0, float(first_box[2]) - float(first_box[0]))
        first_height = max(1.0, float(first_box[3]) - float(first_box[1]))
        for second in pieces[first_offset + 1 :]:
            first_panel_id = first.get("panelDetectionId")
            second_panel_id = second.get("panelDetectionId")
            if first_panel_id != second_panel_id:
                continue
            second_box = second["rawBbox"]
            second_width = max(1.0, float(second_box[2]) - float(second_box[0]))
            second_height = max(1.0, float(second_box[3]) - float(second_box[1]))
            first_aspect = first_width / first_height
            second_aspect = second_width / second_height
            orthogonal_extremes = (
                first_aspect >= 2.0 and second_aspect <= 0.5
            ) or (
                second_aspect >= 2.0 and first_aspect <= 0.5
            )
            horizontal_gap = axis_gap(
                float(first_box[0]),
                float(first_box[2]),
                float(second_box[0]),
                float(second_box[2]),
            )
            vertical_gap = axis_gap(
                float(first_box[1]),
                float(first_box[3]),
                float(second_box[1]),
                float(second_box[3]),
            )
            horizontal_overlap = axis_overlap_ratio(
                float(first_box[0]),
                float(first_box[2]),
                float(second_box[0]),
                float(second_box[2]),
            )
            vertical_overlap = axis_overlap_ratio(
                float(first_box[1]),
                float(first_box[3]),
                float(second_box[1]),
                float(second_box[3]),
            )
            horizontal_limit = min(
                FX_MAX_GROUP_GAP,
                max(
                    FX_MIN_GROUP_GAP,
                    FX_GAP_SCALE * min(first_height, second_height),
                ),
            )
            vertical_limit = min(
                FX_MAX_GROUP_GAP,
                max(
                    FX_MIN_GROUP_GAP,
                    FX_GAP_SCALE * min(first_width, second_width),
                ),
            )
            horizontal_continuation = (
                horizontal_gap <= horizontal_limit
                and vertical_overlap >= FX_MIN_AXIS_OVERLAP
            )
            vertical_continuation = (
                vertical_gap <= vertical_limit
                and horizontal_overlap >= FX_MIN_AXIS_OVERLAP
            )
            scale_ratio = min(
                first_width * first_height,
                second_width * second_height,
            ) / max(
                1.0,
                max(
                    first_width * first_height,
                    second_width * second_height,
                ),
            )
            same_known_panel = (
                first_panel_id is not None
                and first_panel_id == second_panel_id
            )
            panel_horizontal_limit = min(
                FX_PANEL_MAX_ALIGNED_GAP,
                FX_PANEL_ALIGNED_GAP_SCALE * min(first_height, second_height),
            )
            panel_vertical_limit = min(
                FX_PANEL_MAX_ALIGNED_GAP,
                FX_PANEL_ALIGNED_GAP_SCALE * min(first_width, second_width),
            )
            if same_known_panel and scale_ratio >= 0.35:
                horizontal_continuation = horizontal_continuation or (
                    horizontal_gap <= panel_horizontal_limit
                    and vertical_overlap >= FX_PANEL_MIN_ALIGNED_OVERLAP
                )
                vertical_continuation = vertical_continuation or (
                    vertical_gap <= panel_vertical_limit
                    and horizontal_overlap >= FX_PANEL_MIN_ALIGNED_OVERLAP
                )
            if orthogonal_extremes:
                continue
            if not (horizontal_continuation or vertical_continuation):
                continue
            first_index = int(first["pieceIndex"])
            second_index = int(second["pieceIndex"])
            groups.union(first_index, second_index)
            grouping_edges.append(
                {
                    "sourceDetectionIds": [
                        str(first["sourceDetectionId"]),
                        str(second["sourceDetectionId"]),
                    ],
                    "direction": (
                        "horizontal"
                        if horizontal_continuation and not vertical_continuation
                        else "vertical"
                        if vertical_continuation and not horizontal_continuation
                        else "intersecting"
                    ),
                    "horizontalGap": round(horizontal_gap, 3),
                    "verticalGap": round(vertical_gap, 3),
                    "horizontalOverlap": round(horizontal_overlap, 6),
                    "verticalOverlap": round(vertical_overlap, 6),
                    "horizontalGapLimit": round(horizontal_limit, 3),
                    "verticalGapLimit": round(vertical_limit, 3),
                }
            )

    pieces_by_root: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for piece in pieces:
        pieces_by_root[groups.find(int(piece["pieceIndex"]))].append(piece)

    effects: list[dict[str, Any]] = []
    for members in pieces_by_root.values():
        source_ids = [str(member["sourceDetectionId"]) for member in members]
        source_id_set = set(source_ids)
        raw_box = base.union_bbox([member["rawBbox"] for member in members])
        total_area = sum(int(member["pieceMaskArea"]) for member in members)
        center_x = sum(
            float(member["maskCentroid"][0]) * int(member["pieceMaskArea"])
            for member in members
        ) / max(1, total_area)
        center_y = sum(
            float(member["maskCentroid"][1]) * int(member["pieceMaskArea"])
            for member in members
        ) / max(1, total_area)
        raw_area = base.bbox_area(raw_box)
        page_area = max(1.0, float(width) * float(height))
        mask_density = total_area / max(1.0, raw_area)
        sparse_single_graphic = (
            len(members) == 1
            and raw_area / page_area >= FX_SPARSE_GRAPHIC_MIN_PAGE_AREA
            and mask_density <= FX_SPARSE_GRAPHIC_MAX_MASK_DENSITY
            and float(members[0]["sourceDetectionScore"])
            < FX_SPARSE_GRAPHIC_MAX_SCORE
        )
        if sparse_single_graphic:
            if rejected_proposals is not None:
                rejected_proposals.append(
                    {
                        "sourceDetectionId": str(members[0]["sourceDetectionId"]),
                        "sourceDetectionScore": round(
                            float(members[0]["sourceDetectionScore"]), 6
                        ),
                        "bbox": [round(float(value), 3) for value in raw_box],
                        "reason": "oversized-sparse-graphic",
                        "pageAreaFraction": round(raw_area / page_area, 6),
                        "maskDensity": round(mask_density, 6),
                    }
                )
            continue
        panel_ids = sorted(
            {
                str(member["panelDetectionId"])
                for member in members
                if member.get("panelDetectionId") is not None
            },
            key=base.natural_key,
        )
        effects.append(
            {
                "regionId": "",
                "kind": "onomatopoeia",
                "sourceDetectionIds": source_ids,
                "sourceDetectionScores": [
                    float(member["sourceDetectionScore"]) for member in members
                ],
                "sourceBboxes": [
                    [round(float(value), 3) for value in member["rawBbox"]]
                    for member in members
                ],
                "groupedFromCount": len(members),
                "groupingEdges": [
                    edge
                    for edge in grouping_edges
                    if set(edge["sourceDetectionIds"]).issubset(source_id_set)
                ],
                "containerClass": "panel" if len(panel_ids) == 1 else "page",
                "containerId": panel_ids[0] if len(panel_ids) == 1 else None,
                "panelDetectionIds": panel_ids,
                "bbox": base.padded_bbox(raw_box, width, height),
                "maskCentroid": [round(center_x, 3), round(center_y, 3)],
                "pieceMaskArea": total_area,
            }
        )
    effects.sort(key=lambda value: (float(value["bbox"][1]), -float(value["bbox"][0])))
    for index, effect in enumerate(effects, 1):
        effect["regionId"] = f"FX{index:02d}"
        effect["bbox"] = [round(float(value), 3) for value in effect["bbox"]]
    return effects


def dialogue_overlap_records(
    bubbles: Sequence[Mapping[str, Any]],
    uncontained_texts: Sequence[Mapping[str, Any]],
    detections_by_id: Mapping[str, Mapping[str, Any]],
    grayscale: np.ndarray,
) -> list[dict[str, Any]]:
    regions: list[dict[str, Any]] = []
    for bubble in bubbles:
        for instance in bubble["finalInstances"]:
            source_mask = np.zeros(grayscale.shape, dtype=bool)
            for text_id in instance.get("textIds", []):
                detection = detections_by_id.get(str(text_id))
                if detection is not None:
                    source_mask = np.logical_or(
                        source_mask,
                        np.asarray(detection["mask"], dtype=bool),
                    )
            regions.append(
                {
                    "id": f"{bubble['bubbleId']}/{instance['instanceId']}",
                    "bbox": instance["bbox"],
                    "centroid": instance["textCentroid"],
                    "ownedMask": source_mask,
                    # Page-level collisions are usually only padding from two
                    # independent containers.  Protect the detector mask plus a
                    # one-pixel halo; including nearby manga ink here can mistake
                    # a panel line or screentone for a glyph and make a harmless
                    # padding trim impossible.
                    "protectedMask": ndimage.binary_dilation(
                        source_mask, iterations=1
                    ),
                    "record": instance,
                }
            )
    for text in uncontained_texts:
        source_ids = [
            str(value)
            for value in text.get(
                "sourceDetectionIds", [text["sourceDetectionId"]]
            )
        ]
        source_mask = np.zeros(grayscale.shape, dtype=bool)
        for source_id in source_ids:
            detection = detections_by_id.get(source_id)
            if detection is not None:
                source_mask = np.logical_or(
                    source_mask,
                    np.asarray(detection["mask"], dtype=bool),
                )
        regions.append(
            {
                "id": str(text["regionId"]),
                "bbox": text["bbox"],
                "centroid": text["maskCentroid"],
                "ownedMask": source_mask,
                "protectedMask": ndimage.binary_dilation(
                    source_mask, iterations=1
                ),
                "record": text,
            }
        )
    return regions


def effect_overlap_records(
    effects: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    return [
        {
            "id": str(effect["regionId"]),
            "bbox": effect["bbox"],
            "centroid": effect["maskCentroid"],
            "record": effect,
        }
        for effect in effects
    ]


def rectify_region_overlaps(
    regions: Sequence[Mapping[str, Any]], namespace: str
) -> list[dict[str, Any]]:
    """Clip overlaps only within one independently consumed output set."""

    changes: list[dict[str, Any]] = []
    # A single pass is sufficient for monotonic clipping, but repeat defensively
    # because one page can contain a chain of three or more touching rectangles.
    for _ in range(max(1, len(regions))):
        changed = False
        for first_index, first in enumerate(regions):
            for second in regions[first_index + 1 :]:
                if not boxes_intersect(first["bbox"], second["bbox"]):
                    continue
                before_first = list(first["bbox"])
                before_second = list(second["bbox"])
                diagnostics: dict[str, Any] = {}
                strategy = "centroid-cut"
                if namespace == "dialogue":
                    protected_mask = np.logical_or(
                        first["protectedMask"], second["protectedMask"]
                    )
                    safe_result = glyph_safe_overlapping_pair_cut(
                        first["bbox"],
                        first["centroid"],
                        first["ownedMask"],
                        second["bbox"],
                        second["centroid"],
                        second["ownedMask"],
                        protected_mask,
                        separation_margin=2.0,
                    )
                    if safe_result is None:
                        raise base.EvaluationError(
                            "no zero-ink page-level dialogue seam between "
                            f"{first['id']} and {second['id']}"
                        )
                    axis, coordinate, diagnostics = safe_result
                    strategy = "zero-ink-whitespace-seam"
                else:
                    axis, coordinate = clip_overlapping_pair(
                        first["bbox"],
                        first["centroid"],
                        second["bbox"],
                        second["centroid"],
                        separation_margin=0.0,
                    )
                if base.bbox_area(first["bbox"]) <= 0 or base.bbox_area(second["bbox"]) <= 0:
                    raise base.EvaluationError(
                        f"page overlap rectification emptied {first['id']} or {second['id']}"
                    )
                first["record"]["bbox"] = [round(float(value), 3) for value in first["bbox"]]
                second["record"]["bbox"] = [round(float(value), 3) for value in second["bbox"]]
                changes.append(
                    {
                        "namespace": namespace,
                        "regions": [str(first["id"]), str(second["id"])],
                        "axis": axis,
                        "coordinate": round(coordinate, 3),
                        "strategy": strategy,
                        "separationMargin": 2.0 if namespace == "dialogue" else 0.0,
                        **diagnostics,
                        "before": [before_first, before_second],
                        "after": [list(first["bbox"]), list(second["bbox"])],
                    }
                )
                changed = True
        if not changed:
            break

    for first_index, first in enumerate(regions):
        for second in regions[first_index + 1 :]:
            if boxes_intersect(first["bbox"], second["bbox"]):
                raise base.EvaluationError(
                    f"page overlap remains between {first['id']} and {second['id']}"
                )
    return changes


def assign_output_ids(
    bubbles: Sequence[Mapping[str, Any]],
    uncontained_texts: Sequence[Mapping[str, Any]],
    effects: Sequence[Mapping[str, Any]],
) -> None:
    dialogue_records: list[tuple[str, dict[str, Any]]] = []
    for bubble in bubbles:
        for instance in bubble["finalInstances"]:
            dialogue_records.append(("bubble-text", instance))
    dialogue_records.extend(("uncontained-text", value) for value in uncontained_texts)
    dialogue_records.sort(
        key=lambda item: (
            float(item[1]["bbox"][1]),
            -float(item[1]["bbox"][2]),
            item[0],
        )
    )
    for index, (kind, record) in enumerate(dialogue_records, 1):
        record["outputId"] = f"D{index:03d}"
        record["outputKind"] = kind
    effect_records = sorted(
        effects,
        key=lambda record: (
            float(record["bbox"][1]),
            -float(record["bbox"][2]),
        ),
    )
    for index, record in enumerate(effect_records, 1):
        record["outputId"] = f"FX{index:03d}"
        record["outputKind"] = "onomatopoeia"


def dialogue_inventory(page: Mapping[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    common = {
        "pageId": str(page["pageId"]),
        "path": str(page["path"]),
        "relativePath": str(page.get("relativePath", "")),
    }
    for bubble in page.get("bubbles", []):
        for instance in bubble.get("finalInstances", []):
            items.append(
                {
                    **common,
                    "outputId": str(instance["outputId"]),
                    "kind": "bubble-text",
                    "bubbleId": str(bubble["bubbleId"]),
                    "instanceId": str(instance["instanceId"]),
                    "sourceTextIds": list(instance.get("textIds", [])),
                    "bbox": list(instance["bbox"]),
                }
            )
    for region in page.get("uncontainedTextRegions", []):
        source_ids = [
            str(value)
            for value in region.get(
                "sourceDetectionIds", [region["sourceDetectionId"]]
            )
        ]
        items.append(
            {
                **common,
                "outputId": str(region["outputId"]),
                "kind": "uncontained-text",
                "regionId": str(region["regionId"]),
                "sourceTextIds": source_ids,
                "bbox": list(region["bbox"]),
            }
        )
    return sorted(items, key=lambda item: str(item["outputId"]))


def effect_inventory(page: Mapping[str, Any]) -> list[dict[str, Any]]:
    common = {
        "pageId": str(page["pageId"]),
        "path": str(page["path"]),
        "relativePath": str(page.get("relativePath", "")),
    }
    return [
        {
            **common,
            "outputId": str(region["outputId"]),
            "kind": "onomatopoeia",
            "regionId": str(region["regionId"]),
            "sourceDetectionIds": list(region.get("sourceDetectionIds", [])),
            "sourceDetectionScores": list(region.get("sourceDetectionScores", [])),
            "sourceBboxes": list(region.get("sourceBboxes", [])),
            "groupedFromCount": int(region.get("groupedFromCount", 1)),
            "panelDetectionIds": list(region.get("panelDetectionIds", [])),
            "containerClass": region.get("containerClass"),
            "containerId": region.get("containerId"),
            "bbox": list(region["bbox"]),
            "ocrFilter": region.get("ocrFilter"),
        }
        for region in sorted(
            page.get("onomatopoeiaRegions", []),
            key=lambda value: str(value["outputId"]),
        )
    ]


def build_final_instances(
    labels: np.ndarray,
    texts: Sequence[Mapping[str, Any]],
    candidate_instances: Sequence[Mapping[str, Any]],
    adjacency: list[dict[str, Any]],
    grayscale: np.ndarray,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    label_ids = [index for index in range(1, len(texts) + 1) if np.any(labels == index)]
    groups = DisjointSet(label_ids)
    for edge in adjacency:
        merge, reason = merge_decision(edge)
        edge["decision"] = "merge" if merge else "split"
        edge["decisionReason"] = reason
        if merge:
            groups.union(int(edge["labels"][0]), int(edge["labels"][1]))

    candidate_by_label = {
        int(str(value["candidateId"])[1:]): value for value in candidate_instances
    }
    lossless_rectangle_merges: list[dict[str, Any]] = []
    while True:
        members_by_root: dict[int, list[int]] = defaultdict(list)
        for label in label_ids:
            members_by_root[groups.find(label)].append(label)
        final: list[dict[str, Any]] = []
        for root, members in sorted(members_by_root.items()):
            text_boxes = [
                candidate_by_label[label]["textPieceBbox"] for label in members
            ]
            box = pad_box(
                base.union_bbox(text_boxes), labels.shape[1], labels.shape[0]
            )
            weighted_area = sum(
                int(candidate_by_label[label]["textMaskArea"]) for label in members
            )
            center_x = sum(
                float(candidate_by_label[label]["textCentroid"][0])
                * int(candidate_by_label[label]["textMaskArea"])
                for label in members
            ) / max(1, weighted_area)
            center_y = sum(
                float(candidate_by_label[label]["textCentroid"][1])
                * int(candidate_by_label[label]["textMaskArea"])
                for label in members
            ) / max(1, weighted_area)
            owned_mask = np.zeros(labels.shape, dtype=bool)
            source_mask = np.zeros(labels.shape, dtype=bool)
            for member in members:
                member_source = np.asarray(texts[member - 1]["mask"], dtype=bool)
                source_mask = np.logical_or(source_mask, member_source)
                owned_mask = np.logical_or(
                    owned_mask,
                    np.logical_and(labels == member, member_source),
                )
            # Koharu's mask is the primary guard.  Nearby dark image pixels catch
            # imperfect mask edges, while the limited dilation avoids treating a
            # speech-bubble outline as text.
            protected_mask = build_text_protection_mask(source_mask, grayscale)
            final.append(
                {
                    "instanceId": "",
                    "rootLabel": root,
                    "candidateLabels": members,
                    "candidateIds": [f"I{label:02d}" for label in members],
                    "textIds": [str(texts[label - 1]["id"]) for label in members],
                    "bbox": box,
                    "textCentroid": [center_x, center_y],
                    "_ownedMask": owned_mask,
                    "_protectedMask": protected_mask,
                }
            )

        # Padded rectangles may overlap even when the text columns are separate.
        # Search the overlap for a true blank seam.  If no zero-ink seam exists,
        # the two groups cannot be represented as disjoint rectangles without
        # bisecting a glyph, so the only lossless rectangular output is one group.
        instance_overlap_rectifications: list[dict[str, Any]] = []
        unsafe_pair: tuple[dict[str, Any], dict[str, Any]] | None = None
        for first_index, first in enumerate(final):
            for second in final[first_index + 1 :]:
                if not boxes_intersect(first["bbox"], second["bbox"]):
                    continue
                before = [list(first["bbox"]), list(second["bbox"])]
                protected_mask = np.logical_or(
                    first["_protectedMask"], second["_protectedMask"]
                )
                result = glyph_safe_overlapping_pair_cut(
                    first["bbox"],
                    first["textCentroid"],
                    first["_ownedMask"],
                    second["bbox"],
                    second["textCentroid"],
                    second["_ownedMask"],
                    protected_mask,
                    separation_margin=2.0,
                )
                if result is None:
                    unsafe_pair = (first, second)
                    break
                axis, coordinate, diagnostics = result
                instance_overlap_rectifications.append(
                    {
                        "roots": [
                            int(first["rootLabel"]),
                            int(second["rootLabel"]),
                        ],
                        "axis": axis,
                        "coordinate": round(coordinate, 3),
                        "strategy": "zero-ink-whitespace-seam",
                        "separationMargin": 2.0,
                        **diagnostics,
                        "before": before,
                        "after": [list(first["bbox"]), list(second["bbox"])],
                    }
                )
            if unsafe_pair is not None:
                break
        if unsafe_pair is None:
            break

        first, second = unsafe_pair
        first_members = set(int(value) for value in first["candidateLabels"])
        second_members = set(int(value) for value in second["candidateLabels"])
        groups.union(int(first["rootLabel"]), int(second["rootLabel"]))
        lossless_rectangle_merges.append(
            {
                "roots": [int(first["rootLabel"]), int(second["rootLabel"])],
                "candidateIds": [
                    list(first["candidateIds"]),
                    list(second["candidateIds"]),
                ],
                "textIds": [list(first["textIds"]), list(second["textIds"])],
                "reason": "no-zero-ink-rectangle-seam",
                "before": [list(first["bbox"]), list(second["bbox"])],
            }
        )
        for edge in adjacency:
            edge_labels = set(int(value) for value in edge.get("labels", []))
            if edge_labels & first_members and edge_labels & second_members:
                edge["decision"] = "merge"
                edge["decisionReason"] = "no-zero-ink-rectangle-seam"

    final.sort(key=lambda value: (float(value["bbox"][1]), -float(value["bbox"][0])))
    for index, instance in enumerate(final, 1):
        instance.pop("_ownedMask", None)
        instance.pop("_protectedMask", None)
        instance["instanceId"] = f"S{index:02d}"
        instance["bbox"] = [round(float(value), 3) for value in instance["bbox"]]
        instance["textCentroid"] = [round(float(value), 3) for value in instance["textCentroid"]]
        if base.bbox_area(instance["bbox"]) <= 0:
            raise base.EvaluationError("non-overlap rectification produced an empty box")
    for first_index, first in enumerate(final):
        for second in final[first_index + 1 :]:
            if boxes_intersect(first["bbox"], second["bbox"]):
                raise base.EvaluationError(
                    "non-overlap rectification left intersecting boxes"
                )
    return final, instance_overlap_rectifications, lossless_rectangle_merges


def analyze_bubble(
    image: Image.Image,
    bubble: Mapping[str, Any],
    texts: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], np.ndarray]:
    labels, distance = seeded_partition(np.asarray(bubble["mask"], dtype=bool), texts)
    grayscale = np.asarray(image.convert("L"), dtype=np.float32)
    excluded = np.zeros(labels.shape, dtype=bool)
    for text in texts:
        excluded = np.logical_or(excluded, np.asarray(text["mask"], dtype=bool))
    stats = adjacency_statistics(
        labels,
        distance,
        grayscale=grayscale,
        excluded_mask=excluded,
    )
    add_light_interior_connectivity(
        stats,
        np.asarray(bubble["mask"], dtype=bool),
        texts,
        grayscale,
    )
    add_page_enclosure_connectivity(
        stats,
        np.asarray(bubble["mask"], dtype=bool),
        texts,
        grayscale,
    )
    candidates = instance_records(labels, texts)
    add_text_geometry(stats, texts, candidates)
    (
        final_instances,
        instance_overlap_rectifications,
        lossless_rectangle_merges,
    ) = build_final_instances(
        labels, texts, candidates, stats, grayscale
    )
    report = {
        "bubbleId": str(bubble["id"]),
        "bbox": [round(float(value), 3) for value in bubble["bbox"]],
        "textIds": [str(value["id"]) for value in texts],
        "candidateInstanceCount": int(labels.max(initial=0)),
        "candidateInstances": candidates,
        "finalInstanceCount": len(final_instances),
        "finalInstances": final_instances,
        "instanceOverlapRectifications": instance_overlap_rectifications,
        "losslessRectangleMerges": lossless_rectangle_merges,
        "adjacency": stats,
    }
    return report, labels


def inspect(args: argparse.Namespace) -> None:
    record = base.read_json(Path(args.record).resolve())
    with Image.open(record["path"]) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    page_grayscale = np.asarray(image.convert("L"), dtype=np.float32)
    model, _ = base.load_layout_model()
    prediction = model.predict(
        image,
        threshold=base.MIN_PREDICT_THRESHOLD,
        shape=(1152, 1152),
        include_source_image=False,
    )
    detections = base.prepare_layout_detections(prediction, image.width, image.height)
    by_id = {str(value["id"]): value for value in detections}
    assignments = text_bubble_assignments(detections)
    bubble_ids = [args.bubble_id] if args.bubble_id else sorted(assignments, key=base.natural_key)
    output_dir = Path(args.output_dir).resolve()
    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "pageId": str(record["id"]),
        "path": str(record["path"]),
        "bubbles": [],
    }
    for bubble_id in bubble_ids:
        bubble = by_id.get(bubble_id)
        if bubble is None or bubble["class"] != "bubble":
            raise base.EvaluationError(f"bubble not found: {bubble_id}")
        texts = sorted(assignments.get(bubble_id, []), key=lambda value: (float(value["bbox"][1]), -float(value["bbox"][0])))
        bubble_report, labels = analyze_bubble(image, bubble, texts)
        render_diagnostic(image, bubble, texts, labels, output_dir / f"{record['id']}-{bubble_id}-split-diagnostic.png")
        report["bubbles"].append(bubble_report)
    uncontained_texts = build_uncontained_text_regions(
        detections, assignments, image.width, image.height
    )
    rejected_effect_proposals: list[dict[str, Any]] = []
    effects = build_onomatopoeia_regions(
        detections,
        image.width,
        image.height,
        rejected_effect_proposals,
    )
    report["uncontainedTextRegions"] = uncontained_texts
    report["onomatopoeiaRegions"] = effects
    report["rejectedOnomatopoeiaProposals"] = rejected_effect_proposals
    report["dialogueOverlapRectifications"] = rectify_region_overlaps(
        dialogue_overlap_records(
            report["bubbles"], uncontained_texts, by_id, page_grayscale
        ),
        "dialogue",
    )
    report["effectOverlapRectifications"] = rectify_region_overlaps(
        effect_overlap_records(effects),
        "effects",
    )
    assign_output_ids(report["bubbles"], uncontained_texts, effects)
    base.write_json(output_dir / f"{record['id']}-split-diagnostic.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def batch(args: argparse.Namespace) -> None:
    source_dir = Path(args.results_dir).resolve()
    result_paths = sorted(source_dir.glob("P*.json"), key=lambda path: base.natural_key(path.stem))
    requested_ids = set(args.page_id or [])
    if requested_ids:
        result_paths = [path for path in result_paths if path.stem in requested_ids]
    if not result_paths:
        raise base.EvaluationError(f"no P*.json records found under {source_dir}")
    output_dir = Path(args.output_dir).resolve()
    page_dir = output_dir / "pages"
    model, _ = base.load_layout_model()
    page_reports: list[dict[str, Any]] = []
    all_edges: list[dict[str, Any]] = []
    for index, result_path in enumerate(result_paths, 1):
        output_path = page_dir / result_path.name
        if output_path.is_file() and not args.force:
            page_report = base.read_json(output_path)
            page_reports.append(page_report)
            for bubble in page_report["bubbles"]:
                for edge in bubble["adjacency"]:
                    all_edges.append(
                        {
                            "pageId": page_report["pageId"],
                            "bubbleId": bubble["bubbleId"],
                            **edge,
                        }
                    )
            print(f"[batch] {index}/{len(result_paths)} {result_path.stem} cached", flush=True)
            continue
        source_record = base.read_json(result_path)
        with Image.open(source_record["path"]) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
        page_grayscale = np.asarray(image.convert("L"), dtype=np.float32)
        prediction = model.predict(
            image,
            threshold=base.MIN_PREDICT_THRESHOLD,
            shape=(1152, 1152),
            include_source_image=False,
        )
        detections = base.prepare_layout_detections(prediction, image.width, image.height)
        assignments = text_bubble_assignments(detections)
        by_id = {str(value["id"]): value for value in detections}
        bubbles: list[dict[str, Any]] = []
        for bubble_id in sorted(assignments, key=base.natural_key):
            texts = sorted(
                assignments[bubble_id],
                key=lambda value: (float(value["bbox"][1]), -float(value["bbox"][0])),
            )
            bubble_report, _ = analyze_bubble(image, by_id[bubble_id], texts)
            bubbles.append(bubble_report)
            for edge in bubble_report["adjacency"]:
                all_edges.append(
                    {"pageId": str(source_record["id"]), "bubbleId": bubble_id, **edge}
                )
        uncontained_texts = build_uncontained_text_regions(
            detections, assignments, image.width, image.height
        )
        rejected_effect_proposals: list[dict[str, Any]] = []
        effects = build_onomatopoeia_regions(
            detections,
            image.width,
            image.height,
            rejected_effect_proposals,
        )
        dialogue_overlap_rectifications = rectify_region_overlaps(
            dialogue_overlap_records(
                bubbles, uncontained_texts, by_id, page_grayscale
            ),
            "dialogue",
        )
        effect_overlap_rectifications = rectify_region_overlaps(
            effect_overlap_records(effects),
            "effects",
        )
        assign_output_ids(bubbles, uncontained_texts, effects)
        page_report = {
            "schemaVersion": SCHEMA_VERSION,
            "pageId": str(source_record["id"]),
            "path": str(source_record["path"]),
            "relativePath": str(source_record["relativePath"]),
            "width": image.width,
            "height": image.height,
            "bubbleDetectionCount": sum(value["class"] == "bubble" for value in detections),
            "textDetectionCount": sum(value["class"] == "text" for value in detections),
            "onomatopoeiaDetectionCount": sum(
                value["class"] == "onomatopoeia" for value in detections
            ),
            "bubbles": bubbles,
            "uncontainedTextRegions": uncontained_texts,
            "onomatopoeiaRegions": effects,
            "rejectedOnomatopoeiaProposals": rejected_effect_proposals,
            "dialogueOverlapRectifications": dialogue_overlap_rectifications,
            "effectOverlapRectifications": effect_overlap_rectifications,
        }
        base.write_json(output_path, page_report)
        page_reports.append(page_report)
        multi_count = sum(len(value["textIds"]) > 1 for value in bubbles)
        print(
            f"[batch] {index}/{len(result_paths)} {result_path.stem} bubbles={len(bubbles)} multi={multi_count}",
            flush=True,
        )
    neck_values = sorted(float(value["neckRatio"]) for value in all_edges)
    intensity_values = sorted(float(value["intensityDelta"]) for value in all_edges)
    interface_values = sorted(float(value["interfaceLengthRatio"]) for value in all_edges)
    quantiles = (0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0)
    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "pageCount": len(page_reports),
        "bubbleWithTextCount": sum(len(page["bubbles"]) for page in page_reports),
        "multiTextBubbleCount": sum(
            len(bubble["textIds"]) > 1
            for page in page_reports
            for bubble in page["bubbles"]
        ),
        "candidateAdjacencyCount": len(all_edges),
        "mergeAdjacencyCount": sum(value.get("decision") == "merge" for value in all_edges),
        "splitAdjacencyCount": sum(value.get("decision") == "split" for value in all_edges),
        "candidateInstanceCount": sum(
            int(bubble["candidateInstanceCount"])
            for page in page_reports
            for bubble in page["bubbles"]
        ),
        "finalInstanceCount": sum(
            int(bubble["finalInstanceCount"])
            for page in page_reports
            for bubble in page["bubbles"]
        ),
        "bubbleInstanceOverlapRectificationCount": sum(
            len(bubble.get("instanceOverlapRectifications", []))
            for page in page_reports
            for bubble in page["bubbles"]
        ),
        "bubbleLosslessRectangleMergeCount": sum(
            len(bubble.get("losslessRectangleMerges", []))
            for page in page_reports
            for bubble in page["bubbles"]
        ),
        "onomatopoeiaRegionCount": sum(
            len(page.get("onomatopoeiaRegions", [])) for page in page_reports
        ),
        "rejectedOnomatopoeiaProposalCount": sum(
            len(page.get("rejectedOnomatopoeiaProposals", []))
            for page in page_reports
        ),
        "uncontainedTextRegionCount": sum(
            len(page.get("uncontainedTextRegions", [])) for page in page_reports
        ),
        "dialogueOverlapRectificationCount": sum(
            len(page.get("dialogueOverlapRectifications", []))
            for page in page_reports
        ),
        "effectOverlapRectificationCount": sum(
            len(page.get("effectOverlapRectifications", []))
            for page in page_reports
        ),
        "neckRatioQuantiles": {
            str(value): round(float(np.quantile(neck_values, value)), 6)
            for value in quantiles
        } if neck_values else {},
        "intensityDeltaQuantiles": {
            str(value): round(float(np.quantile(intensity_values, value)), 3)
            for value in quantiles
        } if intensity_values else {},
        "interfaceLengthRatioQuantiles": {
            str(value): round(float(np.quantile(interface_values, value)), 6)
            for value in quantiles
        } if interface_values else {},
    }
    base.write_json(output_dir / "summary.json", summary)
    base.write_json(output_dir / "candidate-adjacencies.json", {"items": all_edges})
    base.write_json(
        output_dir / "dialogue-regions.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "dialogue",
            "items": [
                item for page in page_reports for item in dialogue_inventory(page)
            ],
        },
    )
    base.write_json(
        output_dir / "effect-regions.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "effects",
            "items": [
                item for page in page_reports for item in effect_inventory(page)
            ],
        },
    )
    base.write_json(
        output_dir / "effect-rejections.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "effects",
            "items": [
                {
                    "pageId": str(page["pageId"]),
                    "path": str(page["path"]),
                    "relativePath": str(page.get("relativePath", "")),
                    **rejection,
                }
                for page in page_reports
                for rejection in page.get("rejectedOnomatopoeiaProposals", [])
            ],
        },
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def draw_labeled_box(
    draw: ImageDraw.ImageDraw,
    box: Sequence[float],
    label: str,
    color: tuple[int, int, int, int],
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    width: int,
    dashed: bool = False,
) -> None:
    if dashed:
        base.draw_dashed_rectangle(draw, box, color, width, dash=10)
    else:
        draw.rounded_rectangle(tuple(box), radius=5, outline=color, width=width)
    base.draw_box_label(draw, box, label, color, font)


def render_candidate_page(
    page: Mapping[str, Any], output_path: Path, mode: str
) -> None:
    with Image.open(page["path"]) as opened:
        original = ImageOps.exif_transpose(opened).convert("RGB")
    panel_width = 700
    max_panel_height = 1600
    scale = min(panel_width / original.width, max_panel_height / original.height)
    display_size = (
        max(1, int(round(original.width * scale))),
        max(1, int(round(original.height * scale))),
    )
    source = original.resize(display_size, Image.Resampling.LANCZOS)
    raw_panel = source.copy().convert("RGBA")
    split_panel = source.copy().convert("RGBA")
    raw_draw = ImageDraw.Draw(raw_panel, "RGBA")
    split_draw = ImageDraw.Draw(split_panel, "RGBA")
    font = load_font(max(11, int(15 * min(1.0, scale))), bold=True)
    thin = max(2, int(round(3 / max(scale, 0.25))))
    thick = max(2, int(round(4 / max(scale, 0.25))))
    if mode in {"dialogue", "combined"}:
        for bubble in page["bubbles"]:
            raw_box = base.transformed_box(bubble["bbox"], scale)
            draw_labeled_box(
                raw_draw,
                raw_box,
                f"{bubble['bubbleId']} · {len(bubble['textIds'])}T",
                (6, 182, 212, 255),
                font,
                thin,
                dashed=True,
            )
            for instance in bubble["finalInstances"]:
                box = base.transformed_box(instance["bbox"], scale)
                draw_labeled_box(
                    split_draw,
                    box,
                    f"{instance['outputId']}·D",
                    (34, 197, 94, 255),
                    font,
                    thick,
                )
        for text_region in page.get("uncontainedTextRegions", []):
            raw_box = base.transformed_box(
                text_region.get("sourceBbox", text_region["bbox"]), scale
            )
            draw_labeled_box(
                raw_draw,
                raw_box,
                f"{text_region['sourceDetectionId']}·T",
                (37, 99, 235, 255),
                font,
                thin,
                dashed=True,
            )
            box = base.transformed_box(text_region["bbox"], scale)
            draw_labeled_box(
                split_draw,
                box,
                f"{text_region['outputId']}·D",
                (37, 99, 235, 255),
                font,
                thick,
            )
    if mode in {"effects", "combined"}:
        for effect in page.get("onomatopoeiaRegions", []):
            source_ids = list(effect.get("sourceDetectionIds", []))
            source_boxes = list(effect.get("sourceBboxes", []))
            for source_index, source_box in enumerate(source_boxes):
                label = (
                    source_ids[source_index]
                    if source_index < len(source_ids)
                    else f"S{source_index + 1:02d}"
                )
                draw_labeled_box(
                    raw_draw,
                    base.transformed_box(source_box, scale),
                    f"{label}·FX",
                    (219, 39, 119, 255),
                    font,
                    thin,
                    dashed=True,
                )
            box = base.transformed_box(effect["bbox"], scale)
            draw_labeled_box(
                split_draw,
                box,
                f"{effect['outputId']}·{effect.get('groupedFromCount', 1)}",
                (219, 39, 119, 255),
                font,
                thick,
            )
    panels = [source.convert("RGBA"), raw_panel, split_panel]
    if mode == "dialogue":
        headers = [
            ("A · 원문", "전체 페이지 · 선별/패널 크롭 없음"),
            ("B · Koharu 일반 텍스트", "청록=말풍선 · 파랑=말풍선 밖 텍스트"),
            (
                "C · 최종 일반 텍스트",
                "D 번호 · 보수적 분리 · 효과음과 독립 · Paddle 기하 미사용",
            ),
        ]
    elif mode == "effects":
        headers = [
            ("A · 원문", "전체 페이지 · 선별/패널 크롭 없음"),
            ("B · Koharu 효과음 조각", "자홍 점선=검출기가 낸 원본 조각"),
            (
                "C · 최종 효과음 그룹",
                "FX 번호 · 인접 글자 조각 묶음 · 일반 텍스트와 독립",
            ),
        ]
    else:
        headers = [
            ("A · 원문", "전체 페이지 · 선별/패널 크롭 없음"),
            ("B · Koharu 원본", "청록/파랑=일반 텍스트 · 자홍=효과음 조각"),
            (
                "C · 최종 독립 출력",
                "D=일반 텍스트 · FX=효과음 · 서로 박스를 깎지 않음",
            ),
        ]
    header_height = 104
    gap = 18
    margin = 20
    canvas_width = margin * 2 + len(panels) * display_size[0] + gap * (len(panels) - 1)
    canvas_height = margin * 2 + header_height + display_size[1]
    canvas = Image.new("RGBA", (canvas_width, canvas_height), (248, 250, 252, 255))
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(24, bold=True)
    subtitle_font = load_font(17)
    for index, (panel, (title, subtitle)) in enumerate(zip(panels, headers)):
        x = margin + index * (display_size[0] + gap)
        draw.rounded_rectangle(
            (x, margin, x + display_size[0], margin + header_height - 8),
            radius=8,
            fill=(255, 255, 255, 255),
        )
        draw.text((x + 14, margin + 13), title, fill=(15, 23, 42, 255), font=title_font)
        draw.text((x + 14, margin + 56), subtitle, fill=(71, 85, 105, 255), font=subtitle_font)
        canvas.alpha_composite(panel, (x, margin + header_height))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, quality=94)


def render_candidates(args: argparse.Namespace) -> None:
    input_dir = Path(args.input_dir).resolve()
    page_paths = sorted((input_dir / "pages").glob("P*.json"), key=lambda path: base.natural_key(path.stem))
    if not page_paths:
        raise base.EvaluationError(f"no cached page reports under {input_dir / 'pages'}")
    output_dir = Path(args.output_dir).resolve()
    manifest: list[dict[str, str]] = []
    for index, page_path in enumerate(page_paths, 1):
        page = base.read_json(page_path)
        output_path = output_dir / f"{index:03d}-{page['pageId']}-{args.mode}.png"
        render_candidate_page(page, output_path, args.mode)
        manifest.append(
            {
                "pageId": str(page["pageId"]),
                "relativePath": str(page["relativePath"]),
                "image": output_path.name,
            }
        )
        print(f"[render-candidates] {index}/{len(page_paths)} {output_path.name}", flush=True)
    base.write_json(
        output_dir / "manifest.json",
        {"schemaVersion": SCHEMA_VERSION, "mode": args.mode, "items": manifest},
    )
    title = "일반 텍스트 180장 전체" if args.mode == "dialogue" else "효과음 180장 전체"
    cards = "\n".join(
        (
            f'<article id="{html.escape(item["pageId"])}">'
            f'<h2>{index:03d} · {html.escape(item["pageId"])}</h2>'
            f'<p>{html.escape(item["relativePath"])}</p>'
            f'<a href="{html.escape(item["image"])}">'
            f'<img loading="lazy" src="{html.escape(item["image"])}" '
            f'alt="{html.escape(item["pageId"])} A/B/C 전체 페이지"></a>'
            "</article>"
        )
        for index, item in enumerate(manifest, 1)
    )
    gallery = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>
body{{margin:0;background:#171717;color:#f8fafc;font-family:system-ui,sans-serif}}
header{{position:sticky;top:0;z-index:2;padding:14px 22px;background:#111e;border-bottom:1px solid #334155}}
header h1{{margin:0;font-size:22px}} header p{{margin:5px 0 0;color:#cbd5e1}}
main{{max-width:2200px;margin:auto;padding:18px}} article{{margin:0 0 26px;padding:14px;background:#202020;border-radius:12px}}
h2{{margin:0 0 5px;font-size:19px}} article p{{margin:0 0 12px;color:#94a3b8;overflow-wrap:anywhere}}
img{{display:block;width:100%;height:auto;background:white;border-radius:7px}}
</style></head><body><header><h1>{title}</h1><p>A=원문 · B=Koharu 원검출 · C=최종 · 선별/패널 크롭 없음 · 총 {len(manifest)}장</p></header>
<main>{cards}</main></body></html>
"""
    (output_dir / "index.html").write_text(gallery, encoding="utf-8")


def page_output_regions(page: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Flatten every final OCR rectangle on one page for invariant checks."""

    regions: list[dict[str, Any]] = []
    for bubble in page.get("bubbles", []):
        for instance in bubble.get("finalInstances", []):
            regions.append(
                {
                    "id": str(instance.get("outputId", "")),
                    "kind": "bubble-text",
                    "namespace": "dialogue",
                    "source": f"{bubble.get('bubbleId', '?')}/{instance.get('instanceId', '?')}",
                    "bbox": instance.get("bbox"),
                    "record": instance,
                }
            )
    for key, kind in (
        ("uncontainedTextRegions", "uncontained-text"),
        ("onomatopoeiaRegions", "onomatopoeia"),
    ):
        for region in page.get(key, []):
            regions.append(
                {
                    "id": str(region.get("outputId", "")),
                    "kind": kind,
                    "namespace": (
                        "effects" if kind == "onomatopoeia" else "dialogue"
                    ),
                    "source": str(region.get("regionId", "?")),
                    "bbox": region.get("bbox"),
                    "record": region,
                }
            )
    return regions


def verify_page_report(page: Mapping[str, Any], source: Path) -> list[str]:
    """Return every structural or geometry failure found in one cached page."""

    page_id = str(page.get("pageId", source.stem))
    prefix = f"{page_id} ({source.name})"
    errors: list[str] = []
    if page.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(
            f"{prefix}: schemaVersion={page.get('schemaVersion')!r}, expected {SCHEMA_VERSION!r}"
        )
    if page_id != source.stem:
        errors.append(f"{prefix}: pageId does not match the file name")

    for bubble in page.get("bubbles", []):
        final_instances = list(bubble.get("finalInstances", []))
        if int(bubble.get("finalInstanceCount", -1)) != len(final_instances):
            errors.append(
                f"{prefix}: {bubble.get('bubbleId')} finalInstanceCount does not match its records"
            )
        for rectification in bubble.get("instanceOverlapRectifications", []):
            if rectification.get("strategy") != "zero-ink-whitespace-seam":
                errors.append(
                    f"{prefix}: {bubble.get('bubbleId')} used a non-glyph-safe instance seam"
                )
            if int(rectification.get("protectedPixelLoss", -1)) != 0:
                errors.append(
                    f"{prefix}: {bubble.get('bubbleId')} instance seam lost protected pixels"
                )

    for rectification in page.get("dialogueOverlapRectifications", []):
        if rectification.get("strategy") != "zero-ink-whitespace-seam":
            errors.append(f"{prefix}: page dialogue used a non-glyph-safe seam")
        if int(rectification.get("protectedPixelLoss", -1)) != 0:
            errors.append(f"{prefix}: page dialogue seam lost protected pixels")

    for effect in page.get("onomatopoeiaRegions", []):
        panel_ids = list(effect.get("panelDetectionIds", []))
        if len(panel_ids) > 1:
            errors.append(
                f"{prefix}: {effect.get('outputId')} crosses panel detections {panel_ids}"
            )

    width = float(page.get("width", 0))
    height = float(page.get("height", 0))
    if width <= 0 or height <= 0:
        errors.append(f"{prefix}: invalid page dimensions {width}x{height}")
    regions = page_output_regions(page)
    output_ids = [region["id"] for region in regions]
    if len(output_ids) != len(set(output_ids)):
        duplicates = sorted(
            output_id for output_id in set(output_ids) if output_ids.count(output_id) > 1
        )
        errors.append(f"{prefix}: duplicate output IDs {duplicates}")
    dialogue_ids = sorted(
        region["id"] for region in regions if region["namespace"] == "dialogue"
    )
    effect_ids = sorted(
        region["id"] for region in regions if region["namespace"] == "effects"
    )
    expected_dialogue_ids = [
        f"D{index:03d}" for index in range(1, len(dialogue_ids) + 1)
    ]
    expected_effect_ids = [
        f"FX{index:03d}" for index in range(1, len(effect_ids) + 1)
    ]
    if dialogue_ids != expected_dialogue_ids:
        errors.append(
            f"{prefix}: dialogue IDs are not one contiguous D001..D{len(dialogue_ids):03d} sequence"
        )
    if effect_ids != expected_effect_ids:
        errors.append(
            f"{prefix}: effect IDs are not one contiguous FX001..FX{len(effect_ids):03d} sequence"
        )

    valid_regions: list[dict[str, Any]] = []
    for region in regions:
        record = region["record"]
        if record.get("outputKind") != region["kind"]:
            errors.append(
                f"{prefix}: {region['id']} outputKind={record.get('outputKind')!r}, expected {region['kind']!r}"
            )
        box = region["bbox"]
        if not isinstance(box, Sequence) or isinstance(box, (str, bytes)) or len(box) != 4:
            errors.append(f"{prefix}: {region['id']} has malformed bbox {box!r}")
            continue
        try:
            numeric_box = [float(value) for value in box]
        except (TypeError, ValueError):
            errors.append(f"{prefix}: {region['id']} has non-numeric bbox {box!r}")
            continue
        if base.bbox_area(numeric_box) <= 0:
            errors.append(f"{prefix}: {region['id']} has an empty bbox {numeric_box}")
            continue
        if (
            numeric_box[0] < 0
            or numeric_box[1] < 0
            or numeric_box[2] > width
            or numeric_box[3] > height
        ):
            errors.append(
                f"{prefix}: {region['id']} bbox escapes {width}x{height}: {numeric_box}"
            )
        valid_regions.append({**region, "bbox": numeric_box})

    for first_index, first in enumerate(valid_regions):
        for second in valid_regions[first_index + 1 :]:
            if first["namespace"] != second["namespace"]:
                continue
            intersection = base.bbox_intersection(first["bbox"], second["bbox"])
            if intersection > 0:
                errors.append(
                    f"{prefix}: {first['id']} and {second['id']} overlap by {intersection:.3f}px²"
                )
    return errors


def regression_expectations(page_by_id: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """Lock the user-reported dialogue failures and required plain-text recall."""

    errors: list[str] = []

    def page(page_id: str) -> Mapping[str, Any] | None:
        value = page_by_id.get(page_id)
        if value is None:
            errors.append(f"missing required regression page {page_id}")
        return value

    def bubble_final_count(page_id: str, bubble_id: str, expected: int) -> None:
        value = page(page_id)
        if value is None:
            return
        match = next(
            (
                bubble
                for bubble in value.get("bubbles", [])
                if str(bubble.get("bubbleId")) == bubble_id
            ),
            None,
        )
        if match is None:
            errors.append(f"{page_id}: missing regression bubble {bubble_id}")
        elif int(match.get("finalInstanceCount", -1)) != expected:
            errors.append(
                f"{page_id}/{bubble_id}: finalInstanceCount={match.get('finalInstanceCount')}, expected {expected}"
            )

    def effect_count(page_id: str, expected: int) -> None:
        value = page(page_id)
        if value is None:
            return
        actual = len(value.get("onomatopoeiaRegions", []))
        if actual != expected:
            errors.append(f"{page_id}: effect count={actual}, expected {expected}")

    def effect_rejection(
        page_id: str,
        detection_id: str,
        reason: str,
    ) -> None:
        value = page(page_id)
        if value is None:
            return
        if not any(
            str(item.get("sourceDetectionId")) == detection_id
            and str(item.get("reason")) == reason
            for item in value.get("rejectedOnomatopoeiaProposals", [])
        ):
            errors.append(
                f"{page_id}: missing {detection_id} effect rejection {reason!r}"
            )

    p001 = page("P001")
    if p001 is not None and len(p001.get("onomatopoeiaRegions", [])) != 0:
        errors.append("P001: duplicate text/FX proposal returned")
    bubble_final_count("P002", "K003", 3)
    p003 = page("P003")
    if p003 is not None and len(p003.get("uncontainedTextRegions", [])) < 3:
        errors.append("P003: rooftop/plain-text regions are missing")
    p019 = page("P019")
    if p019 is not None:
        if len(p019.get("uncontainedTextRegions", [])) < 1:
            errors.append("P019: black-background narration is missing")
        if len(p019.get("onomatopoeiaRegions", [])) != 0:
            errors.append("P019: duplicate text/FX proposal returned")
    bubble_final_count("P052", "K002", 2)
    bubble_final_count("P052", "K005", 2)
    bubble_final_count("P055", "K002", 2)
    bubble_final_count("P045", "K003", 2)
    effect_count("P044", 2)
    p086 = page("P086")
    if p086 is not None:
        bubble_final_count("P086", "K003", 2)
        bubble_final_count("P086", "K005", 2)
        if len(p086.get("uncontainedTextRegions", [])) != 1:
            errors.append("P086: expected exactly one uncontained-text region")
    bubble_final_count("P097", "K012", 1)
    effect_count("P072", 2)
    effect_count("P104", 0)
    effect_rejection("P104", "K017", "oversized-sparse-graphic")
    effect_count("P142", 1)
    effect_rejection("P142", "K018", "oversized-sparse-graphic")
    bubble_final_count("P106", "K009", 2)
    bubble_final_count("P110", "K001", 2)
    bubble_final_count("P110", "K017", 1)
    bubble_final_count("P122", "K001", 2)
    bubble_final_count("P135", "K002", 2)
    bubble_final_count("P175", "K002", 2)
    bubble_final_count("P173", "K018", 1)
    effect_count("P166", 3)
    effect_rejection(
        "P166", "K030", "contains-multiple-general-text-regions"
    )
    effect_count("P174", 3)
    effect_rejection(
        "P174", "K019", "contains-multiple-general-text-regions"
    )
    p168 = page("P168")
    if p168 is not None:
        if any(
            "K036" in region.get("sourceDetectionIds", [])
            for region in p168.get("onomatopoeiaRegions", [])
        ):
            errors.append("P168: general text K036 leaked into the effect output")
        if not any(
            str(rejection.get("sourceDetectionId")) == "K036"
            and str(rejection.get("reason")) == "contained-by-general-text"
            for rejection in p168.get("rejectedOnomatopoeiaProposals", [])
        ):
            errors.append("P168: expected text-priority rejection for effect K036")
    p097 = page("P097")
    if p097 is not None and len(p097.get("uncontainedTextRegions", [])) < 1:
        errors.append("P097: outside plain-text region is missing")
    return errors


def verify_regressions(args: argparse.Namespace) -> None:
    input_dir = Path(args.input_dir).resolve()
    page_paths = sorted(
        (input_dir / "pages").glob("P*.json"),
        key=lambda path: base.natural_key(path.stem),
    )
    if not page_paths:
        raise base.EvaluationError(
            f"no cached page reports under {input_dir / 'pages'}"
        )
    if args.expected_page_count is not None and len(page_paths) != args.expected_page_count:
        raise base.EvaluationError(
            f"page count={len(page_paths)}, expected {args.expected_page_count}"
        )

    pages = [base.read_json(path) for path in page_paths]
    page_by_id = {str(page.get("pageId")): page for page in pages}
    errors: list[str] = []
    for path, page in zip(page_paths, pages):
        errors.extend(verify_page_report(page, path))
    errors.extend(regression_expectations(page_by_id))

    aggregate = {
        "pageCount": len(pages),
        "finalInstanceCount": sum(
            int(bubble.get("finalInstanceCount", 0))
            for page in pages
            for bubble in page.get("bubbles", [])
        ),
        "bubbleInstanceOverlapRectificationCount": sum(
            len(bubble.get("instanceOverlapRectifications", []))
            for page in pages
            for bubble in page.get("bubbles", [])
        ),
        "bubbleLosslessRectangleMergeCount": sum(
            len(bubble.get("losslessRectangleMerges", []))
            for page in pages
            for bubble in page.get("bubbles", [])
        ),
        "onomatopoeiaRegionCount": sum(
            len(page.get("onomatopoeiaRegions", [])) for page in pages
        ),
        "rejectedOnomatopoeiaProposalCount": sum(
            len(page.get("rejectedOnomatopoeiaProposals", [])) for page in pages
        ),
        "uncontainedTextRegionCount": sum(
            len(page.get("uncontainedTextRegions", [])) for page in pages
        ),
        "dialogueOverlapRectificationCount": sum(
            len(page.get("dialogueOverlapRectifications", [])) for page in pages
        ),
        "effectOverlapRectificationCount": sum(
            len(page.get("effectOverlapRectifications", [])) for page in pages
        ),
    }
    summary_path = input_dir / "summary.json"
    if not summary_path.is_file():
        errors.append(f"missing summary file {summary_path}")
    else:
        summary = base.read_json(summary_path)
        if summary.get("schemaVersion") != SCHEMA_VERSION:
            errors.append("summary schemaVersion does not match the evaluator")
        for key, value in aggregate.items():
            if int(summary.get(key, -1)) != value:
                errors.append(
                    f"summary {key}={summary.get(key)!r}, recomputed {value}"
                )

    if errors:
        preview = "\n".join(f"- {error}" for error in errors[:50])
        remainder = "" if len(errors) <= 50 else f"\n- ... {len(errors) - 50} more"
        raise base.EvaluationError(
            f"regression verification failed with {len(errors)} issue(s):\n{preview}{remainder}"
        )
    print(
        json.dumps(
            {
                "schemaVersion": SCHEMA_VERSION,
                "status": "passed",
                "regressionPages": [
                    "P001",
                    "P002",
                    "P003",
                    "P019",
                    "P044",
                    "P045",
                    "P052",
                    "P055",
                    "P072",
                    "P086",
                    "P097",
                    "P104",
                    "P106",
                    "P110",
                    "P122",
                    "P135",
                    "P142",
                    "P166",
                    "P168",
                    "P173",
                    "P174",
                    "P175",
                ],
                **aggregate,
                "invalidBoxCount": 0,
                "duplicateOutputIdCount": 0,
                "overlappingPairCount": 0,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def paddle_item_bbox(item: Mapping[str, Any]) -> list[float]:
    return [
        float(item["x1"]),
        float(item["y1"]),
        float(item["x2"]),
        float(item["y2"]),
    ]


def point_in_bbox(x: float, y: float, box: Sequence[float]) -> bool:
    return float(box[0]) <= x <= float(box[2]) and float(box[1]) <= y <= float(
        box[3]
    )


def audit_paddle_coverage(args: argparse.Namespace) -> None:
    """Use reviewed Paddle lines only as a QA oracle, never as C geometry."""

    input_dir = Path(args.input_dir).resolve()
    paddle_dir = Path(args.paddle_dir).resolve()
    page_paths = sorted(
        (input_dir / "pages").glob("P*.json"),
        key=lambda path: base.natural_key(path.stem),
    )
    if not page_paths:
        raise base.EvaluationError(
            f"no cached page reports under {input_dir / 'pages'}"
        )

    missing_groups: list[dict[str, Any]] = []
    split_groups: list[dict[str, Any]] = []
    cross_group_regions: list[dict[str, Any]] = []
    merged_dialogue_regions: list[dict[str, Any]] = []
    close_effect_pairs: list[dict[str, Any]] = []
    audited_item_count = 0
    audited_group_count = 0
    fully_unmatched_item_count = 0
    page_summaries: list[dict[str, Any]] = []

    for page_path in page_paths:
        page = base.read_json(page_path)
        page_id = str(page["pageId"])
        paddle_path = paddle_dir / f"{page_id}.json"
        if not paddle_path.is_file():
            raise base.EvaluationError(f"missing Paddle QA record {paddle_path}")
        paddle = base.read_json(paddle_path)
        regions = page_output_regions(page)
        region_by_id = {str(region["id"]): region for region in regions}
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        matched_groups_by_output: dict[str, set[str]] = defaultdict(set)

        for item in paddle.get("items", []):
            if float(item.get("score", 0.0)) < args.min_score:
                continue
            if (
                not args.include_unreviewed
                and item.get("reviewStatus") not in (None, "confirmed")
            ):
                continue
            text = str(item.get("ocrText", "")).strip()
            if not text:
                continue
            box = paddle_item_bbox(item)
            area = base.bbox_area(box)
            if area <= 0:
                continue
            center_x = (box[0] + box[2]) / 2.0
            center_y = (box[1] + box[3]) / 2.0
            matches: list[dict[str, Any]] = []
            total_intersection = 0.0
            for region in regions:
                intersection = base.bbox_intersection(box, region["bbox"])
                coverage = intersection / area
                centered = point_in_bbox(
                    center_x, center_y, region["bbox"]
                )
                if coverage >= args.match_coverage or centered:
                    matches.append(
                        {
                            "outputId": region["id"],
                            "kind": region["kind"],
                            "coverage": round(coverage, 6),
                            "centered": centered,
                        }
                    )
                total_intersection += intersection
            coverage = min(1.0, total_intersection / area)
            covered = coverage >= args.item_coverage or any(
                match["centered"] for match in matches
            )
            group_id = str(
                item.get("groupId")
                or item.get("paddleGroupId")
                or f"item-{item.get('id', audited_item_count + 1)}"
            )
            item_record = {
                "id": item.get("id"),
                "text": text,
                "score": round(float(item.get("score", 0.0)), 6),
                "bbox": box,
                "area": area,
                "coverage": round(coverage, 6),
                "covered": covered,
                "matches": matches,
            }
            groups[group_id].append(item_record)
            audited_item_count += 1
            if not matches:
                fully_unmatched_item_count += 1
            for match in matches:
                matched_groups_by_output[str(match["outputId"])].add(group_id)

        page_missing_count = 0
        page_split_count = 0
        for group_id, items in sorted(groups.items(), key=lambda value: base.natural_key(value[0])):
            audited_group_count += 1
            total_area = sum(float(item["area"]) for item in items)
            weighted_coverage = sum(
                float(item["coverage"]) * float(item["area"]) for item in items
            ) / max(1.0, total_area)
            output_ids = sorted(
                {
                    str(match["outputId"])
                    for item in items
                    for match in item["matches"]
                },
                key=base.natural_key,
            )
            text_output_ids = [
                output_id
                for output_id in output_ids
                if region_by_id[output_id]["kind"]
                in ("bubble-text", "uncontained-text")
            ]
            uncovered_items = [item for item in items if not item["covered"]]
            group_box = base.union_bbox([item["bbox"] for item in items])
            group_record = {
                "pageId": page_id,
                "groupId": group_id,
                "bbox": group_box,
                "text": "\n".join(str(item["text"]) for item in items),
                "itemCount": len(items),
                "weightedCoverage": round(weighted_coverage, 6),
                "minimumItemCoverage": round(
                    min(float(item["coverage"]) for item in items), 6
                ),
                "outputIds": output_ids,
                "textOutputIds": text_output_ids,
                "uncoveredItems": uncovered_items,
                "relativePath": str(page.get("relativePath", "")),
            }
            if (
                not output_ids
                or weighted_coverage < args.group_coverage
                or uncovered_items
            ):
                group_record["severity"] = round(
                    (1.0 - weighted_coverage)
                    * max(float(item["score"]) for item in items)
                    * max(1.0, total_area) ** 0.5,
                    3,
                )
                missing_groups.append(group_record)
                page_missing_count += 1
            if len(text_output_ids) > 1:
                split_groups.append(group_record)
                page_split_count += 1

        for output_id, group_ids in matched_groups_by_output.items():
            region = region_by_id[output_id]
            if (
                region["kind"] in ("bubble-text", "uncontained-text")
                and len(group_ids) > 1
            ):
                cross_group_regions.append(
                    {
                        "pageId": page_id,
                        "outputId": output_id,
                        "kind": region["kind"],
                        "bbox": region["bbox"],
                        "groupIds": sorted(group_ids, key=base.natural_key),
                        "relativePath": str(page.get("relativePath", "")),
                    }
                )

        for bubble in page.get("bubbles", []):
            for instance in bubble.get("finalInstances", []):
                if len(instance.get("textIds", [])) > 1:
                    merged_dialogue_regions.append(
                        {
                            "pageId": page_id,
                            "bubbleId": str(bubble.get("bubbleId")),
                            "outputId": str(instance.get("outputId")),
                            "bbox": instance.get("bbox"),
                            "textIds": list(instance.get("textIds", [])),
                            "candidateIds": list(instance.get("candidateIds", [])),
                            "relativePath": str(page.get("relativePath", "")),
                        }
                    )

        effects = [
            region for region in regions if region["kind"] == "onomatopoeia"
        ]
        for first_index, first in enumerate(effects):
            first_box = first["bbox"]
            first_width = max(1.0, float(first_box[2]) - float(first_box[0]))
            first_height = max(1.0, float(first_box[3]) - float(first_box[1]))
            for second in effects[first_index + 1 :]:
                second_box = second["bbox"]
                second_width = max(
                    1.0, float(second_box[2]) - float(second_box[0])
                )
                second_height = max(
                    1.0, float(second_box[3]) - float(second_box[1])
                )
                horizontal_gap = max(
                    0.0,
                    max(float(first_box[0]), float(second_box[0]))
                    - min(float(first_box[2]), float(second_box[2])),
                )
                vertical_gap = max(
                    0.0,
                    max(float(first_box[1]), float(second_box[1]))
                    - min(float(first_box[3]), float(second_box[3])),
                )
                horizontal_overlap = max(
                    0.0,
                    min(float(first_box[2]), float(second_box[2]))
                    - max(float(first_box[0]), float(second_box[0])),
                ) / min(first_width, second_width)
                vertical_overlap = max(
                    0.0,
                    min(float(first_box[3]), float(second_box[3]))
                    - max(float(first_box[1]), float(second_box[1])),
                ) / min(first_height, second_height)
                close_along_x = (
                    horizontal_gap <= args.effect_gap
                    and vertical_overlap >= args.effect_axis_overlap
                )
                close_along_y = (
                    vertical_gap <= args.effect_gap
                    and horizontal_overlap >= args.effect_axis_overlap
                )
                if close_along_x or close_along_y:
                    close_effect_pairs.append(
                        {
                            "pageId": page_id,
                            "outputIds": [first["id"], second["id"]],
                            "bboxes": [first_box, second_box],
                            "horizontalGap": round(horizontal_gap, 3),
                            "verticalGap": round(vertical_gap, 3),
                            "horizontalOverlap": round(horizontal_overlap, 6),
                            "verticalOverlap": round(vertical_overlap, 6),
                            "relativePath": str(page.get("relativePath", "")),
                        }
                    )

        page_summaries.append(
            {
                "pageId": page_id,
                "paddleGroupCount": len(groups),
                "missingGroupCount": page_missing_count,
                "splitGroupCount": page_split_count,
                "relativePath": str(page.get("relativePath", "")),
            }
        )

    missing_groups.sort(
        key=lambda value: (-float(value["severity"]), base.natural_key(value["pageId"]))
    )
    result = {
        "schemaVersion": "koharu-bubble-instance-paddle-qa-audit-v1",
        "note": "Paddle rectangles are QA evidence only and never modify final C geometry.",
        "settings": {
            "minScore": args.min_score,
            "matchCoverage": args.match_coverage,
            "itemCoverage": args.item_coverage,
            "groupCoverage": args.group_coverage,
            "effectGap": args.effect_gap,
            "effectAxisOverlap": args.effect_axis_overlap,
            "includeUnreviewed": args.include_unreviewed,
        },
        "summary": {
            "pageCount": len(page_paths),
            "auditedItemCount": audited_item_count,
            "auditedGroupCount": audited_group_count,
            "fullyUnmatchedItemCount": fully_unmatched_item_count,
            "missingOrPartialGroupCount": len(missing_groups),
            "splitGroupCandidateCount": len(split_groups),
            "crossGroupRegionCandidateCount": len(cross_group_regions),
            "mergedDialogueRegionCount": len(merged_dialogue_regions),
            "closeEffectPairCandidateCount": len(close_effect_pairs),
        },
        "missingOrPartialGroups": missing_groups,
        "splitGroupCandidates": split_groups,
        "crossGroupRegionCandidates": cross_group_regions,
        "mergedDialogueRegions": merged_dialogue_regions,
        "closeEffectPairCandidates": close_effect_pairs,
        "pages": page_summaries,
    }
    output_path = Path(args.output).resolve()
    base.write_json(output_path, result)
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--record", required=True)
    inspect_parser.add_argument("--output-dir", required=True)
    inspect_parser.add_argument("--bubble-id")
    batch_parser = subparsers.add_parser("batch")
    batch_parser.add_argument("--results-dir", required=True)
    batch_parser.add_argument("--output-dir", required=True)
    batch_parser.add_argument("--force", action="store_true")
    batch_parser.add_argument("--page-id", action="append")
    render_parser = subparsers.add_parser("render-candidates")
    render_parser.add_argument("--input-dir", required=True)
    render_parser.add_argument("--output-dir", required=True)
    render_parser.add_argument(
        "--mode",
        choices=("dialogue", "effects", "combined"),
        default="combined",
    )
    verify_parser = subparsers.add_parser("verify-regressions")
    verify_parser.add_argument("--input-dir", required=True)
    verify_parser.add_argument("--expected-page-count", type=int)
    audit_parser = subparsers.add_parser("audit-paddle-coverage")
    audit_parser.add_argument("--input-dir", required=True)
    audit_parser.add_argument("--paddle-dir", required=True)
    audit_parser.add_argument("--output", required=True)
    audit_parser.add_argument("--min-score", type=float, default=0.80)
    audit_parser.add_argument("--match-coverage", type=float, default=0.10)
    audit_parser.add_argument("--item-coverage", type=float, default=0.35)
    audit_parser.add_argument("--group-coverage", type=float, default=0.50)
    audit_parser.add_argument("--effect-gap", type=float, default=10.0)
    audit_parser.add_argument("--effect-axis-overlap", type=float, default=0.55)
    audit_parser.add_argument("--include-unreviewed", action="store_true")
    return parser


if __name__ == "__main__":
    try:
        arguments = build_parser().parse_args()
        if arguments.command == "inspect":
            inspect(arguments)
        elif arguments.command == "batch":
            batch(arguments)
        elif arguments.command == "render-candidates":
            render_candidates(arguments)
        elif arguments.command == "verify-regressions":
            verify_regressions(arguments)
        elif arguments.command == "audit-paddle-coverage":
            audit_paddle_coverage(arguments)
    except base.EvaluationError as error:
        print(f"[koharu-bubble-split] {error}")
        raise SystemExit(2) from error
