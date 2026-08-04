#!/usr/bin/env python3
"""Build a val-only, named-font review bundle for student22 calibration gold.

The existing full22 labels are useful blind-agreement references, but they are
not silently promoted.  This tool reads only reference rows allowlisted by the
master validation split, shows the source crop beside all 22 named candidate
renders, and emits an editable decision template.  Test label rows are never
JSON-decoded and test pixels are never resolved.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    import build_font_matching_selection_calibration as calibration
    import font_matching_catalog_assets as catalog_assets
    import font_matching_labels as labels
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_font_matching_selection_calibration as calibration
    from scripts import font_matching_catalog_assets as catalog_assets
    from scripts import font_matching_labels as labels


SCHEMA_VERSION = "manga-font-student-calibration-review-v1"
RECORD_TYPE = "manga_font_student_calibration_review_item"
REPORT_TYPE = "manga_font_student_calibration_review_report"
DECISION_SCHEMA_VERSION = "manga-font-student-calibration-decision-v1"
DECISION_RECORD_TYPE = "manga_font_student_calibration_decision"
OWNER = "carrot-manga-translator/manga-font-student-calibration-review-v1"
MARKER_FILE = ".manga-font-student-calibration-review-owned.json"
REPORT_FILE = "report.json"
REVIEW_INPUT_FILE = "review-input.jsonl"
DECISION_TEMPLATE_FILE = "decisions-template.jsonl"
SHEETS_DIR = "contact-sheets"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
EXPECTED_CANDIDATE_IDS = (
    "mongtori",
    "chosun-gungseo",
    "griun-pol-sensibility",
    "nanum-gothic",
    "nanum-myeongjo",
    "nanum-barun-gothic",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "seoul-hangang",
    "dohyeon",
    "ridi-batang",
    "cafe24-gowoonbam",
    "start-over",
    "jua",
    "gaegu",
    "black-and-white-picture",
    "black-han-sans",
    "gasoek-one",
    "gugi",
    "kirang-haerang",
    "nanum-brush-script",
    "single-day",
)
ROLE_PROBES = {
    "dialogue": "dialogue-body",
    "narration": "narration",
    "thought": "thought-monologue",
    "whisper": "aside-whisper",
    "aside_balloon_edge": "aside-whisper",
    "emphasis_dialogue": "emphasis-shout",
    "shout": "emphasis-shout",
    "sfx_impact": "sfx-impact",
    "sfx_motion": "sfx-motion",
    "sfx_ambient": "sfx-ambient",
    "sfx_emotion": "sfx-emotion",
    "sfx_comic": "sfx-comic-reaction",
    "sign_ui_title": "narration",
    "other": "dialogue-body",
}
TIER_COLORS = {
    "preferred": (48, 150, 84),
    "acceptable": (62, 111, 207),
    "marginal": (190, 139, 22),
    "unacceptable": (130, 130, 130),
    "unrenderable": (193, 61, 52),
    "not_reviewed": (145, 75, 165),
}
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SAMPLE_ID_RE = calibration.SAMPLE_ID_RE


class StudentCalibrationReviewError(ValueError):
    """Raised when named review evidence is leaky, stale, or incomplete."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise StudentCalibrationReviewError(
            f"could not hash {path}: {error}"
        ) from error
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    declared = record.get("record_sha256")
    if not isinstance(declared, str) or SHA_RE.fullmatch(declared) is None:
        raise StudentCalibrationReviewError(f"{location}: invalid record SHA")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != declared:
        raise StudentCalibrationReviewError(f"{location}: record seal mismatch")
    return actual


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise StudentCalibrationReviewError(f"{location}: expected object")
    return value


def _list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise StudentCalibrationReviewError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise StudentCalibrationReviewError(f"{location}: expected text")
    return result


def _read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise StudentCalibrationReviewError(f"{location}: missing or linked file")
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StudentCalibrationReviewError(
            f"{location}: invalid JSON: {error}"
        ) from error
    return dict(_mapping(value, location))


def _safe_relative(value: Any, location: str) -> PurePosixPath:
    text = _text(value, location).replace("\\", "/")
    relative = PurePosixPath(text)
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise StudentCalibrationReviewError(f"{location}: unsafe relative path")
    return relative


def _inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    root = root.resolve()
    path = root.joinpath(*relative.parts).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise StudentCalibrationReviewError(f"{location}: path escapes root") from error
    return path


