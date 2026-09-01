#!/usr/bin/env python3
"""Build translation rectangles from Koharu layout masks without Paddle geometry.

PaddleOCR is loaded only to draw panel B and to rank useful comparison pages.
Panel C is derived exclusively from Koharu text/onomatopoeia masks partitioned
by Koharu bubble and panel masks.
"""

from __future__ import annotations

import argparse
import math
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps

import evaluate_koharu_region_boxes as base


SCHEMA_VERSION = "koharu-only-layout-evaluation-v1"
MIN_CONTAINER_PIECE_FRACTION = 0.035
MIN_COMPARISON_OVERLAP = 0.25
MIN_COMPARISON_COVERAGE = 0.45
MIN_PADDLE_FRAGMENTS = 8
DEFAULT_CANDIDATES = 36
DEFAULT_REPRESENTATIVES = 20


def minimum_piece_area(total_area: int) -> int:
    return max(4, min(32, int(math.ceil(total_area * 0.02))))


def make_containers(detections: Sequence[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    bubbles: list[dict[str, Any]] = []
    panels: list[dict[str, Any]] = []
    for detection in detections:
        if detection["class"] == "bubble":
            for component_index, mask in enumerate(
                base.split_disconnected_bubble(detection["mask"])
            ):
                box = base.mask_bbox(mask)
                if box is None:
                    continue
                bubbles.append(
                    {
                        "id": f"{detection['id']}:bubble:{component_index + 1}",
                        "class": "bubble",
                        "sourceDetectionId": detection["id"],
                        "score": float(detection["score"]),
                        "bbox": box,
                        "mask": mask,
                        "maskArea": int(np.count_nonzero(mask)),
                    }
                )
        elif detection["class"] == "panel":
            panels.append(
                {
                    "id": f"{detection['id']}:panel",
                    "class": "panel",
                    "sourceDetectionId": detection["id"],
                    "score": float(detection["score"]),
                    "bbox": list(detection["bbox"]),
                    "mask": detection["mask"],
                    "maskArea": int(detection["maskArea"]),
                }
            )
    return bubbles, panels


def claim_container_pieces(
    remaining: np.ndarray,
    source_mask: np.ndarray,
    containers: Sequence[Mapping[str, Any]],
) -> tuple[list[tuple[np.ndarray, Mapping[str, Any]]], np.ndarray]:
    total_area = int(np.count_nonzero(source_mask))
    minimum_area = minimum_piece_area(total_area)
    ranked: list[tuple[float, float, float, Mapping[str, Any]]] = []
    for container in containers:
        area = int(np.count_nonzero(np.logical_and(source_mask, container["mask"])))
        if area < minimum_area or area / max(1, total_area) < MIN_CONTAINER_PIECE_FRACTION:
            continue
        ranked.append(
            (
                area / max(1, total_area),
                float(container["score"]),
                -float(container["maskArea"]),
                container,
            )
        )
    ranked.sort(key=lambda value: value[:3], reverse=True)

    pieces: list[tuple[np.ndarray, Mapping[str, Any]]] = []
    for _, _, _, container in ranked:
        piece = np.logical_and(remaining, container["mask"])
        piece_area = int(np.count_nonzero(piece))
        if (
            piece_area < minimum_area
            or piece_area / max(1, total_area) < MIN_CONTAINER_PIECE_FRACTION
        ):
            continue
        pieces.append((piece, container))
        remaining = np.logical_and(remaining, np.logical_not(container["mask"]))
    return pieces, remaining


def make_block(
    detection: Mapping[str, Any],
    piece_mask: np.ndarray,
    container: Mapping[str, Any] | None,
    width: int,
    height: int,
) -> dict[str, Any] | None:
    raw_box = base.mask_bbox(piece_mask)
    if raw_box is None:
        return None
    piece_area = int(np.count_nonzero(piece_mask))
    source_area = max(1, int(detection["maskArea"]))
    return {
        "id": "",
        "kind": str(detection["class"]),
        "bbox": base.padded_bbox(raw_box, width, height),
        "rawMaskBbox": raw_box,
        "sourceDetectionId": str(detection["id"]),
        "sourceDetectionScore": float(detection["score"]),
        "sourceMaskArea": source_area,
        "pieceMaskArea": piece_area,
        "sourceMaskFraction": round(piece_area / source_area, 6),
        "containerClass": str(container["class"]) if container else "uncontained",
        "containerId": str(container["id"]) if container else None,
        "containerDetectionId": str(container["sourceDetectionId"]) if container else None,
    }


def deduplicate_blocks(blocks: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(
        blocks,
        key=lambda block: (
            float(block["sourceDetectionScore"]),
            float(block["pieceMaskArea"]),
        ),
        reverse=True,
    )
    kept: list[dict[str, Any]] = []
    for block in ranked:
        duplicate = any(
            block["kind"] == existing["kind"]
            and block["containerId"] == existing["containerId"]
            and base.bbox_iou(block["bbox"], existing["bbox"]) >= 0.90
            for existing in kept
        )
        if not duplicate:
            kept.append(block)
    kept.sort(
        key=lambda block: (
            float(block["bbox"][1]),
            -float(block["bbox"][0]),
            str(block["kind"]),
        )
    )
    for index, block in enumerate(kept, 1):
        block["id"] = f"C{index:03d}"
    return kept


def build_koharu_only_blocks(
    detections: Sequence[Mapping[str, Any]], width: int, height: int
) -> list[dict[str, Any]]:
    bubbles, panels = make_containers(detections)
    blocks: list[dict[str, Any]] = []
    for detection in detections:
        if detection["class"] not in {"text", "onomatopoeia"}:
            continue
        source_mask = np.asarray(detection["mask"], dtype=bool)
        remaining = source_mask.copy()
        claimed: list[tuple[np.ndarray, Mapping[str, Any]]] = []
        if detection["class"] == "text":
            bubble_pieces, remaining = claim_container_pieces(
                remaining, source_mask, bubbles
            )
            claimed.extend(bubble_pieces)
        panel_pieces, remaining = claim_container_pieces(
            remaining, source_mask, panels
        )
        claimed.extend(panel_pieces)

        for piece_mask, container in claimed:
            block = make_block(detection, piece_mask, container, width, height)
            if block is not None:
                blocks.append(block)
        if int(np.count_nonzero(remaining)) >= minimum_piece_area(
            int(detection["maskArea"])
        ):
            block = make_block(detection, remaining, None, width, height)
            if block is not None:
                blocks.append(block)
    return deduplicate_blocks(blocks)


def center_in_bbox(subject: Sequence[float], container: Sequence[float]) -> bool:
    x = (float(subject[0]) + float(subject[2])) / 2.0
    y = (float(subject[1]) + float(subject[3])) / 2.0
    return (
        float(container[0]) <= x <= float(container[2])
        and float(container[1]) <= y <= float(container[3])
    )


def comparison_evidence(
    blocks: Sequence[Mapping[str, Any]],
    paddle_items: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    matches: dict[str, list[int]] = defaultdict(list)
    matched_indexes: set[int] = set()
    for paddle_index, item in enumerate(paddle_items):
        candidates: list[tuple[float, str]] = []
        for block in blocks:
            overlap = base.bbox_ioa(item["bbox"], block["bbox"])
            centered = center_in_bbox(item["bbox"], block["bbox"])
            score = max(overlap, 0.70 if centered else 0.0)
            if score >= MIN_COMPARISON_OVERLAP:
                candidates.append((score, str(block["id"])))
        if not candidates:
            continue
        _, block_id = max(candidates, key=lambda value: (value[0], value[1]))
        matches[block_id].append(paddle_index)
        matched_indexes.add(paddle_index)

    vertical_cross_group = 0
    cross_group = 0
    evidence_blocks: list[dict[str, Any]] = []
    block_by_id = {str(block["id"]): block for block in blocks}
    for block_id, indexes in matches.items():
        block = block_by_id[block_id]
        if block["kind"] != "text" or block["containerClass"] != "bubble":
            continue
        groups = sorted(
            {base.paddle_group_key(paddle_items[index]) for index in indexes},
            key=base.natural_key,
        )
        if len(groups) < 2:
            continue
        vertical = [
            index
            for index in indexes
            if float(paddle_items[index]["bbox"][3])
            - float(paddle_items[index]["bbox"][1])
            >= base.VERTICAL_FRAGMENT_ASPECT_RATIO
            * (
                float(paddle_items[index]["bbox"][2])
                - float(paddle_items[index]["bbox"][0])
            )
        ]
        cross_group += 1
        is_vertical = len(vertical) >= 2
        vertical_cross_group += int(is_vertical)
        evidence_blocks.append(
            {
                "blockId": block_id,
                "paddleGroupIds": groups,
                "paddleFragmentCount": len(indexes),
                "verticalPaddleFragmentCount": len(vertical),
                "isVerticalCase": is_vertical,
            }
        )

    coverage = len(matched_indexes) / max(1, len(paddle_items))
    eligible = (
        vertical_cross_group >= 1
        and len(paddle_items) >= MIN_PADDLE_FRAGMENTS
        and coverage >= MIN_COMPARISON_COVERAGE
    )
    score = (
        vertical_cross_group * 1000
        + cross_group * 200
        + len(evidence_blocks) * 25
        + len(matched_indexes)
    )
    return {
        "eligible": eligible,
        "score": score,
        "comparisonOnly": True,
        "paddleMatchCoverage": round(coverage, 6),
        "crossGroupBubbleTextBlockCount": cross_group,
        "verticalCrossGroupBubbleTextBlockCount": vertical_cross_group,
        "blocks": evidence_blocks,
    }


def analyze_page(
    model: Any,
    item: Mapping[str, Any],
    paddle_payload: Mapping[str, Any],
) -> tuple[dict[str, Any], float]:
    path = Path(item["path"])
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    width, height = image.size
    started = time.perf_counter()
    result = model.predict(
        image,
        threshold=base.MIN_PREDICT_THRESHOLD,
        shape=(1152, 1152),
        include_source_image=False,
    )
    elapsed = time.perf_counter() - started
    detections = base.prepare_layout_detections(result, width, height)
    blocks = build_koharu_only_blocks(detections, width, height)
    paddle_items = base.normalized_paddle_items(paddle_payload, width, height)
    evidence = comparison_evidence(blocks, paddle_items)
    source_counts = Counter(str(block["sourceDetectionId"]) for block in blocks)
    metrics = {
        "paddleFragmentCount": len(paddle_items),
        "finalBlockCount": len(blocks),
        "textBlockCount": sum(block["kind"] == "text" for block in blocks),
        "onomatopoeiaBlockCount": sum(
            block["kind"] == "onomatopoeia" for block in blocks
        ),
        "bubbleCroppedBlockCount": sum(
            block["containerClass"] == "bubble" for block in blocks
        ),
        "panelCroppedBlockCount": sum(
            block["containerClass"] == "panel" for block in blocks
        ),
        "uncontainedBlockCount": sum(
            block["containerClass"] == "uncontained" for block in blocks
        ),
        "splitSourceDetectionCount": sum(value > 1 for value in source_counts.values()),
        "koharuTextCount": sum(
            detection["class"] == "text" for detection in detections
        ),
        "koharuBubbleCount": sum(
            detection["class"] == "bubble" for detection in detections
        ),
        "koharuPanelCount": sum(
            detection["class"] == "panel" for detection in detections
        ),
        "koharuSfxCount": sum(
            detection["class"] == "onomatopoeia" for detection in detections
        ),
        "candidateScore": int(evidence["score"]),
        "problemScore": int(
            sum(value > 1 for value in source_counts.values()) * 20
            + len(blocks)
        ),
    }
    return (
        {
            "schemaVersion": SCHEMA_VERSION,
            "id": item["id"],
            "path": item["path"],
            "relativePath": item["relativePath"],
            "source": item["source"],
            "series": item["series"],
            "chapter": item["chapter"],
            "width": width,
            "height": height,
            "paddleSource": paddle_payload.get("source"),
            "paddleRole": "panel-b-and-candidate-ranking-only",
            "paddleItems": paddle_items,
            "koharuDetections": [
                base.serializable_detection(value) for value in detections
            ],
            "finalBlocks": blocks,
            "candidateEvidence": evidence,
            "metrics": metrics,
            "timing": {"koharuDetectionSeconds": round(elapsed, 6)},
        },
        elapsed,
    )


def render_panel_c(
    record: Mapping[str, Any], source: Image.Image, scale: float
) -> Image.Image:
    panel = source.copy().convert("RGBA")
    draw = ImageDraw.Draw(panel, "RGBA")
    label_font = base.load_font(max(14, int(18 * min(1.0, scale))), bold=True)
    thick = max(2, int(round(4 / max(scale, 0.25))))
    for block in record["finalBlocks"]:
        color = (
            (34, 197, 94, 255)
            if block["kind"] == "text"
            else (236, 72, 153, 255)
        )
        box = base.transformed_box(block["bbox"], scale)
        draw.rounded_rectangle(box, radius=5, outline=color, width=thick)
        base.draw_box_label(
            draw,
            box,
            str(block["id"]),
            color,
            label_font,
        )
    return panel


def render_composite(record: Mapping[str, Any], output_path: Path) -> None:
    with Image.open(record["path"]) as opened:
        original = ImageOps.exif_transpose(opened).convert("RGB")
    panel_width = 700
    max_panel_height = 1600
    scale = min(panel_width / original.width, max_panel_height / original.height)
    display_size = (
        max(1, int(round(original.width * scale))),
        max(1, int(round(original.height * scale))),
    )
    source = original.resize(display_size, Image.Resampling.LANCZOS)
    panels = [
        source.convert("RGBA"),
        base.render_panel_b(record, source, scale),
        render_panel_c(record, source, scale),
    ]
    headers = [
        ("A · 원문", "박스 없음"),
        (
            f"B · PaddleOCR 원시 조각 ({record['metrics']['paddleFragmentCount']})",
            "빨강=확정 · 주황=검토 필요",
        ),
        (
            f"C · Koharu-only 영역 ({record['metrics']['finalBlockCount']})",
            "C 생성에 Paddle 미사용 · 초록=text · 자홍=onomatopoeia",
        ),
    ]
    title_height = 54
    header_height = 104
    gap = 18
    margin = 20
    canvas_width = margin * 2 + display_size[0] * 3 + gap * 2
    canvas_height = margin * 2 + title_height + header_height + display_size[1]
    canvas = Image.new("RGB", (canvas_width, canvas_height), (15, 23, 42))
    draw = ImageDraw.Draw(canvas)
    title_font = base.load_font(24, bold=True)
    header_font = base.load_font(25, bold=True)
    small_font = base.load_font(17)
    title = f"{record['id']} · {record['relativePath']}"
    draw.text(
        (margin, margin + 8),
        base.truncate_text(draw, title, title_font, canvas_width - margin * 2),
        font=title_font,
        fill=(241, 245, 249),
    )
    image_y = margin + title_height + header_height
    for index, (panel, (heading, detail)) in enumerate(zip(panels, headers)):
        x = margin + index * (display_size[0] + gap)
        draw.rounded_rectangle(
            (x, margin + title_height, x + display_size[0], image_y - 8),
            radius=10,
            fill=(30, 41, 59),
        )
        draw.text(
            (x + 14, margin + title_height + 12),
            heading,
            font=header_font,
            fill=(248, 250, 252),
        )
        draw.text(
            (x + 14, margin + title_height + 54),
            base.truncate_text(draw, detail, small_font, display_size[0] - 28),
            font=small_font,
            fill=(203, 213, 225),
        )
        canvas.paste(panel.convert("RGB"), (x, image_y))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG", compress_level=4)


def aggregate_summary(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    totals: Counter[str] = Counter()
    times: list[float] = []
    comparison_coverages: list[float] = []
    metric_names = (
        "paddleFragmentCount",
        "finalBlockCount",
        "textBlockCount",
        "onomatopoeiaBlockCount",
        "bubbleCroppedBlockCount",
        "panelCroppedBlockCount",
        "uncontainedBlockCount",
        "splitSourceDetectionCount",
        "koharuTextCount",
        "koharuBubbleCount",
        "koharuPanelCount",
        "koharuSfxCount",
    )
    for record in records:
        for name in metric_names:
            totals[name] += int(record["metrics"][name])
        times.append(float(record["timing"]["koharuDetectionSeconds"]))
        if int(record["metrics"]["paddleFragmentCount"]) > 0:
            comparison_coverages.append(
                float(record["candidateEvidence"]["paddleMatchCoverage"])
            )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "pageCount": len(records),
        "model": {
            "repo": base.MODEL_REPO,
            "revision": base.MODEL_REVISION,
            "sha256": base.MODEL_SHA256,
        },
        "cGeometryUsesPaddle": False,
        "partition": {
            "order": ["bubble-for-text", "panel", "uncontained"],
            "minimumContainerPieceFraction": MIN_CONTAINER_PIECE_FRACTION,
        },
        "totals": dict(totals),
        "comparison": {
            "paddleRole": "panel-b-and-ranking-only",
            "nonemptyPaddlePageCount": len(comparison_coverages),
            "meanPaddleBoxMatchCoverage": round(
                sum(comparison_coverages) / max(1, len(comparison_coverages)), 6
            ),
            "p10PaddleBoxMatchCoverage": round(
                float(np.percentile(comparison_coverages, 10))
                if comparison_coverages
                else 0.0,
                6,
            ),
            "medianPaddleBoxMatchCoverage": round(
                float(np.percentile(comparison_coverages, 50))
                if comparison_coverages
                else 0.0,
                6,
            ),
            "fullyMatchedPageCount": sum(
                coverage >= 0.999999 for coverage in comparison_coverages
            ),
        },
        "timing": {
            "meanKoharuSeconds": round(sum(times) / max(1, len(times)), 6),
            "p50KoharuSeconds": round(
                float(np.percentile(times, 50)) if times else 0.0, 6
            ),
            "p95KoharuSeconds": round(
                float(np.percentile(times, 95)) if times else 0.0, 6
            ),
        },
    }


def write_summary(
    output_dir: Path,
    summary: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    representatives: Sequence[Mapping[str, Any]],
    candidate_sheets: Sequence[Path],
    representative_sheets: Sequence[Path],
) -> None:
    totals = summary["totals"]
    lines = [
        "# Koharu-only layout crop evaluation",
        "",
        "Panel C is generated without PaddleOCR geometry or grouping. Paddle appears only in panel B and candidate ranking.",
        "",
        "## Smoke summary",
        "",
        f"- Pages: {summary['pageCount']}",
        f"- Koharu-only C blocks: {totals.get('finalBlockCount', 0)}",
        f"- Text blocks: {totals.get('textBlockCount', 0)}",
        f"- Onomatopoeia blocks: {totals.get('onomatopoeiaBlockCount', 0)}",
        f"- Bubble crops: {totals.get('bubbleCroppedBlockCount', 0)}",
        f"- Panel crops: {totals.get('panelCroppedBlockCount', 0)}",
        f"- Uncontained crops: {totals.get('uncontainedBlockCount', 0)}",
        f"- Source detections split by containers: {totals.get('splitSourceDetectionCount', 0)}",
        f"- Paddle-box comparison coverage on nonempty B pages: mean {summary['comparison']['meanPaddleBoxMatchCoverage']:.1%}, p10 {summary['comparison']['p10PaddleBoxMatchCoverage']:.1%}, median {summary['comparison']['medianPaddleBoxMatchCoverage']:.1%} (ranking/QA only; not used to build C)",
        f"- Mean Koharu time: {summary['timing']['meanKoharuSeconds']:.3f}s/page",
        "",
        "## Crop contract",
        "",
        "- Text masks are claimed by bubble masks first, then remaining pixels by panel masks.",
        "- Onomatopoeia masks are partitioned by panel masks.",
        "- Residual pixels become their own tight mask-derived rectangle.",
        "- Different text/onomatopoeia detections are never merged.",
        "- Paddle boxes never alter a C rectangle.",
        "",
        f"## Candidate pool ({len(candidates)})",
        "",
    ]
    for path in candidate_sheets:
        lines.append(f"- `{path.relative_to(output_dir).as_posix()}`")
    lines.extend(["", f"## Selected comparisons ({len(representatives)})", ""])
    for record in representatives:
        lines.append(
            f"- `{record['id']}` {record['relativePath']} — C blocks {record['metrics']['finalBlockCount']}, split source detections {record['metrics']['splitSourceDetectionCount']}"
        )
    lines.extend(["", "## Selected contact sheets", ""])
    for path in representative_sheets:
        lines.append(f"- `{path.relative_to(output_dir).as_posix()}`")
    lines.extend(
        [
            "",
            "## Pinned model",
            "",
            f"- `{base.MODEL_REPO}@{base.MODEL_REVISION}`",
            f"- SHA-256 `{base.MODEL_SHA256}`",
        ]
    )
    (output_dir / "README.md").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )


def self_test() -> None:
    height, width = 120, 120
    panel = np.zeros((height, width), dtype=bool)
    panel[5:115, 5:115] = True
    bubble = np.zeros_like(panel)
    bubble[10:75, 10:70] = True
    text = np.zeros_like(panel)
    text[20:65, 20:60] = True
    text[85:105, 80:105] = True
    detections = [
        {"id": "K001", "class": "panel", "score": 0.95, "bbox": [5, 5, 115, 115], "mask": panel, "maskArea": int(panel.sum())},
        {"id": "K002", "class": "bubble", "score": 0.95, "bbox": [10, 10, 70, 75], "mask": bubble, "maskArea": int(bubble.sum())},
        {"id": "K003", "class": "text", "score": 0.95, "bbox": [20, 20, 105, 105], "mask": text, "maskArea": int(text.sum())},
    ]
    blocks = build_koharu_only_blocks(detections, width, height)
    if len(blocks) != 2 or {block["containerClass"] for block in blocks} != {"bubble", "panel"}:
        raise base.EvaluationError(
            "Koharu-only self-test failed: bubble and panel did not split one text mask"
        )

    left_panel = np.zeros_like(panel)
    left_panel[:, :55] = True
    right_panel = np.zeros_like(panel)
    right_panel[:, 65:] = True
    spanning = np.zeros_like(panel)
    spanning[20:50, 20:40] = True
    spanning[70:100, 80:100] = True
    split_blocks = build_koharu_only_blocks(
        [
            {"id": "K101", "class": "panel", "score": 0.95, "bbox": [0, 0, 55, 120], "mask": left_panel, "maskArea": int(left_panel.sum())},
            {"id": "K102", "class": "panel", "score": 0.95, "bbox": [65, 0, 120, 120], "mask": right_panel, "maskArea": int(right_panel.sum())},
            {"id": "K103", "class": "text", "score": 0.95, "bbox": [20, 20, 100, 100], "mask": spanning, "maskArea": int(spanning.sum())},
        ],
        width,
        height,
    )
    if len(split_blocks) != 2 or any(
        block["containerClass"] != "panel" for block in split_blocks
    ):
        raise base.EvaluationError(
            "Koharu-only self-test failed: one text mask was not split across panels"
        )
    print("[self-test] Koharu-only mask partitioning passed")


def analyze(args: argparse.Namespace) -> None:
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    manifest = base.read_json(input_dir / "manifest.json")
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        raise base.EvaluationError("input manifest has no items")
    output_dir.mkdir(parents=True, exist_ok=True)
    base.write_json(
        output_dir / "manifest.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "sourceManifest": str((input_dir / "manifest.json").resolve()),
            "items": items,
        },
    )

    print(f"[koharu-only] loading {base.MODEL_REPO}@{base.MODEL_REVISION}", flush=True)
    model, _ = base.load_layout_model()
    records: list[dict[str, Any]] = []
    result_dir = output_dir / "results"
    for index, item in enumerate(items, 1):
        result_path = result_dir / f"{item['id']}.json"
        if result_path.is_file() and not args.force:
            record = base.read_json(result_path)
            records.append(record)
            print(f"[koharu-only] {index}/{len(items)} {item['id']} cached", flush=True)
            continue
        paddle_payload = base.read_json(input_dir / "paddle" / f"{item['id']}.json")
        record, elapsed = analyze_page(model, item, paddle_payload)
        base.write_json(result_path, record)
        records.append(record)
        print(
            f"[koharu-only] {index}/{len(items)} {item['id']} {elapsed:.3f}s "
            f"C={record['metrics']['finalBlockCount']} split={record['metrics']['splitSourceDetectionCount']}",
            flush=True,
        )

    eligible = [record for record in records if record["candidateEvidence"]["eligible"]]
    candidates = base.choose_diverse_scored_records(
        eligible, min(args.candidates, len(eligible))
    )
    representatives = base.choose_diverse_scored_records(
        candidates, min(args.representatives, len(candidates))
    )
    summary = aggregate_summary(records)
    summary["candidateSelection"] = {
        "eligiblePageCount": len(eligible),
        "candidatePoolCount": len(candidates),
        "representativeCount": len(representatives),
        "paddleRole": "ranking-only",
        "minimumPaddleFragments": MIN_PADDLE_FRAGMENTS,
        "minimumComparisonCoverage": MIN_COMPARISON_COVERAGE,
    }

    candidate_paths: list[Path] = []
    for index, record in enumerate(candidates, 1):
        path = output_dir / "candidate-composites" / f"{index:02d}-{record['id']}.png"
        render_composite(record, path)
        candidate_paths.append(path)
        print(f"[candidate] {index}/{len(candidates)} {path.name}", flush=True)
    candidate_sheets = base.build_contact_sheets(
        candidate_paths,
        output_dir / "candidate-contact-sheets",
        "Koharu-only 사전 후보",
    )

    representative_paths: list[Path] = []
    for index, record in enumerate(representatives, 1):
        path = output_dir / "selected-composites" / f"{index:02d}-{record['id']}.png"
        render_composite(record, path)
        representative_paths.append(path)
        print(f"[render] {index}/{len(representatives)} {path.name}", flush=True)
    representative_sheets = base.build_contact_sheets(
        representative_paths,
        output_dir / "selected-contact-sheets",
        "Koharu-only 최종 비교",
    )
    base.write_json(output_dir / "summary.json", summary)
    base.write_json(
        output_dir / "candidate-pool.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "selection": summary["candidateSelection"],
            "items": [
                {
                    "id": record["id"],
                    "relativePath": record["relativePath"],
                    "metrics": record["metrics"],
                    "candidateEvidence": record["candidateEvidence"],
                    "composite": str(path.relative_to(output_dir)).replace("\\", "/"),
                }
                for record, path in zip(candidates, candidate_paths)
            ],
        },
    )
    base.write_json(
        output_dir / "representatives.json",
        {
            "schemaVersion": SCHEMA_VERSION,
            "items": [
                {
                    "id": record["id"],
                    "relativePath": record["relativePath"],
                    "metrics": record["metrics"],
                    "candidateEvidence": record["candidateEvidence"],
                    "composite": str(path.relative_to(output_dir)).replace("\\", "/"),
                }
                for record, path in zip(representatives, representative_paths)
            ],
        },
    )
    write_summary(
        output_dir,
        summary,
        candidates,
        representatives,
        candidate_sheets,
        representative_sheets,
    )
    print(f"[complete] {output_dir / 'README.md'}", flush=True)


def render_all(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir).expanduser().resolve()
    result_paths = sorted(
        (output_dir / "results").glob("P*.json"),
        key=lambda path: base.natural_key(path.stem),
    )
    if not result_paths:
        raise base.EvaluationError(f"no result JSON files found under {output_dir}")
    composite_dir = output_dir / "all-composites"
    manifest_items: list[dict[str, str]] = []
    for index, result_path in enumerate(result_paths, 1):
        record = base.read_json(result_path)
        composite_path = composite_dir / f"{index:03d}-{record['id']}-koharu-only.png"
        render_composite(record, composite_path)
        manifest_items.append(
            {
                "id": str(record["id"]),
                "relativePath": str(record["relativePath"]),
                "composite": str(composite_path.relative_to(output_dir)).replace(
                    "\\", "/"
                ),
            }
        )
        print(
            f"[render-all] {index}/{len(result_paths)} {composite_path.name}",
            flush=True,
        )
    base.write_json(
        output_dir / "all-composites.json",
        {"schemaVersion": SCHEMA_VERSION, "items": manifest_items},
    )
    print(f"[render-all] complete: {composite_dir}", flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("self-test")
    render_parser = subparsers.add_parser("render-all")
    render_parser.add_argument("--output-dir", required=True)
    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument("--input-dir", required=True)
    analyze_parser.add_argument("--output-dir", required=True)
    analyze_parser.add_argument("--candidates", type=int, default=DEFAULT_CANDIDATES)
    analyze_parser.add_argument(
        "--representatives", type=int, default=DEFAULT_REPRESENTATIVES
    )
    analyze_parser.add_argument("--force", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "self-test":
        self_test()
    elif args.command == "render-all":
        render_all(args)
    elif args.command == "analyze":
        analyze(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except base.EvaluationError as error:
        print(f"[koharu-only] {error}")
        raise SystemExit(2) from error
