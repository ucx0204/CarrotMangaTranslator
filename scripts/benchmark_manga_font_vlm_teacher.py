#!/usr/bin/env python3
"""Benchmark a local vision-language model as a suggestion-only font ranker.

The benchmark is intentionally restricted to the adjudicated 33-row validation
overlay.  It never reads the frozen test split, fresh final cohort, or library QA
cohorts.  Candidate order is shuffled independently for every sample and the
model sees only neutral C01..C22 codes, never font names or human tiers.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image, ImageDraw, ImageFont, ImageOps


SCHEMA_VERSION = "manga-font-vlm-teacher-benchmark-v1"
DEFAULT_SEED = "manga-font-vlm-teacher-neutral-order-v1"
EXPECTED_VAL_COUNT = 33
EXPECTED_CANDIDATE_COUNT = 22
VARIANT_EXCLUDED_ROLES = frozenset({"dialogue"})
NEUTRAL_PROBE_ID = "dialogue-body"

PILOT_ROLE_ORDER = (
    "dialogue",
    "sfx_impact",
    "sfx_comic",
    "sfx_ambient",
    "sfx_emotion",
    "sign_ui_title",
    "shout",
    "aside_balloon_edge",
)

PROMPT = """You are comparing visual typeface shapes, not reading or translating text.
The image contains one SOURCE panel and 22 candidate panels labeled C01 through C22.
Rank every candidate from most to least visually similar to the SOURCE typeface.
Compare only glyph shape: serif versus sans, stroke weight and contrast, width,
roundness versus angularity, handwritten irregularity, slant, and visual energy.
Ignore language and word meaning, surrounding artwork, candidate position, and text
orientation. The C-codes are arbitrary and carry no meaning. Do not infer genre,
font name, or intended role. Return each of C01..C22 exactly once.
Return only JSON in this shape: {"ranked_codes":["C01", "C02", ...]}"""


class BenchmarkError(RuntimeError):
    """Raised when a benchmark contract cannot be proven."""


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"could not read JSON {path}: {error}") from error


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise BenchmarkError(f"{path}:{line_number} is not an object")
                rows.append(value)
    except (OSError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"could not read JSONL {path}: {error}") from error
    return rows


def safe_relative(root: Path, relative: str, label: str) -> Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise BenchmarkError(f"{label} escapes its root: {relative}") from error
    if not candidate.is_file():
        raise BenchmarkError(f"{label} is missing: {candidate}")
    return candidate


def source_catalog_root(project_root: Path, catalog_id: str) -> Path:
    roots = {
        "fontclip-hard-accepted-v2": project_root
        / "datasets/fontclip-hard-accepted-v2",
        "fontclip-accepted-v1": project_root / "datasets/fontclip-accepted-v1",
        "fontclip-recrop-accepted-v1": project_root
        / "datasets/font-matching-recrop-accepted-v1",
    }
    root = roots.get(catalog_id)
    if root is None:
        raise BenchmarkError(f"unsupported validation source catalog: {catalog_id}")
    return root.resolve()


def validate_val_rows(rows: Sequence[Mapping[str, Any]]) -> tuple[str, ...]:
    if len(rows) != EXPECTED_VAL_COUNT:
        raise BenchmarkError(
            f"expected exactly {EXPECTED_VAL_COUNT} val rows, found {len(rows)}"
        )
    sample_ids: list[str] = []
    for index, row in enumerate(rows):
        if row.get("split") != "val":
            raise BenchmarkError(f"row {index} is not validation-only")
        sample_id = str(row.get("sample_id") or "")
        if not sample_id or sample_id in sample_ids:
            raise BenchmarkError(f"row {index} has a missing or duplicate sample_id")
        judgment = row.get("font_judgment")
        if not isinstance(judgment, Mapping):
            raise BenchmarkError(f"row {index} has no adjudicated font judgment")
        reviewed = set()
        for tier in (
            "preferred",
            "acceptable",
            "marginal",
            "unacceptable",
            "unrenderable",
        ):
            values = judgment.get(tier)
            if not isinstance(values, list):
                raise BenchmarkError(f"row {index} judgment.{tier} is invalid")
            reviewed.update(str(value) for value in values)
        not_reviewed = judgment.get("not_reviewed")
        if not isinstance(not_reviewed, list) or not_reviewed:
            raise BenchmarkError(f"row {index} is not exhaustive full-22 gold")
        if len(reviewed) != EXPECTED_CANDIDATE_COUNT:
            raise BenchmarkError(f"row {index} does not cover all 22 candidates")
        sample_ids.append(sample_id)
    return tuple(sample_ids)


def canonical_candidates(
    render_bank: Mapping[str, Any], expected_font_ids: Sequence[str]
) -> tuple[dict[str, Mapping[str, Any]], dict[tuple[str, str, str], Mapping[str, Any]]]:
    raw_candidates = render_bank.get("candidates")
    raw_renders = render_bank.get("renders")
    if not isinstance(raw_candidates, list) or not isinstance(raw_renders, list):
        raise BenchmarkError("render bank candidates/renders are invalid")
    candidates: dict[str, Mapping[str, Any]] = {}
    for font_id in expected_font_ids:
        matching = [
            candidate
            for candidate in raw_candidates
            if isinstance(candidate, Mapping) and candidate.get("font_id") == font_id
        ]
        canonical = [
            candidate
            for candidate in matching
            if candidate.get("production_400_normal_canonical") is True
        ]
        if len(canonical) != 1:
            raise BenchmarkError(
                f"font {font_id} does not have one canonical production face"
            )
        candidates[font_id] = canonical[0]
    render_lookup: dict[tuple[str, str, str], Mapping[str, Any]] = {}
    canonical_display_ids = {
        str(candidate["display_id"]): font_id
        for font_id, candidate in candidates.items()
    }
    for render in raw_renders:
        if not isinstance(render, Mapping):
            continue
        display_id = str(render.get("candidate_display_id") or "")
        font_id = canonical_display_ids.get(display_id)
        if font_id is None:
            continue
        key = (
            font_id,
            str(render.get("probe_id") or ""),
            str(render.get("writing_mode") or ""),
        )
        if key in render_lookup:
            raise BenchmarkError(f"duplicate canonical render: {key}")
        render_lookup[key] = render
    return candidates, render_lookup


def shuffled_font_ids(font_ids: Sequence[str], sample_id: str, seed: str) -> list[str]:
    return sorted(
        font_ids,
        key=lambda font_id: hashlib.sha256(
            f"{seed}\0{sample_id}\0{font_id}".encode("utf-8")
        ).digest(),
    )


def choose_pilot(rows: Sequence[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    if count <= 0:
        raise BenchmarkError("pilot count must be positive")
    selected: list[dict[str, Any]] = []
    used: set[str] = set()
    orientation_preference = {
        "sfx_impact": "horizontal",
        "sfx_comic": "horizontal",
    }
    for role in PILOT_ROLE_ORDER:
        matches = [row for row in rows if row.get("role", {}).get("primary") == role]
        preferred_orientation = orientation_preference.get(role)
        if preferred_orientation:
            matches.sort(
                key=lambda row: (
                    row.get("treatment", {}).get("orientation")
                    != preferred_orientation,
                    str(row.get("sample_id")),
                )
            )
        else:
            matches.sort(key=lambda row: str(row.get("sample_id")))
        if matches:
            selected.append(matches[0])
            used.add(str(matches[0]["sample_id"]))
        if len(selected) >= count:
            return selected
    for row in rows:
        if str(row["sample_id"]) not in used:
            selected.append(row)
        if len(selected) >= count:
            break
    return selected


def image_font(size: int) -> ImageFont.ImageFont:
    candidates = (
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
        Path("C:/Windows/Fonts/arial.ttf"),
    )
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def trim_white(image: Image.Image, padding: int = 8) -> Image.Image:
    rgb = image.convert("RGB")
    gray = ImageOps.grayscale(rgb)
    mask = gray.point(lambda value: 255 if value < 245 else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return rgb
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(rgb.width, bbox[2] + padding)
    bottom = min(rgb.height, bbox[3] + padding)
    return rgb.crop((left, top, right, bottom))


def paste_contained(
    canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]
) -> None:
    left, top, right, bottom = box
    contained = ImageOps.contain(
        image.convert("RGB"),
        (max(1, right - left), max(1, bottom - top)),
        Image.Resampling.LANCZOS,
    )
    x = left + ((right - left) - contained.width) // 2
    y = top + ((bottom - top) - contained.height) // 2
    canvas.paste(contained, (x, y))


def build_grid(
    *,
    row: Mapping[str, Any],
    candidate_ids: Sequence[str],
    code_to_font: Mapping[str, str],
    render_lookup: Mapping[tuple[str, str, str], Mapping[str, Any]],
    render_bank_root: Path,
    project_root: Path,
    output_path: Path,
) -> dict[str, Any]:
    source_view = row.get("source", {}).get("views", {}).get("glyph_224")
    if not isinstance(source_view, Mapping) or source_view.get("status") != "available":
        raise BenchmarkError(f"{row.get('sample_id')}: glyph_224 is unavailable")
    catalog_id = str(source_view.get("catalog_id") or "")
    source_root = source_catalog_root(project_root, catalog_id)
    source_path = safe_relative(
        source_root, str(source_view.get("path") or ""), "source glyph"
    )
    expected_source_sha = str(source_view.get("file_sha256") or "")
    if expected_source_sha and sha256_file(source_path) != expected_source_sha:
        raise BenchmarkError(f"{row.get('sample_id')}: source glyph hash drifted")

    probe = NEUTRAL_PROBE_ID
    raw_orientation = str(row.get("treatment", {}).get("orientation") or "")
    requested_mode = "vertical" if raw_orientation == "vertical" else "horizontal"

    width = 1600
    source_height = 360
    columns = 4
    cell_width = width // columns
    cell_height = 190
    rows = math.ceil(len(candidate_ids) / columns)
    height = source_height + rows * cell_height
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)
    label_font = image_font(25)
    source_font = image_font(30)

    draw.text((24, 18), "SOURCE", fill="#111111", font=source_font)
    source_image = trim_white(Image.open(source_path))
    paste_contained(canvas, source_image, (80, 58, width - 80, source_height - 24))
    draw.line((0, source_height - 1, width, source_height - 1), fill="#777777", width=2)

    render_records: list[dict[str, Any]] = []
    for display_index, code in enumerate(sorted(code_to_font)):
        font_id = code_to_font[code]
        writing_mode = requested_mode
        render = render_lookup.get((font_id, probe, writing_mode))
        fallback = False
        if render is None:
            writing_mode = (
                "vertical" if requested_mode == "horizontal" else "horizontal"
            )
            render = render_lookup.get((font_id, probe, writing_mode))
            fallback = True
        if render is None:
            raise BenchmarkError(
                f"missing render for {font_id}/{probe}/{requested_mode}"
            )
        artifact = render.get("artifact")
        if not isinstance(artifact, Mapping):
            raise BenchmarkError(
                f"invalid render artifact for {font_id}/{probe}/{writing_mode}"
            )
        render_path = safe_relative(
            render_bank_root, str(artifact.get("file") or ""), "candidate render"
        )
        expected_render_sha = str(artifact.get("sha256") or "")
        actual_render_sha = sha256_file(render_path)
        if expected_render_sha != actual_render_sha:
            raise BenchmarkError(f"candidate render hash drifted: {font_id}")

        row_index, column_index = divmod(display_index, columns)
        left = column_index * cell_width
        top = source_height + row_index * cell_height
        right = left + cell_width
        bottom = top + cell_height
        draw.rectangle((left, top, right - 1, bottom - 1), outline="#b0b0b0", width=1)
        draw.text((left + 12, top + 8), code, fill="#111111", font=label_font)
        candidate_image = trim_white(Image.open(render_path))
        paste_contained(
            canvas, candidate_image, (left + 46, top + 38, right - 20, bottom - 14)
        )
        render_records.append(
            {
                "code": code,
                "font_id": font_id,
                "probe_id": probe,
                "writing_mode": writing_mode,
                "orientation_fallback": fallback,
                "render_file_sha256": actual_render_sha,
            }
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG", optimize=True)
    return {
        "source_catalog_id": catalog_id,
        "source_file_sha256": sha256_file(source_path),
        "probe_id": probe,
        "requested_writing_mode": requested_mode,
        "render_records": render_records,
        "grid_width": width,
        "grid_height": height,
        "grid_sha256": sha256_file(output_path),
    }


def request_schema(codes: Sequence[str]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "font_visual_ranking",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "ranked_codes": {
                        "type": "array",
                        "items": {"type": "string", "enum": list(codes)},
                        "minItems": len(codes),
                        "maxItems": len(codes),
                    }
                },
                "required": ["ranked_codes"],
                "additionalProperties": False,
            },
        },
    }


def post_json(
    endpoint: str, payload: Mapping[str, Any], timeout: float
) -> tuple[int, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        try:
            parsed: Any = json.loads(response_body)
        except json.JSONDecodeError:
            parsed = {"raw_error": response_body}
        return error.code, parsed
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        raise BenchmarkError(f"VLM endpoint request failed: {error}") from error


def extract_message_text(response: Mapping[str, Any]) -> str:
    choices = response.get("choices")
    if (
        not isinstance(choices, list)
        or not choices
        or not isinstance(choices[0], Mapping)
    ):
        raise BenchmarkError("VLM response has no choice")
    message = choices[0].get("message")
    if not isinstance(message, Mapping):
        raise BenchmarkError("VLM response has no message")
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        text_parts = [
            str(part.get("text"))
            for part in content
            if isinstance(part, Mapping) and isinstance(part.get("text"), str)
        ]
        return "\n".join(text_parts).strip()
    raise BenchmarkError("VLM response content is not text")


def parse_ranking(text: str, codes: Sequence[str]) -> list[str]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`").strip()
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError as error:
        start, end = stripped.find("{"), stripped.rfind("}")
        if start < 0 or end <= start:
            raise BenchmarkError(f"model response is not JSON: {error}") from error
        try:
            value = json.loads(stripped[start : end + 1])
        except json.JSONDecodeError as nested:
            raise BenchmarkError(
                f"model response is not parseable JSON: {nested}"
            ) from nested
    ranked = value.get("ranked_codes") if isinstance(value, Mapping) else None
    if not isinstance(ranked, list) or not all(
        isinstance(code, str) for code in ranked
    ):
        raise BenchmarkError("model response has no ranked_codes string array")
    expected = set(codes)
    if len(ranked) != len(codes) or set(ranked) != expected:
        counts = Counter(ranked)
        duplicates = sorted(code for code, count in counts.items() if count > 1)
        missing = sorted(expected - set(ranked))
        extras = sorted(set(ranked) - expected)
        raise BenchmarkError(
            f"ranking is not an exact permutation; missing={missing}, extras={extras}, duplicates={duplicates}"
        )
    return ranked


def run_inference(
    *,
    endpoint: str,
    model: str,
    prompt: str,
    grid_path: Path,
    codes: Sequence[str],
    timeout: float,
) -> dict[str, Any]:
    data_url = "data:image/png;base64," + base64.b64encode(
        grid_path.read_bytes()
    ).decode("ascii")
    content = [
        {"type": "image_url", "image_url": {"url": data_url}},
        {"type": "text", "text": prompt},
    ]
    base_payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "top_p": 1,
        "seed": 20260803,
        "reasoning_effort": "none",
        "max_tokens": 320,
        "stream": False,
    }
    attempts: list[dict[str, Any]] = []
    last_error = ""
    for attempt_number in (1, 2):
        payload = dict(base_payload)
        schema_used = attempt_number == 1
        if schema_used:
            payload["response_format"] = request_schema(codes)
        started = time.perf_counter()
        status, response = post_json(endpoint, payload, timeout)
        latency = time.perf_counter() - started
        attempt: dict[str, Any] = {
            "attempt": attempt_number,
            "http_status": status,
            "latency_seconds": round(latency, 6),
            "json_schema_used": schema_used,
            "response": response,
        }
        attempts.append(attempt)
        if status < 200 or status >= 300 or not isinstance(response, Mapping):
            last_error = f"HTTP {status}"
            continue
        try:
            response_text = extract_message_text(response)
            ranked_codes = parse_ranking(response_text, codes)
        except BenchmarkError as error:
            last_error = str(error)
            continue
        return {
            "status": "parsed",
            "ranked_codes": ranked_codes,
            "response_text": response_text,
            "attempts": attempts,
        }
    return {
        "status": "parse_failed",
        "error": last_error,
        "ranked_codes": [],
        "attempts": attempts,
    }


def rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 8) if denominator else None


def evaluate(results: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    def score(subset: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        parsed = [result for result in subset if result.get("status") == "parsed"]
        preferred_hits = sum(bool(result.get("top1_preferred")) for result in parsed)
        acceptable_hits = sum(
            bool(result.get("top1_acceptable_or_preferred")) for result in parsed
        )
        hit3 = sum(
            bool(result.get("top3_acceptable_or_preferred")) for result in parsed
        )
        hit5 = sum(
            bool(result.get("top5_acceptable_or_preferred")) for result in parsed
        )
        return {
            "row_count": len(subset),
            "parsed_count": len(parsed),
            "parse_rate": rate(len(parsed), len(subset)),
            "preferred_at_1_count": preferred_hits,
            "preferred_at_1": rate(preferred_hits, len(parsed)),
            "acceptable_or_preferred_at_1_count": acceptable_hits,
            "acceptable_or_preferred_at_1": rate(acceptable_hits, len(parsed)),
            "acceptable_or_preferred_hit_3_count": hit3,
            "acceptable_or_preferred_hit_3": rate(hit3, len(parsed)),
            "acceptable_or_preferred_hit_5_count": hit5,
            "acceptable_or_preferred_hit_5": rate(hit5, len(parsed)),
        }

    variants = [result for result in results if result.get("is_variant") is True]
    return {"global": score(results), "variant": score(variants)}


def pilot_gate(metrics: Mapping[str, Any]) -> dict[str, Any]:
    global_metrics = metrics["global"]
    variant_metrics = metrics["variant"]
    checks = {
        "all_rows_parsed": global_metrics.get("parse_rate") == 1.0,
        "global_preferred_at_1_gte_0_25": (global_metrics.get("preferred_at_1") or 0)
        >= 0.25,
        "global_acceptable_at_1_gte_0_50": (
            global_metrics.get("acceptable_or_preferred_at_1") or 0
        )
        >= 0.50,
        "variant_preferred_at_1_gte_0_20": (variant_metrics.get("preferred_at_1") or 0)
        >= 0.20,
        "variant_acceptable_at_1_gte_0_50": (
            variant_metrics.get("acceptable_or_preferred_at_1") or 0
        )
        >= 0.50,
    }
    return {"passed": all(checks.values()), "checks": checks}


def write_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    path.write_bytes(b"".join(canonical_json(row) for row in rows))


def file_binding(path: Path, *, include_sha256: bool = True) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path": str(path.resolve()),
        "byte_size": path.stat().st_size,
    }
    if include_sha256:
        result["sha256"] = sha256_file(path)
    return result


def command_run(args: argparse.Namespace) -> int:
    project_root = args.project_root.resolve()
    val_path = args.val.resolve()
    render_bank_path = args.render_bank.resolve()
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    grids_dir = output_dir / "grids"
    grids_dir.mkdir(parents=True, exist_ok=True)

    val_rows = read_jsonl(val_path)
    validate_val_rows(val_rows)
    val_manifest = read_json(val_path.parent / "manifest.json")
    expected_candidates = val_manifest.get("candidate_ids")
    if (
        not isinstance(expected_candidates, list)
        or len(expected_candidates) != EXPECTED_CANDIDATE_COUNT
    ):
        raise BenchmarkError(
            "validation overlay manifest does not bind exactly 22 candidates"
        )
    font_ids = tuple(str(value) for value in expected_candidates)
    render_bank = read_json(render_bank_path)
    _, render_lookup = canonical_candidates(render_bank, font_ids)

    if args.mode == "smoke":
        selected_rows = choose_pilot(val_rows, 1)
    elif args.mode == "pilot":
        selected_rows = choose_pilot(val_rows, args.pilot_count)
    else:
        if args.promising_report is None:
            raise BenchmarkError(
                "full mode requires --promising-report from a passed pilot"
            )
        promising = read_json(args.promising_report.resolve())
        if promising.get("pilot_gate", {}).get("passed") is not True:
            raise BenchmarkError(
                "full mode is blocked because the pilot gate did not pass"
            )
        selected_rows = list(val_rows)

    prompt_sha = sha256_bytes(PROMPT.encode("utf-8"))
    requests: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for sample_index, row in enumerate(selected_rows, 1):
        sample_id = str(row["sample_id"])
        shuffled = shuffled_font_ids(font_ids, sample_id, args.seed)
        codes = tuple(
            f"C{index:02d}" for index in range(1, EXPECTED_CANDIDATE_COUNT + 1)
        )
        code_to_font = dict(zip(codes, shuffled, strict=True))
        grid_path = grids_dir / f"{sample_index:02d}-{sample_id}.png"
        grid = build_grid(
            row=row,
            candidate_ids=font_ids,
            code_to_font=code_to_font,
            render_lookup=render_lookup,
            render_bank_root=render_bank_path.parent,
            project_root=project_root,
            output_path=grid_path,
        )
        request_record = {
            "schema_version": SCHEMA_VERSION,
            "record_type": "manga_font_vlm_teacher_request",
            "mode": args.mode,
            "sample_index": sample_index,
            "sample_id": sample_id,
            "grid_file": str(grid_path.relative_to(output_dir)).replace("\\", "/"),
            "grid_sha256": grid["grid_sha256"],
            "prompt_sha256": prompt_sha,
            "candidate_order_seed": args.seed,
            "code_to_font_id": code_to_font,
            "visual_contract": {
                "candidate_labels_are_neutral_codes": True,
                "font_names_visible_to_model": False,
                "human_tiers_visible_to_model": False,
                "model_suggestions_visible_to_model": False,
                "role_work_sample_semantics_visible_to_model": False,
                "role_conditioned_candidate_probe": False,
                "fixed_neutral_candidate_probe": NEUTRAL_PROBE_ID,
                "prior_tier_colors_or_text_visible": False,
                "shape_only_prompt": True,
            },
            "grid": grid,
        }
        requests.append(request_record)
        print(
            f"[{sample_index}/{len(selected_rows)}] {sample_id}: requesting local VLM",
            flush=True,
        )
        inference = run_inference(
            endpoint=args.endpoint,
            model=args.model,
            prompt=PROMPT,
            grid_path=grid_path,
            codes=codes,
            timeout=args.timeout,
        )
        ranked_fonts = [
            code_to_font[code] for code in inference.get("ranked_codes", [])
        ]
        judgment = row["font_judgment"]
        preferred = set(str(value) for value in judgment["preferred"])
        acceptable = preferred | set(str(value) for value in judgment["acceptable"])
        top1 = ranked_fonts[0] if ranked_fonts else None
        role = str(row.get("role", {}).get("primary") or "")
        result = {
            "schema_version": SCHEMA_VERSION,
            "record_type": "manga_font_vlm_teacher_suggestion",
            "authority": "suggestion_only_not_gold",
            "training_eligible": False,
            "promotion_allowed": False,
            "sample_index": sample_index,
            "sample_id": sample_id,
            "status": inference["status"],
            "error": inference.get("error"),
            "ranked_codes": inference.get("ranked_codes", []),
            "ranked_font_ids": ranked_fonts,
            "top1_font_id": top1,
            "top1_preferred": top1 in preferred if top1 else False,
            "top1_acceptable_or_preferred": top1 in acceptable if top1 else False,
            "top3_acceptable_or_preferred": bool(set(ranked_fonts[:3]) & acceptable),
            "top5_acceptable_or_preferred": bool(set(ranked_fonts[:5]) & acceptable),
            "role_for_evaluation_only": role,
            "is_variant": role not in VARIANT_EXCLUDED_ROLES,
            "gold_for_evaluation_only": {
                "preferred": sorted(preferred),
                "acceptable_or_preferred": sorted(acceptable),
            },
            "response_text": inference.get("response_text"),
            "attempts": inference["attempts"],
        }
        results.append(result)

    metrics = evaluate(results)
    gate = pilot_gate(metrics) if args.mode == "pilot" else None
    write_jsonl(output_dir / "requests.jsonl", requests)
    write_jsonl(output_dir / "suggestions.jsonl", results)

    model_binding: dict[str, Any] = {"api_model": args.model}
    if args.model_file:
        model_binding["model_file"] = file_binding(args.model_file.resolve())
    if args.mmproj_file:
        model_binding["mmproj_file"] = file_binding(args.mmproj_file.resolve())
    report: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "manga_font_vlm_teacher_benchmark_report",
        "status": (
            "smoke_compatible"
            if args.mode == "smoke" and metrics["global"]["parse_rate"] == 1.0
            else "smoke_parse_failed"
            if args.mode == "smoke"
            else "pilot_promising_suggestion_only"
            if gate and gate["passed"]
            else "pilot_rejected"
            if gate
            else "full_validation_benchmark_complete_suggestion_only"
        ),
        "mode": args.mode,
        "row_count": len(results),
        "metrics": metrics,
        "pilot_gate": gate,
        "contracts": {
            "validation_only": True,
            "test30_read": False,
            "fresh64_read": False,
            "library_qa40_read": False,
            "large_model_download_performed": False,
            "outputs_are_suggestions_never_gold": True,
            "app_deployment_modified": False,
            "candidate_order_randomized_per_sample": True,
            "neutral_candidate_codes_only": True,
        },
        "inputs": {
            "validation_overlay": file_binding(val_path),
            "validation_overlay_manifest": file_binding(
                val_path.parent / "manifest.json"
            ),
            "render_bank_manifest": file_binding(render_bank_path),
            "prompt_sha256": prompt_sha,
            "candidate_order_seed": args.seed,
        },
        "model": model_binding,
        "endpoint": args.endpoint,
        "artifacts": {
            "requests": file_binding(output_dir / "requests.jsonl"),
            "suggestions": file_binding(output_dir / "suggestions.jsonl"),
            "grid_count": len(requests),
        },
    }
    report["record_sha256"] = sha256_bytes(canonical_json(report))
    (output_dir / "report.json").write_bytes(canonical_json(report))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", nargs="?", default="run")
    parser.add_argument(
        "--project-root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument(
        "--val",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-human-overlay-adjudicated-val33-v1/val-samples-adjudicated.jsonl"
        ),
    )
    parser.add_argument(
        "--render-bank",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v2/manifest.json"),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("smoke", "pilot", "full"), default="pilot")
    parser.add_argument("--pilot-count", type=int, default=8)
    parser.add_argument("--promising-report", type=Path)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument(
        "--endpoint", default="http://127.0.0.1:8797/v1/chat/completions"
    )
    parser.add_argument("--model", default="font-vlm")
    parser.add_argument("--model-file", type=Path)
    parser.add_argument("--mmproj-file", type=Path)
    parser.add_argument("--timeout", type=float, default=300.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return command_run(args)
    except BenchmarkError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