def _ordered_sha(values: Sequence[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _tier_for_candidate(judgment: Mapping[str, Any], candidate_id: str) -> str:
    for tier in labels.FONT_TIERS:
        values = judgment.get(tier)
        if isinstance(values, list) and candidate_id in values:
            return tier
    raise StudentCalibrationReviewError(
        f"candidate {candidate_id!r} is absent from reference partition"
    )


def _validate_candidate_partition(
    judgment: Mapping[str, Any], candidate_ids: Sequence[str], *, location: str
) -> None:
    flattened: list[str] = []
    for tier in labels.FONT_TIERS:
        values = _list(judgment.get(tier), f"{location}.{tier}")
        if not all(isinstance(value, str) and value for value in values):
            raise StudentCalibrationReviewError(f"{location}.{tier}: invalid IDs")
        flattened.extend(values)
    if len(flattened) != len(candidate_ids) or set(flattened) != set(candidate_ids):
        raise StudentCalibrationReviewError(
            f"{location}: incomplete candidate partition"
        )
    none = judgment.get("none_acceptable")
    positives = list(judgment["preferred"]) + list(judgment["acceptable"])
    if not isinstance(none, bool) or none != (len(positives) == 0):
        raise StudentCalibrationReviewError(f"{location}: none_acceptable drift")
    if judgment["not_reviewed"]:
        raise StudentCalibrationReviewError(f"{location}: not_reviewed must be empty")


def load_render_bank(
    manifest_path: Path,
) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str, str], dict[str, Any]]]:
    manifest = _read_json(manifest_path, "render bank manifest")
    if manifest.get("schema_version") != "font-render-bank-v1":
        raise StudentCalibrationReviewError("render bank schema is unsupported")
    canonical: dict[str, dict[str, Any]] = {}
    alias_to_id: dict[str, str] = {}
    for index, raw in enumerate(_list(manifest.get("candidates"), "render candidates")):
        candidate = dict(_mapping(raw, f"render candidate[{index}]"))
        if candidate.get("production_400_normal_canonical") is not True:
            continue
        candidate_id = _text(candidate.get("font_id"), f"candidate[{index}].font_id")
        alias = _text(candidate.get("blind_alias"), f"candidate[{index}].blind_alias")
        if candidate_id in canonical or alias in alias_to_id:
            raise StudentCalibrationReviewError("canonical render candidate duplicated")
        canonical[candidate_id] = candidate
        alias_to_id[alias] = candidate_id
    if tuple(canonical) != EXPECTED_CANDIDATE_IDS:
        raise StudentCalibrationReviewError(
            "render bank is not the pinned student22 set"
        )
    renders: dict[tuple[str, str, str], dict[str, Any]] = {}
    for index, raw in enumerate(_list(manifest.get("renders"), "render rows")):
        render = dict(_mapping(raw, f"render[{index}]"))
        candidate_id = alias_to_id.get(str(render.get("blind_alias")))
        if candidate_id is None:
            continue
        probe = _text(render.get("probe_id"), f"render[{index}].probe_id")
        writing_mode = _text(
            render.get("writing_mode"), f"render[{index}].writing_mode"
        )
        key = (candidate_id, probe, writing_mode)
        if key in renders:
            raise StudentCalibrationReviewError(f"duplicate canonical render: {key}")
        artifact = _mapping(render.get("artifact"), f"render[{index}].artifact")
        if artifact.get("file") != render.get("image_file"):
            raise StudentCalibrationReviewError("render artifact/image path drift")
        if (
            not isinstance(artifact.get("sha256"), str)
            or SHA_RE.fullmatch(str(artifact["sha256"])) is None
        ):
            raise StudentCalibrationReviewError("render artifact SHA invalid")
        renders[key] = render
    for candidate_id in EXPECTED_CANDIDATE_IDS:
        for probe in sorted(set(ROLE_PROBES.values())):
            if not any(
                (candidate_id, probe, mode) in renders
                for mode in ("horizontal", "vertical")
            ):
                raise StudentCalibrationReviewError(
                    f"missing canonical render: {candidate_id}/{probe}"
                )
    return canonical, renders


def load_val_reference_rows(
    *,
    finals_path: Path,
    master_manifest_path: Path,
    catalog_registry_path: Path,
    candidate_ids: Sequence[str],
    expected_count: int,
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    registry = _read_json(catalog_registry_path, "catalog registry")
    split_map_path, master_bindings = calibration.validate_master_inputs(
        master_manifest_path, catalog_registry_path, registry
    )
    val_rows, isolation = calibration.load_val_manifest(
        master_manifest_path, split_map_path
    )
    joined: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        handle = finals_path.open(encoding="utf-8")
    except OSError as error:
        raise StudentCalibrationReviewError(
            f"reference finals unavailable: {error}"
        ) from error
    with handle:
        for line_number, line in enumerate(handle, 1):
            matches = list(SAMPLE_ID_RE.finditer(line))
            if len(matches) != 1:
                raise StudentCalibrationReviewError(
                    f"reference finals:{line_number}: expected one textual sample_id"
                )
            sample_id = matches[0].group("sample_id")
            if sample_id not in val_rows:
                continue  # Never JSON-parse train/test reference rows.
            try:
                reference = dict(_mapping(json.loads(line), f"reference:{line_number}"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise StudentCalibrationReviewError(
                    f"reference:{line_number}: invalid allowlisted JSON: {error}"
                ) from error
            if sample_id in seen or reference.get("sample_id") != sample_id:
                raise StudentCalibrationReviewError(
                    f"duplicate/drifted reference: {sample_id}"
                )
            seen.add(sample_id)
            try:
                labels.validate_final_record(reference, candidate_ids=candidate_ids)
            except labels.LabelValidationError as error:
                raise StudentCalibrationReviewError(str(error)) from error
            resolution = _mapping(
                reference.get("resolution"), f"{sample_id}.resolution"
            )
            if resolution.get("kind") != "blind_agreement":
                raise StudentCalibrationReviewError(
                    f"{sample_id}: reference must remain blind_agreement-only"
                )
            manifest = dict(val_rows[sample_id])
            work = _mapping(manifest.get("work"), f"{sample_id}.work")
            page = _mapping(manifest.get("page"), f"{sample_id}.page")
            if reference.get("work_id") != work.get("id") or reference.get(
                "source_page_sha256"
            ) != page.get("source_page_sha256"):
                raise StudentCalibrationReviewError(
                    f"{sample_id}: master identity drift"
                )
            judgment = _mapping(
                reference.get("font_judgment"), f"{sample_id}.font_judgment"
            )
            _validate_candidate_partition(judgment, candidate_ids, location=sample_id)
            joined.append({"manifest": manifest, "reference": reference})
    if len(joined) != expected_count:
        raise StudentCalibrationReviewError(
            f"expected exactly {expected_count} val references, found {len(joined)}"
        )
    works = {
        str(_mapping(row["manifest"].get("work"), "work").get("id")) for row in joined
    }
    if len(works) < 3:
        raise StudentCalibrationReviewError(
            "named val review needs at least three works"
        )
    joined.sort(key=lambda row: str(row["reference"]["sample_id"]))
    return joined, master_bindings, isolation


def _render_descriptor(
    render: Mapping[str, Any], *, tier: str, font_label: str
) -> dict[str, Any]:
    artifact = _mapping(render.get("artifact"), "render artifact")
    return {
        "candidate_id": _text(render.get("blind_alias"), "render blind alias"),
        "font_label": font_label,
        "prior_tier": tier,
        "probe_id": _text(render.get("probe_id"), "render probe"),
        "writing_mode": _text(render.get("writing_mode"), "render writing mode"),
        "image": {
            "path": _text(artifact.get("file"), "render artifact file"),
            "sha256": _text(artifact.get("sha256"), "render artifact sha"),
            "width": artifact.get("width"),
            "height": artifact.get("height"),
        },
    }


def prepare_review_rows(
    joined: Sequence[Mapping[str, Any]],
    *,
    canonical_candidates: Mapping[str, Mapping[str, Any]],
    renders: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for joined_row in joined:
        manifest = _mapping(joined_row.get("manifest"), "joined.manifest")
        reference = _mapping(joined_row.get("reference"), "joined.reference")
        sample_id = _text(reference.get("sample_id"), "reference.sample_id")
        judgment = _mapping(reference.get("font_judgment"), "reference judgment")
        role = _text(
            _mapping(reference.get("role"), "role").get("primary"), "role.primary"
        )
        probe = ROLE_PROBES.get(role)
        if probe is None:
            raise StudentCalibrationReviewError(f"{sample_id}: unsupported role {role}")
        orientation = _text(
            _mapping(reference.get("treatment"), "treatment").get("orientation"),
            "treatment.orientation",
        )
        writing_mode = "vertical" if orientation == "vertical" else "horizontal"
        seed = sha256_bytes(
            f"manga-font-student-unblinded-order-v1\0{sample_id}".encode("utf-8")
        )
        display_order = labels.deterministic_candidate_order(
            EXPECTED_CANDIDATE_IDS, seed
        )
        candidates: list[dict[str, Any]] = []
        for candidate_id in display_order:
            render = (
                renders.get((candidate_id, probe, writing_mode))
                or renders.get((candidate_id, probe, "horizontal"))
                or renders.get((candidate_id, probe, "vertical"))
            )
            if render is None:
                raise StudentCalibrationReviewError(
                    f"{sample_id}: missing render for {candidate_id}/{probe}"
                )
            metadata = _render_descriptor(
                render,
                tier=_tier_for_candidate(judgment, candidate_id),
                font_label=_text(
                    canonical_candidates[candidate_id].get("font_label"),
                    f"{candidate_id}.font_label",
                ),
            )
            metadata["candidate_id"] = candidate_id
            candidates.append(metadata)
        prior_sha = validate_record_seal(reference, location=f"reference[{sample_id}]")
        review_id = f"student-cal-review-{sha256_bytes(f'{sample_id}\0{prior_sha}'.encode())[:24]}"
        page = _mapping(manifest.get("page"), f"{sample_id}.page")
        work = _mapping(manifest.get("work"), f"{sample_id}.work")
        row = {
            "candidate_ids": list(EXPECTED_CANDIDATE_IDS),
            "candidate_order_sha256": _ordered_sha(EXPECTED_CANDIDATE_IDS),
            "candidates": candidates,
            "display_order": list(display_order),
            "display_order_seed": seed,
            "master_row_sha256": sha256_bytes(canonical_json(manifest).encode("utf-8")),
            "page": copy.deepcopy(dict(page)),
            "record_type": RECORD_TYPE,
            "reference": {
                "authority": "blind_agreement_reference_only",
                "direct_gold_promotion_allowed": False,
                "final_record": copy.deepcopy(dict(reference)),
                "model_suggestions_visible": True,
                "training_eligible": False,
            },
            "review_id": review_id,
            "sample_id": sample_id,
            "schema_version": SCHEMA_VERSION,
            "sheet": None,
            "source": {
                "geometry": copy.deepcopy(manifest.get("geometry")),
                "views": copy.deepcopy(manifest.get("views")),
            },
            "source_page_sha256": page.get("source_page_sha256"),
            "split": "val",
            "work": copy.deepcopy(dict(work)),
            "work_id": work.get("id"),
        }
        rows.append(row)
    return rows


def _load_render_image(render_root: Path, descriptor: Mapping[str, Any]) -> Image.Image:
    image_info = _mapping(descriptor.get("image"), "candidate image")
    relative = _safe_relative(image_info.get("path"), "candidate image path")
    path = _inside(render_root, relative, "candidate image")
    expected = _text(image_info.get("sha256"), "candidate image sha")
    if path.is_symlink() or not path.is_file() or sha256_file(path) != expected:
        raise StudentCalibrationReviewError(f"render image hash mismatch: {relative}")
    try:
        with Image.open(path) as opened:
            opened.load()
            image = opened.convert("RGB")
    except (OSError, ValueError) as error:
        raise StudentCalibrationReviewError(
            f"render image decode failed: {relative}"
        ) from error
    if image.size != (image_info.get("width"), image_info.get("height")):
        image.close()
        raise StudentCalibrationReviewError(
            f"render image dimensions drifted: {relative}"
        )
    return image


def _font(size: int, font_path: Path | None) -> ImageFont.ImageFont:
    if font_path is not None:
        try:
            return ImageFont.truetype(str(font_path), size)
        except OSError:
            pass
    return ImageFont.load_default(size=max(10, size))


def _annotation_font_path(
    candidates: Mapping[str, Mapping[str, Any]], project_root: Path
) -> Path | None:
    candidate = candidates.get("nanum-gothic")
    if candidate is None:
        return None
    try:
        relative = _safe_relative(candidate.get("source_file"), "annotation font")
        path = _inside(project_root, relative, "annotation font")
    except StudentCalibrationReviewError:
        return None
    expected = candidate.get("source_sha256")
    if (
        path.is_file()
        and not path.is_symlink()
        and isinstance(expected, str)
        and sha256_file(path) == expected
    ):
        return path
    return None


def _fit_paste(
    canvas: Image.Image, source: Image.Image, box: tuple[int, int, int, int]
) -> None:
    left, top, right, bottom = box
    fitted = ImageOps.contain(
        source.convert("RGB"),
        (max(1, right - left), max(1, bottom - top)),
        Image.Resampling.LANCZOS,
    )
    x = left + (right - left - fitted.width) // 2
    y = top + (bottom - top - fitted.height) // 2
    canvas.paste(fitted, (x, y))
    fitted.close()


def render_contact_sheets(
    rows: Sequence[dict[str, Any]],
    *,
    output_dir: Path,
    render_bank_root: Path,
    catalog_registry_path: Path,
    canonical_candidates: Mapping[str, Mapping[str, Any]],
    project_root: Path,
    rows_per_sheet: int,
) -> list[dict[str, Any]]:
    if rows_per_sheet < 1 or rows_per_sheet > 16:
        raise StudentCalibrationReviewError("rows_per_sheet must be inside [1,16]")
    sheets_dir = output_dir / SHEETS_DIR
    sheets_dir.mkdir(parents=True)
    resolver = catalog_assets.CatalogAssetResolver(catalog_registry_path)
    font_path = _annotation_font_path(canonical_candidates, project_root)
    header_font = _font(30, font_path)
    body_font = _font(17, font_path)
    small_font = _font(14, font_path)
    left_width = 430
    cell_width = 170
    row_height = 300
    header_height = 92
    width = left_width + cell_width * len(EXPECTED_CANDIDATE_IDS)
    descriptors: list[dict[str, Any]] = []
    for sheet_index, start in enumerate(range(0, len(rows), rows_per_sheet), 1):
        chunk = rows[start : start + rows_per_sheet]
        canvas = Image.new(
            "RGB", (width, header_height + row_height * len(chunk)), (246, 247, 249)
        )
        draw = ImageDraw.Draw(canvas)
        draw.text(
            (20, 12),
            "STUDENT22 CALIBRATION — NAMED HUMAN REVIEW (VAL ONLY)",
            fill=(20, 25, 33),
            font=header_font,
        )
        draw.text(
            (20, 54),
            "Colored borders are prior blind-agreement references only; inspect every named font.",
            fill=(160, 36, 36),
            font=body_font,
        )
        for local_index, row in enumerate(chunk):
            top = header_height + local_index * row_height
            bottom = top + row_height
            draw.rectangle(
                (0, top, width - 1, bottom - 1), outline=(190, 194, 201), width=2
            )
            draw.text(
                (12, top + 8),
                f"{start + local_index + 1:02d}  {row['sample_id']}  role={row['reference']['final_record']['role']['primary']}",
                fill=(25, 28, 34),
                font=body_font,
            )
            views: dict[str, Image.Image] = {}
            for view_name in VIEW_NAMES:
                try:
                    with resolver.resolve_view_descriptor(
                        row["source"]["views"][view_name],
                        sample_id=row["sample_id"],
                        view_name=view_name,
                        location=f"{row['sample_id']}.views.{view_name}",
                    ) as resolved:
                        views[view_name] = resolved.image.copy()
                except catalog_assets.CatalogAssetError as error:
                    raise StudentCalibrationReviewError(str(error)) from error
            _fit_paste(canvas, views["raw_224"], (12, top + 42, 216, bottom - 12))
            _fit_paste(canvas, views["context_224"], (225, top + 42, 420, top + 165))
            _fit_paste(canvas, views["glyph_224"], (225, top + 170, 420, bottom - 12))
            for image in views.values():
                image.close()
            for candidate_index, candidate in enumerate(row["candidates"]):
                left = left_width + candidate_index * cell_width
                tier = candidate["prior_tier"]
                color = TIER_COLORS[tier]
                draw.rectangle(
                    (left + 3, top + 4, left + cell_width - 4, bottom - 5),
                    fill=(255, 255, 255),
                    outline=color,
                    width=5 if tier in {"preferred", "acceptable"} else 2,
                )
                draw.text(
                    (left + 10, top + 13),
                    candidate["candidate_id"][:24],
                    fill=(20, 23, 28),
                    font=small_font,
                )
                draw.text(
                    (left + 10, top + 36),
                    candidate["font_label"][:18],
                    fill=(45, 48, 55),
                    font=small_font,
                )
                render = _load_render_image(render_bank_root, candidate)
                _fit_paste(
                    canvas,
                    render,
                    (left + 9, top + 66, left + cell_width - 10, bottom - 42),
                )
                render.close()
                draw.text(
                    (left + 10, bottom - 32),
                    f"prior: {tier}",
                    fill=color,
                    font=small_font,
                )
        relative = f"{SHEETS_DIR}/sheet-{sheet_index:03d}.png"
        path = output_dir / Path(relative)
        canvas.save(path, format="PNG", optimize=False, compress_level=9)
        canvas.close()
        descriptor = {
            "file": relative,
            "row_count": len(chunk),
            "sha256": sha256_file(path),
            "width": width,
            "height": header_height + row_height * len(chunk),
        }
        descriptors.append(descriptor)
        for local_index, row in enumerate(chunk):
            row["sheet"] = {
                "file": relative,
                "row_index": local_index,
                "sha256": descriptor["sha256"],
            }
    return descriptors


def _decision_template(row: Mapping[str, Any]) -> dict[str, Any]:
    reference = _mapping(row.get("reference"), "review reference")
    final = _mapping(reference.get("final_record"), "reference final")
    sample_id = _text(row.get("sample_id"), "review sample id")
    return {
        "confidence": None,
        "decision_id": f"named-review-{sha256_bytes(sample_id.encode())[:24]}",
        "decision_status": "pending",
        "font_judgment": copy.deepcopy(final["font_judgment"]),
        "notes": "",
        "record_type": DECISION_RECORD_TYPE,
        "review_id": row["review_id"],
        "review_item_sha256": row["record_sha256"],
        "review_sheet_acknowledged": False,
        "reviewed_at": None,
        "reviewer": None,
        "sample_id": sample_id,
        "schema_version": DECISION_SCHEMA_VERSION,
    }


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    payload = "".join(canonical_json(row) + "\n" for row in rows).encode("utf-8")
    path.write_bytes(payload)


def validate_review_record(record: Mapping[str, Any]) -> None:
    validate_record_seal(record, location="review item")
    required = {
        "candidate_ids",
        "candidate_order_sha256",
        "candidates",
        "display_order",
        "display_order_seed",
        "master_row_sha256",
        "page",
        "record_sha256",
        "record_type",
        "reference",
        "review_id",
        "sample_id",
        "schema_version",
        "sheet",
        "source",
        "source_page_sha256",
        "split",
        "work",
        "work_id",
    }
    if set(record) != required:
        raise StudentCalibrationReviewError("review item schema drift")
    if (
        record.get("schema_version") != SCHEMA_VERSION
        or record.get("record_type") != RECORD_TYPE
        or record.get("split") != "val"
        or tuple(record.get("candidate_ids", [])) != EXPECTED_CANDIDATE_IDS
        or record.get("candidate_order_sha256") != _ordered_sha(EXPECTED_CANDIDATE_IDS)
    ):
        raise StudentCalibrationReviewError("review item boundary drift")
    seed = _text(record.get("display_order_seed"), "display order seed")
    order = tuple(_list(record.get("display_order"), "display order"))
    if order != labels.deterministic_candidate_order(EXPECTED_CANDIDATE_IDS, seed):
        raise StudentCalibrationReviewError("review display order drift")
    candidates = _list(record.get("candidates"), "review candidates")
    if [candidate.get("candidate_id") for candidate in candidates] != list(order):
        raise StudentCalibrationReviewError("review candidate/display order mismatch")
    reference = _mapping(record.get("reference"), "review reference")
    if (
        reference.get("authority") != "blind_agreement_reference_only"
        or reference.get("direct_gold_promotion_allowed") is not False
        or reference.get("training_eligible") is not False
        or reference.get("model_suggestions_visible") is not True
    ):
        raise StudentCalibrationReviewError("blind reference authority was elevated")
    final = _mapping(reference.get("final_record"), "reference final")
    try:
        labels.validate_final_record(final, candidate_ids=EXPECTED_CANDIDATE_IDS)
    except labels.LabelValidationError as error:
        raise StudentCalibrationReviewError(str(error)) from error
    if (
        _mapping(final.get("resolution"), "reference resolution").get("kind")
        != "blind_agreement"
    ):
        raise StudentCalibrationReviewError("review reference is not blind_agreement")


def validate_review_bundle(output_dir: Path) -> dict[str, Any]:
    root = output_dir.expanduser().resolve()
    report = _read_json(root / REPORT_FILE, "review report")
    validate_record_seal(report, location="review report")
    if (
        report.get("schema_version") != SCHEMA_VERSION
        or report.get("record_type") != REPORT_TYPE
    ):
        raise StudentCalibrationReviewError("review report schema drift")
    boundary = _mapping(report.get("boundary"), "review boundary")
    if (
        boundary.get("split") != "val"
        or boundary.get("test_label_rows_json_parsed") != 0
        or boundary.get("test_pixels_opened") != 0
        or boundary.get("reference_authority") != "blind_agreement_reference_only"
    ):
        raise StudentCalibrationReviewError("review test/gold boundary drift")
    marker = _read_json(root / MARKER_FILE, "review marker")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("safe_replace") is not True
        or marker.get("report_sha256") != sha256_file(root / REPORT_FILE)
    ):
        raise StudentCalibrationReviewError("review marker drift")
    artifacts = _mapping(report.get("artifacts"), "review artifacts")
    expected_files = {
        REPORT_FILE,
        MARKER_FILE,
        REVIEW_INPUT_FILE,
        DECISION_TEMPLATE_FILE,
    }
    sheets = _list(report.get("sheets"), "review sheets")
    for sheet in sheets:
        descriptor = _mapping(sheet, "sheet descriptor")
        relative = _safe_relative(descriptor.get("file"), "sheet file")
        path = _inside(root, relative, "sheet file")
        if sha256_file(path) != descriptor.get("sha256"):
            raise StudentCalibrationReviewError("contact sheet hash drift")
        expected_files.add(relative.as_posix())
    actual_files = {
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    }
    if actual_files != expected_files:
        raise StudentCalibrationReviewError("review bundle exact inventory drift")
    for name in (REVIEW_INPUT_FILE, DECISION_TEMPLATE_FILE):
        descriptor = _mapping(artifacts.get(name), f"artifact {name}")
        if descriptor.get("file") != name or descriptor.get("sha256") != sha256_file(
            root / name
        ):
            raise StudentCalibrationReviewError(f"review artifact hash drift: {name}")
    rows: list[dict[str, Any]] = []
    with (root / REVIEW_INPUT_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = dict(_mapping(json.loads(line), f"review input:{line_number}"))
            except json.JSONDecodeError as error:
                raise StudentCalibrationReviewError(
                    f"review input:{line_number}: invalid JSON"
                ) from error
            validate_review_record(row)
            rows.append(row)
    if len(rows) != boundary.get("sample_count") or len(rows) != len(
        {row["sample_id"] for row in rows}
    ):
        raise StudentCalibrationReviewError("review row count/identity drift")
    sheet_hashes = {str(sheet["file"]): str(sheet["sha256"]) for sheet in sheets}
    for row in rows:
        sheet = _mapping(row.get("sheet"), "review item sheet")
        if sheet_hashes.get(str(sheet.get("file"))) != sheet.get("sha256"):
            raise StudentCalibrationReviewError("review item sheet binding drift")
    return {
        "candidate_count": len(EXPECTED_CANDIDATE_IDS),
        "output_dir": str(root),
        "record_count": len(rows),
        "rows": rows,
        "status": "ready_for_named_human_review",
    }


def _safe_output(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(resolved.anchor)}
    if resolved in forbidden or len(resolved.parts) < 3 or len(resolved.name) < 3:
        raise StudentCalibrationReviewError(f"unsafe output directory: {resolved}")
    return resolved


def build_review_bundle(
    *,
    finals_path: Path,
    master_manifest_path: Path,
    catalog_registry_path: Path,
    render_bank_manifest_path: Path,
    output_dir: Path,
    project_root: Path,
    expected_count: int = 33,
    rows_per_sheet: int = 11,
    replace_owned_output: bool = False,
) -> dict[str, Any]:
    if expected_count < 1:
        raise StudentCalibrationReviewError("expected_count must be positive")
    target = _safe_output(output_dir)
    if target.exists():
        if not replace_owned_output:
            raise StudentCalibrationReviewError(
                "output exists; pass --replace-owned-output"
            )
        validate_review_bundle(target)
    canonical_candidates, renders = load_render_bank(render_bank_manifest_path)
    joined, master_bindings, isolation = load_val_reference_rows(
        finals_path=finals_path,
        master_manifest_path=master_manifest_path,
        catalog_registry_path=catalog_registry_path,
        candidate_ids=EXPECTED_CANDIDATE_IDS,
        expected_count=expected_count,
    )
    rows = prepare_review_rows(
        joined, canonical_candidates=canonical_candidates, renders=renders
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        sheets = render_contact_sheets(
            rows,
            output_dir=staging,
            render_bank_root=render_bank_manifest_path.parent,
            catalog_registry_path=catalog_registry_path,
            canonical_candidates=canonical_candidates,
            project_root=project_root,
            rows_per_sheet=rows_per_sheet,
        )
        sealed_rows = [seal_record(row) for row in rows]
        for row in sealed_rows:
            validate_review_record(row)
        decisions = [_decision_template(row) for row in sealed_rows]
        _write_jsonl(staging / REVIEW_INPUT_FILE, sealed_rows)
        _write_jsonl(staging / DECISION_TEMPLATE_FILE, decisions)
        report = seal_record(
            {
                "artifacts": {
                    name: {"file": name, "sha256": sha256_file(staging / name)}
                    for name in (REVIEW_INPUT_FILE, DECISION_TEMPLATE_FILE)
                },
                "boundary": {
                    "allowed_resolution_kinds_after_human_review": [
                        "adjudicated",
                        "primary",
                    ],
                    "reference_authority": "blind_agreement_reference_only",
                    "sample_count": len(sealed_rows),
                    "split": "val",
                    "test_label_rows_json_parsed": 0,
                    "test_pixels_opened": 0,
                    "training_eligible_rows": 0,
                },
                "candidate_count": len(EXPECTED_CANDIDATE_IDS),
                "candidate_ids": list(EXPECTED_CANDIDATE_IDS),
                "candidate_order_sha256": _ordered_sha(EXPECTED_CANDIDATE_IDS),
                "inputs": {
                    **master_bindings,
                    "reference_finals_sha256": sha256_file(finals_path),
                    "render_bank_manifest_sha256": sha256_file(
                        render_bank_manifest_path
                    ),
                },
                "isolation": copy.deepcopy(isolation),
                "record_type": REPORT_TYPE,
                "schema_version": SCHEMA_VERSION,
                "sheets": sheets,
            }
        )
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = {
            "owner": OWNER,
            "report_sha256": sha256_file(staging / REPORT_FILE),
            "safe_replace": True,
            "schema_version": SCHEMA_VERSION,
        }
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_review_bundle(staging)
        if target.exists():
            validate_review_bundle(target)
            shutil.rmtree(target)
        os.replace(staging, target)
        return validate_review_bundle(target)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--reference-finals", type=Path, required=True)
    build.add_argument("--master-manifest", type=Path, required=True)
    build.add_argument("--catalog-registry", type=Path, required=True)
    build.add_argument("--render-bank-manifest", type=Path, required=True)
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--project-root", type=Path, default=Path("."))
    build.add_argument("--expected-count", type=int, default=33)
    build.add_argument("--rows-per-sheet", type=int, default=11)
    build.add_argument("--replace-owned-output", action="store_true")
    validate = sub.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = build_review_bundle(
                finals_path=args.reference_finals.resolve(),
                master_manifest_path=args.master_manifest.resolve(),
                catalog_registry_path=args.catalog_registry.resolve(),
                render_bank_manifest_path=args.render_bank_manifest.resolve(),
                output_dir=args.output_dir,
                project_root=args.project_root.resolve(),
                expected_count=args.expected_count,
                rows_per_sheet=args.rows_per_sheet,
                replace_owned_output=args.replace_owned_output,
            )
        else:
            result = validate_review_bundle(args.output_dir)
    except StudentCalibrationReviewError as error:
        raise SystemExit(f"student-calibration-review error: {error}") from error
    public = {key: value for key, value in result.items() if key != "rows"}
    print(canonical_json(public))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
