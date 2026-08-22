#!/usr/bin/env python3
"""Train the independent MangaFont GlyphVoice local matcher and VoiceSet.

The trainer consumes the glyph-verified synthetic corpus, the active Korean
candidate render bank, and the sealed 1,347-row AI visual supervision set.  It
does not initialize from or import the production font ranker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image
from safetensors.torch import load_file, save_file
from torch import Tensor, nn
from torch.nn import functional as F

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import manga_font_glyphvoice_v1_model as glyphvoice  # noqa: E402
import train_manga_font_student_v8_role_family_adapter as teacher_v8  # noqa: E402


SCHEMA_VERSION = "manga-font-glyphvoice-training-v5"
OWNER = "carrot-manga-translator/manga-font-glyphvoice-training-v5"
MARKER = ".manga-font-glyphvoice-training-v5-owned.json"
MANIFEST = "manifest.json"
LOCAL_CHECKPOINT = "glyphvoice-local.safetensors"
VOICE_CHECKPOINT = "glyphvoice-voiceset.safetensors"

DEFAULT_CORPUS = Path("artifacts/manga-font-glyphvoice-bridge-corpus-v3")
DEFAULT_RENDER_BANK = Path("datasets/fontclip-font-render-bank-v2")
DEFAULT_ROLE_DATASET = Path(
    "artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout/role-family-dataset.npz"
)
DEFAULT_LABEL_DIR = Path(
    "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-1600-training-only-r1"
)
DEFAULT_MASTER = Path("datasets/font-matching-master-v3")
DEFAULT_SPLIT_OVERLAY = Path(
    "artifacts/manga-font-v3-page-consistency-overlay-training-only-v1-r2"
)
DEFAULT_TEACHER = Path(
    "artifacts/manga-font-student-v81-role-family-adapter-production-r3h/role-family-adapter.safetensors"
)

PROTOTYPE_PROBES = (
    "dialogue-body",
    "aside-whisper",
    "emphasis-shout",
    "narration",
)


class GlyphVoiceTrainingError(RuntimeError):
    pass


@dataclass(frozen=True)
class SyntheticRow:
    sample_id: str
    face_id: str
    family_id: str
    script: str
    split: str
    category: str
    image_path: Path


@dataclass(frozen=True)
class CandidateRow:
    candidate_id: str
    display_id: str
    render_paths: tuple[Path, ...]
    query_paths: tuple[Path, ...]


@dataclass(frozen=True)
class RealRow:
    sample_id: str
    work_id: str
    page_id: str
    chapter_id: str
    family: str
    role: str
    supervision_weight: float
    raw_path: Path
    glyph_path: Path
    context_path: Path
    eligible: tuple[bool, ...]
    positive: tuple[bool, ...]
    preferred: tuple[bool, ...]
    split: str


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _descriptor(path: Path) -> Mapping[str, Any]:
    path = path.expanduser().absolute().resolve()
    return {
        "file": path.as_posix(),
        "byte_size": path.stat().st_size,
        "sha256": _sha256_file(path),
    }


def _output_descriptor(path: Path) -> Mapping[str, Any]:
    return {
        "file": path.name,
        "byte_size": path.stat().st_size,
        "sha256": _sha256_file(path),
    }


def _read_json(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise GlyphVoiceTrainingError(f"cannot read JSON: {path}") from error
    if not isinstance(value, Mapping):
        raise GlyphVoiceTrainingError(f"JSON root is not an object: {path}")
    return value


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, Mapping):
                    raise GlyphVoiceTrainingError(
                        f"JSONL row is not an object: {path}:{line_number}"
                    )
                rows.append(value)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise GlyphVoiceTrainingError(f"cannot read JSONL: {path}") from error
    return rows


def _assert_regular_file(path: Path, name: str) -> Path:
    absolute = path.expanduser().absolute()
    if absolute.is_symlink() or not absolute.is_file():
        raise GlyphVoiceTrainingError(f"{name} is not a regular file: {absolute}")
    return absolute.resolve()


def _resolve_dataset_asset(
    catalog_id: str,
    relative_path: str,
    catalog_roots: Mapping[str, Path],
) -> Path:
    if not catalog_id or not relative_path:
        raise GlyphVoiceTrainingError("dataset asset binding is empty")
    if catalog_id not in catalog_roots:
        raise GlyphVoiceTrainingError(f"unknown master catalog ID: {catalog_id}")
    candidate = catalog_roots[catalog_id] / Path(relative_path)
    return _assert_regular_file(candidate, "dataset asset")


def _canonical_ink(path: Path, size: int = glyphvoice.INPUT_SIZE) -> Tensor:
    with Image.open(path) as image:
        grayscale = image.convert("L")
        values = np.asarray(grayscale, dtype=np.uint8)
        if values.size == 0:
            raise GlyphVoiceTrainingError(f"empty image: {path}")
        ink_mask = values < 247
        coordinates = np.argwhere(ink_mask)
        if coordinates.size == 0:
            raise GlyphVoiceTrainingError(f"image has no ink: {path}")
        minimum_y, minimum_x = coordinates.min(axis=0)
        maximum_y, maximum_x = coordinates.max(axis=0) + 1
        padding = max(
            2, round(max(maximum_x - minimum_x, maximum_y - minimum_y) * 0.035)
        )
        minimum_x = max(0, int(minimum_x) - padding)
        minimum_y = max(0, int(minimum_y) - padding)
        maximum_x = min(grayscale.width, int(maximum_x) + padding)
        maximum_y = min(grayscale.height, int(maximum_y) + padding)
        cropped = grayscale.crop((minimum_x, minimum_y, maximum_x, maximum_y))
        target = round(size * 0.88)
        scale = min(target / cropped.width, target / cropped.height)
        resized = cropped.resize(
            (
                max(1, round(cropped.width * scale)),
                max(1, round(cropped.height * scale)),
            ),
            Image.Resampling.LANCZOS,
        )
        canvas = Image.new("L", (size, size), 255)
        x = (size - resized.width) // 2
        y = (size - resized.height) // 2
        canvas.paste(resized, (x, y))
        values = np.asarray(canvas, dtype=np.uint8).copy()
    return torch.from_numpy(255 - values)


def _glyph_views(path: Path) -> Tensor:
    ink = _canonical_ink(path)
    base = ink.float()[None, None]
    dilated = F.max_pool2d(base, 3, stride=1, padding=1)
    blurred = F.avg_pool2d(base, 5, stride=1, padding=2)
    return torch.stack(
        (
            ink,
            dilated[0, 0].round().clamp(0, 255).to(torch.uint8),
            blurred[0, 0].round().clamp(0, 255).to(torch.uint8),
        ),
        dim=0,
    )


def _synthetic_views(path: Path) -> Tensor:
    return _glyph_views(path)


def _real_views(row: RealRow) -> Tensor:
    return _glyph_views(row.glyph_path)


def _float_inputs(values: Tensor, device: torch.device) -> Tensor:
    return values.to(device=device, dtype=torch.float32, non_blocking=False) / 255.0


def _augment_batch(inputs: Tensor, generator: torch.Generator) -> Tensor:
    batch = inputs.shape[0]
    device = inputs.device
    angles = (torch.rand(batch, generator=generator, device=device) - 0.5) * 5.0
    scales = 0.93 + torch.rand(batch, generator=generator, device=device) * 0.14
    tx = (torch.rand(batch, generator=generator, device=device) - 0.5) * 0.08
    ty = (torch.rand(batch, generator=generator, device=device) - 0.5) * 0.08
    radians = angles * (math.pi / 180.0)
    theta = torch.zeros(batch, 2, 3, device=device, dtype=inputs.dtype)
    theta[:, 0, 0] = torch.cos(radians) / scales
    theta[:, 0, 1] = -torch.sin(radians) / scales
    theta[:, 1, 0] = torch.sin(radians) / scales
    theta[:, 1, 1] = torch.cos(radians) / scales
    theta[:, 0, 2] = tx
    theta[:, 1, 2] = ty
    grid = F.affine_grid(theta, inputs.shape, align_corners=False)
    output = F.grid_sample(
        inputs, grid, mode="bilinear", padding_mode="zeros", align_corners=False
    )
    selector = torch.rand(batch, generator=generator, device=device)
    dilated = F.max_pool2d(output, 3, stride=1, padding=1)
    eroded = 1.0 - F.max_pool2d(1.0 - output, 3, stride=1, padding=1)
    output = torch.where((selector < 0.18)[:, None, None, None], dilated, output)
    output = torch.where(
        ((selector >= 0.18) & (selector < 0.32))[:, None, None, None],
        eroded,
        output,
    )
    noise = (
        torch.randn(
            output.shape, generator=generator, device=device, dtype=output.dtype
        )
        * 0.012
    )
    return (output + noise).clamp_(0.0, 1.0)


def _load_synthetic_rows(corpus_root: Path) -> list[SyntheticRow]:
    corpus_root = corpus_root.expanduser().absolute().resolve()
    manifest = _read_json(corpus_root / "manifest.json")
    if manifest.get("schema_version") != "manga-font-glyphvoice-bridge-corpus-v1":
        raise GlyphVoiceTrainingError("GlyphVoice bridge corpus schema drifted")
    rows: list[SyntheticRow] = []
    for value in _read_jsonl(corpus_root / "samples.jsonl"):
        asset = value.get("asset")
        if not isinstance(asset, Mapping):
            raise GlyphVoiceTrainingError("synthetic asset is missing")
        path = _assert_regular_file(corpus_root / str(asset["file"]), "synthetic image")
        if _sha256_file(path) != str(asset["sha256"]):
            raise GlyphVoiceTrainingError(f"synthetic image hash drifted: {path}")
        rows.append(
            SyntheticRow(
                sample_id=str(value["sample_id"]),
                face_id=str(value["face_id"]),
                family_id=str(value["family_id"]),
                script=str(value["script"]),
                split=str(value["split"]),
                category=str(value["category"]),
                image_path=path,
            )
        )
    if len(rows) != int(manifest["counts"]["sentence_sample_count"]):
        raise GlyphVoiceTrainingError("synthetic sample count drifted")
    return rows


def _load_candidate_rows(
    render_root: Path, candidate_ids: Sequence[str]
) -> list[CandidateRow]:
    render_root = render_root.expanduser().absolute().resolve()
    manifest = _read_json(render_root / "manifest.json")
    candidates = manifest.get("candidates")
    renders = manifest.get("renders")
    if not isinstance(candidates, list) or not isinstance(renders, list):
        raise GlyphVoiceTrainingError("render-bank inventory is malformed")
    result: list[CandidateRow] = []
    for candidate_id in candidate_ids:
        matches = [
            row
            for row in candidates
            if isinstance(row, Mapping)
            and str(row.get("font_id")) == candidate_id
            and row.get("production_400_normal_canonical") is True
        ]
        if len(matches) != 1:
            raise GlyphVoiceTrainingError(
                f"active candidate lacks one canonical render face: {candidate_id}"
            )
        display_id = str(matches[0]["display_id"])
        candidate_renders = [
            row
            for row in renders
            if isinstance(row, Mapping)
            and str(row.get("candidate_display_id")) == display_id
        ]
        render_path_by_id: dict[str, Path] = {}
        for render in candidate_renders:
            artifact = render.get("artifact")
            if not isinstance(artifact, Mapping):
                raise GlyphVoiceTrainingError("candidate render artifact is missing")
            path = _assert_regular_file(
                render_root / str(artifact["file"]), "candidate render"
            )
            if _sha256_file(path) != str(artifact["sha256"]):
                raise GlyphVoiceTrainingError(f"candidate render hash drifted: {path}")
            render_id = str(render.get("render_id"))
            if not render_id or render_id in render_path_by_id:
                raise GlyphVoiceTrainingError("candidate render id inventory drifted")
            render_path_by_id[render_id] = path
        selected: list[Path] = []
        for probe in PROTOTYPE_PROBES:
            options = [
                row for row in candidate_renders if str(row.get("probe_id")) == probe
            ]
            if not options:
                raise GlyphVoiceTrainingError(
                    f"candidate probe is missing: {candidate_id}/{probe}"
                )
            horizontal = [
                row for row in options if row.get("writing_mode") == "horizontal"
            ]
            vertical = [row for row in options if row.get("writing_mode") == "vertical"]
            chosen_modes = (
                horizontal[0] if horizontal else vertical[0],
                vertical[0] if vertical else horizontal[0],
            )
            for chosen in chosen_modes:
                selected.append(render_path_by_id[str(chosen["render_id"])])
        selected_unique = {path.resolve() for path in selected}
        query_paths = tuple(
            path
            for _render_id, path in sorted(render_path_by_id.items())
            if path.resolve() not in selected_unique
        )
        if len(query_paths) < 4:
            raise GlyphVoiceTrainingError(
                f"candidate held-out render inventory is too small: {candidate_id}"
            )
        result.append(
            CandidateRow(candidate_id, display_id, tuple(selected), query_paths)
        )
    return result


def _view_asset_path(
    view: Mapping[str, Any],
    *,
    raw: bool,
    catalog_roots: Mapping[str, Path],
) -> Path:
    source: Mapping[str, Any]
    if raw:
        nested = view.get("source_native")
        source = nested if isinstance(nested, Mapping) else view
    else:
        source = view
    if source.get("status") != "available":
        raise GlyphVoiceTrainingError("required real view is unavailable")
    return _resolve_dataset_asset(
        str(source["catalog_id"]), str(source["path"]), catalog_roots
    )


def _load_real_rows(
    label_root: Path,
    master_root: Path,
    split_overlay_root: Path,
    candidate_ids: Sequence[str],
) -> list[RealRow]:
    label_root = label_root.expanduser().absolute().resolve()
    labels = _read_jsonl(label_root / "training-labels.jsonl")
    if len(labels) != 1347:
        raise GlyphVoiceTrainingError("expected exactly 1,347 direct visual labels")
    labels_by_id = {str(row["sample_id"]): row for row in labels}
    if len(labels_by_id) != len(labels):
        raise GlyphVoiceTrainingError(
            "direct visual labels contain duplicate sample IDs"
        )
    split_manifest = _read_json(split_overlay_root / "manifest.json")
    split_contract = split_manifest.get("split")
    if not isinstance(split_contract, Mapping):
        raise GlyphVoiceTrainingError("direct-label work split is missing")
    train_works = {str(value) for value in split_contract["train_work_ids"]}
    development_works = {
        str(value) for value in split_contract["development_eval_work_ids"]
    }
    if train_works & development_works or (
        len(train_works),
        len(development_works),
    ) != (10, 3):
        raise GlyphVoiceTrainingError("direct-label work split drifted")

    master_report = _read_json(master_root / "report.json")
    report_inputs = master_report.get("inputs")
    attestation = (
        report_inputs.get("attestation") if isinstance(report_inputs, Mapping) else None
    )
    catalog_rows = (
        attestation.get("catalogs") if isinstance(attestation, Mapping) else None
    )
    if not isinstance(catalog_rows, list):
        raise GlyphVoiceTrainingError("master catalog root attestation is missing")
    catalog_roots: dict[str, Path] = {}
    for catalog in catalog_rows:
        if not isinstance(catalog, Mapping):
            raise GlyphVoiceTrainingError("master catalog attestation is malformed")
        catalog_id = str(catalog["catalog_id"])
        root = Path(str(catalog["root"])).expanduser().absolute()
        if root.is_symlink() or not root.is_dir():
            raise GlyphVoiceTrainingError(f"master catalog root is invalid: {root}")
        catalog_roots[catalog_id] = root.resolve()

    master_rows: dict[str, Mapping[str, Any]] = {}
    manifest_path = master_root / "manifest.jsonl"
    try:
        with manifest_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                value = json.loads(line)
                sample_id = str(value.get("id", ""))
                if sample_id in labels_by_id:
                    master_rows[sample_id] = value
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise GlyphVoiceTrainingError("cannot scan font master manifest") from error
    if set(master_rows) != set(labels_by_id):
        missing = sorted(set(labels_by_id) - set(master_rows))[:5]
        raise GlyphVoiceTrainingError(
            f"direct labels escaped the master manifest: {missing}"
        )

    candidate_index = {
        candidate: index for index, candidate in enumerate(candidate_ids)
    }

    def mask(values: Iterable[Any]) -> tuple[bool, ...]:
        output = [False] * len(candidate_ids)
        for value in values:
            candidate = str(value)
            if candidate not in candidate_index:
                raise GlyphVoiceTrainingError(
                    f"label candidate escaped active inventory: {candidate}"
                )
            output[candidate_index[candidate]] = True
        return tuple(output)

    result: list[RealRow] = []
    for sample_id, label in labels_by_id.items():
        master = master_rows[sample_id]
        views = master.get("views")
        if not isinstance(views, Mapping):
            raise GlyphVoiceTrainingError("master views are missing")
        identity = label.get("identity")
        candidate_labels = label.get("candidate_labels")
        if not isinstance(identity, Mapping) or not isinstance(
            candidate_labels, Mapping
        ):
            raise GlyphVoiceTrainingError("direct label contract is malformed")
        work_id = str(identity["work_id"])
        if work_id in train_works:
            split = "train"
        elif work_id in development_works:
            split = "development"
        else:
            raise GlyphVoiceTrainingError("direct-label work escaped its sealed split")
        eligible = mask(candidate_labels["eligible_candidate_ids"])
        positive = mask(candidate_labels["positive_candidate_ids"])
        preferred = mask(candidate_labels["preferred_candidate_ids"])
        if not any(positive) or not set(np.flatnonzero(positive)) <= set(
            np.flatnonzero(eligible)
        ):
            raise GlyphVoiceTrainingError(
                "direct positive candidates escaped eligibility"
            )
        if not set(np.flatnonzero(preferred)) <= set(np.flatnonzero(positive)):
            raise GlyphVoiceTrainingError(
                "direct preferred candidates escaped positive set"
            )
        raw_view = views.get("raw_224")
        glyph_view = views.get("glyph_224")
        context_view = views.get("context_224")
        if not all(
            isinstance(value, Mapping) for value in (raw_view, glyph_view, context_view)
        ):
            raise GlyphVoiceTrainingError("required real view descriptor is missing")
        result.append(
            RealRow(
                sample_id=sample_id,
                work_id=work_id,
                page_id=str(identity["page_id"]),
                chapter_id=str(identity["chapter_id"]),
                family=str(label["family"]),
                role=str(label["role"]),
                supervision_weight=float(label["supervision_weight"]),
                raw_path=_view_asset_path(
                    raw_view, raw=True, catalog_roots=catalog_roots
                ),
                glyph_path=_view_asset_path(
                    glyph_view, raw=False, catalog_roots=catalog_roots
                ),
                context_path=_view_asset_path(
                    context_view, raw=False, catalog_roots=catalog_roots
                ),
                eligible=eligible,
                positive=positive,
                preferred=preferred,
                split=split,
            )
        )
    result.sort(key=lambda row: row.sample_id)
    return result


def _load_teacher_scores(
    role_dataset_path: Path,
    real_rows: Sequence[RealRow],
    candidate_ids: Sequence[str],
    checkpoint_path: Path,
) -> Tensor:
    checkpoint_path = _assert_regular_file(checkpoint_path, "teacher checkpoint")
    arrays = np.load(role_dataset_path, allow_pickle=False)
    try:
        dataset_candidates = tuple(
            str(value) for value in arrays["candidate_ids"].tolist()
        )
        if dataset_candidates != tuple(candidate_ids):
            raise GlyphVoiceTrainingError("teacher candidate order drifted")
        sample_ids = [str(value) for value in arrays["sample_ids"].tolist()]
        sample_index = {sample_id: index for index, sample_id in enumerate(sample_ids)}
        try:
            selected = [sample_index[row.sample_id] for row in real_rows]
        except KeyError as error:
            raise GlyphVoiceTrainingError(
                "direct row escaped teacher role dataset"
            ) from error
        query_views = np.asarray(arrays["query_views"][selected], dtype=np.float32)
        prototypes = np.asarray(arrays["prototype_queries"], dtype=np.float32)
    finally:
        arrays.close()
    model = teacher_v8.build_role_family_adapter(
        torch, candidate_count=len(candidate_ids)
    )
    state = load_file(str(checkpoint_path), device="cpu")
    try:
        model.load_state_dict(state, strict=True)
    except (RuntimeError, ValueError) as error:
        raise GlyphVoiceTrainingError(
            "teacher checkpoint architecture drifted"
        ) from error
    model.eval()
    prototype_tensor = torch.from_numpy(prototypes)
    parts: list[Tensor] = []
    with torch.inference_mode():
        for start in range(0, len(query_views), 256):
            outputs = model(
                torch.from_numpy(query_views[start : start + 256]),
                prototype_tensor,
            )
            parts.append(outputs["candidate_scores"].float().cpu())
    scores = torch.cat(parts)
    if (
        scores.shape != (len(real_rows), len(candidate_ids))
        or not torch.isfinite(scores).all()
    ):
        raise GlyphVoiceTrainingError("teacher score inventory drifted")
    return scores


def _load_context(args: argparse.Namespace) -> Mapping[str, Any]:
    role_dataset_path = _assert_regular_file(args.role_dataset, "role-family dataset")
    arrays = np.load(role_dataset_path, allow_pickle=False)
    try:
        candidate_ids = tuple(str(value) for value in arrays["candidate_ids"].tolist())
    finally:
        arrays.close()
    if len(candidate_ids) != 21 or len(set(candidate_ids)) != 21:
        raise GlyphVoiceTrainingError("active candidate inventory drifted")
    synthetic_rows = _load_synthetic_rows(args.corpus_dir)
    candidate_rows = _load_candidate_rows(args.render_bank_dir, candidate_ids)
    real_rows = _load_real_rows(
        args.label_dir,
        args.master_dir,
        args.split_overlay_dir,
        candidate_ids,
    )
    teacher_scores = _load_teacher_scores(
        role_dataset_path,
        real_rows,
        candidate_ids,
        args.teacher_checkpoint,
    )
    return {
        "candidate_ids": candidate_ids,
        "candidate_rows": candidate_rows,
        "real_rows": real_rows,
        "synthetic_rows": synthetic_rows,
        "teacher_scores": teacher_scores,
        "sources": {
            "corpus_manifest": _descriptor(args.corpus_dir / "manifest.json"),
            "direct_labels": _descriptor(args.label_dir / "training-labels.jsonl"),
            "master_report": _descriptor(args.master_dir / "report.json"),
            "render_manifest": _descriptor(args.render_bank_dir / "manifest.json"),
            "role_dataset": _descriptor(role_dataset_path),
            "split_manifest": _descriptor(args.split_overlay_dir / "manifest.json"),
            "teacher_checkpoint": _descriptor(args.teacher_checkpoint),
        },
    }


def _materialize_banks(context: Mapping[str, Any]) -> Mapping[str, Tensor]:
    started = time.perf_counter()
    synthetic_rows: Sequence[SyntheticRow] = context["synthetic_rows"]
    candidate_rows: Sequence[CandidateRow] = context["candidate_rows"]
    real_rows: Sequence[RealRow] = context["real_rows"]
    print(f"materializing synthetic images: {len(synthetic_rows)}", flush=True)
    synthetic = torch.stack(
        [_synthetic_views(row.image_path) for row in synthetic_rows]
    )
    print(
        f"materializing candidate renders: {len(candidate_rows)}x"
        f"{len(candidate_rows[0].render_paths)}",
        flush=True,
    )
    candidate = torch.stack(
        [
            torch.stack([_synthetic_views(path) for path in row.render_paths])
            for row in candidate_rows
        ]
    )
    candidate_queries = torch.stack(
        [_synthetic_views(path) for row in candidate_rows for path in row.query_paths]
    )
    candidate_query_targets = torch.tensor(
        [
            candidate_index
            for candidate_index, row in enumerate(candidate_rows)
            for _path in row.query_paths
        ],
        dtype=torch.long,
    )
    print(f"materializing real labeled views: {len(real_rows)}", flush=True)
    real = torch.stack([_real_views(row) for row in real_rows])
    for name, values in (
        ("synthetic", synthetic),
        ("candidate", candidate),
        ("candidate_queries", candidate_queries),
        ("real", real),
    ):
        if values.dtype != torch.uint8 or values.shape[-2:] != (
            glyphvoice.INPUT_SIZE,
            glyphvoice.INPUT_SIZE,
        ):
            raise GlyphVoiceTrainingError(f"{name} image bank drifted")
    print(f"image banks ready in {time.perf_counter() - started:.1f}s", flush=True)
    if (
        candidate_query_targets.ndim != 1
        or len(candidate_query_targets) != len(candidate_queries)
        or set(candidate_query_targets.tolist()) != set(range(len(candidate_rows)))
    ):
        raise GlyphVoiceTrainingError("candidate query target inventory drifted")
    return {
        "synthetic": synthetic,
        "candidate": candidate,
        "candidate_queries": candidate_queries,
        "candidate_query_targets": candidate_query_targets,
        "real": real,
    }


def _context_summary(context: Mapping[str, Any]) -> Mapping[str, Any]:
    synthetic: Sequence[SyntheticRow] = context["synthetic_rows"]
    real: Sequence[RealRow] = context["real_rows"]
    return {
        "candidate_count": len(context["candidate_ids"]),
        "candidate_render_count": sum(
            len(row.render_paths) for row in context["candidate_rows"]
        ),
        "candidate_query_render_count": sum(
            len(row.query_paths) for row in context["candidate_rows"]
        ),
        "candidate_query_render_min_per_candidate": min(
            len(row.query_paths) for row in context["candidate_rows"]
        ),
        "real_development_rows": sum(row.split == "development" for row in real),
        "real_page_count": len({row.page_id for row in real}),
        "real_rows": len(real),
        "real_train_rows": sum(row.split == "train" for row in real),
        "real_work_count": len({row.work_id for row in real}),
        "synthetic_bridge_faces": len(
            {row.face_id for row in synthetic if row.category == "cross_script_bridge"}
        ),
        "synthetic_faces": len({row.face_id for row in synthetic}),
        "synthetic_rows": len(synthetic),
        "synthetic_split_faces": {
            split: len({row.face_id for row in synthetic if row.split == split})
            for split in ("train", "validation", "test")
        },
    }


def _synthetic_groups(
    rows: Sequence[SyntheticRow], *, split: str
) -> Mapping[str, list[int]]:
    groups: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        if row.split == split:
            groups[row.face_id].append(index)
    return groups


def _sample_synthetic_pair_indices(
    rows: Sequence[SyntheticRow],
    groups: Mapping[str, Sequence[int]],
    *,
    face_count: int,
    rng: random.Random,
) -> list[int]:
    faces = tuple(groups)
    bridge_faces = tuple(
        face
        for face, indices in groups.items()
        if {rows[index].script for index in indices} == {"japanese", "korean"}
    )
    selected: list[str] = []
    bridge_target = min(len(bridge_faces), max(2, face_count // 4))
    if bridge_target:
        selected.extend(rng.sample(bridge_faces, k=bridge_target))
    remainder = face_count - len(selected)
    pool = [face for face in faces if face not in selected]
    if remainder <= len(pool):
        selected.extend(rng.sample(pool, k=remainder))
    else:
        selected.extend(rng.choices(faces, k=remainder))
    output: list[int] = []
    for face in selected:
        indices = list(groups[face])
        by_script: dict[str, list[int]] = defaultdict(list)
        for index in indices:
            by_script[rows[index].script].append(index)
        if len(by_script) == 2 and rng.random() < 0.75:
            first = rng.choice(by_script["japanese"])
            second = rng.choice(by_script["korean"])
        else:
            first, second = rng.sample(indices, k=2)
        output.extend((first, second))
    return output


@torch.inference_mode()
def _evaluate_synthetic_retrieval(
    model: glyphvoice.GlyphVoiceLocalModel,
    rows: Sequence[SyntheticRow],
    bank: Tensor,
    *,
    split: str,
    device: torch.device,
) -> Mapping[str, Any]:
    model.eval()
    groups = _synthetic_groups(rows, split=split)

    def evaluate(cohorts: Sequence[tuple[int, tuple[int, int]]]) -> float | None:
        if len(cohorts) < 2:
            return None
        query_indices = [value[0] for value in cohorts]
        prototype_indices = [index for value in cohorts for index in value[1]]
        query_tokens, query_global = model.encode(
            _float_inputs(bank[query_indices], device)
        )
        prototype_tokens, prototype_global = model.encode(
            _float_inputs(bank[prototype_indices], device)
        )
        candidate_count = len(cohorts)
        prototype_tokens = prototype_tokens.reshape(
            candidate_count, 2, glyphvoice.TOKEN_COUNT, glyphvoice.TOKEN_DIM
        )
        prototype_global = prototype_global.reshape(
            candidate_count, 2, glyphvoice.EMBED_DIM
        )
        logits = model.matcher(
            query_tokens, query_global, prototype_tokens, prototype_global
        )
        targets = torch.arange(candidate_count, device=device)
        return float((logits.argmax(dim=1) == targets).float().mean().item())

    monolingual: list[tuple[int, tuple[int, int]]] = []
    cross_script: list[tuple[int, tuple[int, int]]] = []
    for indices in groups.values():
        by_script: dict[str, list[int]] = defaultdict(list)
        for index in indices:
            by_script[rows[index].script].append(index)
        eligible = [values for values in by_script.values() if len(values) >= 3]
        if eligible:
            chosen = sorted(eligible, key=lambda values: rows[values[0]].script)[0]
            monolingual.append((chosen[0], (chosen[1], chosen[2])))
        if len(by_script["japanese"]) >= 1 and len(by_script["korean"]) >= 2:
            cross_script.append(
                (
                    by_script["japanese"][0],
                    (by_script["korean"][0], by_script["korean"][1]),
                )
            )
    mono = evaluate(monolingual)
    bridge = evaluate(cross_script)
    available = [value for value in (mono, bridge) if value is not None]
    return {
        "bridge_face_count": len(cross_script),
        "cross_script_top1": bridge,
        "face_count": len(monolingual),
        "mean_top1": float(sum(available) / len(available)) if available else None,
        "monolingual_top1": mono,
        "split": split,
    }


def _sample_candidate_query_indices(
    targets: Tensor,
    *,
    queries_per_candidate: int,
    rng: random.Random,
) -> list[int]:
    groups: dict[int, list[int]] = defaultdict(list)
    for index, target in enumerate(targets.tolist()):
        groups[int(target)].append(index)
    if set(groups) != set(range(len(groups))):
        raise GlyphVoiceTrainingError("candidate query groups are not contiguous")
    selected: list[int] = []
    for candidate_index in sorted(groups):
        values = groups[candidate_index]
        if len(values) >= queries_per_candidate:
            selected.extend(rng.sample(values, k=queries_per_candidate))
        else:
            selected.extend(values)
            selected.extend(rng.choices(values, k=queries_per_candidate - len(values)))
    rng.shuffle(selected)
    return selected


@torch.inference_mode()
def _evaluate_candidate_query_retrieval(
    model: glyphvoice.GlyphVoiceLocalModel,
    query_bank: Tensor,
    query_targets: Tensor,
    candidate_bank: Tensor,
    *,
    device: torch.device,
    batch_size: int,
) -> Mapping[str, Any]:
    model.eval()
    candidate_tokens, candidate_global = _encode_candidate_prototypes(
        model, _float_inputs(candidate_bank, device)
    )
    score_parts: list[Tensor] = []
    for start in range(0, len(query_bank), batch_size):
        query_tokens, query_global = model.encode(
            _float_inputs(query_bank[start : start + batch_size], device)
        )
        score_parts.append(
            model.matcher(
                query_tokens,
                query_global,
                candidate_tokens,
                candidate_global,
            )
            .float()
            .cpu()
        )
    scores = torch.cat(score_parts)
    predictions = scores.argmax(dim=1)
    targets = query_targets.cpu()
    per_candidate: dict[str, float] = {}
    for candidate_index in range(candidate_bank.shape[0]):
        mask = targets == candidate_index
        if not bool(mask.any()):
            raise GlyphVoiceTrainingError(
                f"candidate query target is absent: {candidate_index}"
            )
        per_candidate[str(candidate_index)] = float(
            (predictions[mask] == targets[mask]).float().mean().item()
        )
    ranks = torch.argsort(scores, dim=1, descending=True)
    target_ranks = (ranks == targets[:, None]).nonzero(as_tuple=False)[:, 1] + 1
    return {
        "candidate_count_with_prediction": int(predictions.unique().numel()),
        "macro_top1": float(sum(per_candidate.values()) / len(per_candidate)),
        "mean_reciprocal_rank": float((1.0 / target_ranks.float()).mean().item()),
        "minimum_candidate_top1": min(per_candidate.values()),
        "per_candidate_top1": per_candidate,
        "rows": len(query_bank),
        "top1": float((predictions == targets).float().mean().item()),
    }


def _clone_state_cpu(module: nn.Module) -> dict[str, Tensor]:
    return {
        name: value.detach().cpu().clone()
        for name, value in module.state_dict().items()
    }


def _train_synthetic_stage(
    model: glyphvoice.GlyphVoiceLocalModel,
    context: Mapping[str, Any],
    banks: Mapping[str, Tensor],
    args: argparse.Namespace,
    device: torch.device,
) -> Mapping[str, Any]:
    rows: Sequence[SyntheticRow] = context["synthetic_rows"]
    bank = banks["synthetic"]
    candidate_bank = banks["candidate"]
    candidate_query_bank = banks["candidate_queries"]
    candidate_query_targets = banks["candidate_query_targets"]
    groups = _synthetic_groups(rows, split="train")
    if len(groups) < 16:
        raise GlyphVoiceTrainingError("synthetic train face inventory is too small")
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.pretrain_learning_rate, weight_decay=1e-4
    )
    total_steps = args.pretrain_epochs * args.pretrain_steps_per_epoch
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, total_steps), eta_min=args.pretrain_learning_rate * 0.08
    )
    rng = random.Random(args.seed)
    generator = torch.Generator(device=device)
    generator.manual_seed(args.seed + 101)
    history: list[Mapping[str, Any]] = []
    initial = _evaluate_synthetic_retrieval(
        model, rows, bank, split="validation", device=device
    )
    initial_candidate = _evaluate_candidate_query_retrieval(
        model,
        candidate_query_bank,
        candidate_query_targets,
        candidate_bank,
        device=device,
        batch_size=args.evaluation_batch_size,
    )

    def selection_score(
        synthetic_metrics: Mapping[str, Any], candidate_metrics: Mapping[str, Any]
    ) -> float:
        return (
            0.65 * float(candidate_metrics["macro_top1"])
            + 0.20 * float(candidate_metrics["mean_reciprocal_rank"])
            + 0.15 * float(synthetic_metrics["mean_top1"] or 0.0)
        )

    best_score = selection_score(initial, initial_candidate)
    best_epoch = 0
    best_state = _clone_state_cpu(model)
    history.append(
        {
            "candidate_query": initial_candidate,
            "epoch": 0,
            "loss": None,
            "selection_score": best_score,
            "validation": initial,
        }
    )
    print(
        f"synthetic epoch 0 selection={best_score:.4f} "
        f"candidate={initial_candidate['macro_top1']:.4f}",
        flush=True,
    )

    for epoch in range(1, args.pretrain_epochs + 1):
        model.train()
        loss_total = 0.0
        info_total = 0.0
        relation_total = 0.0
        script_total = 0.0
        candidate_total = 0.0
        for _step in range(args.pretrain_steps_per_epoch):
            indices = _sample_synthetic_pair_indices(
                rows,
                groups,
                face_count=args.pretrain_faces_per_batch,
                rng=rng,
            )
            inputs = _augment_batch(_float_inputs(bank[indices], device), generator)
            tokens, embeddings = model.encode(inputs)
            info_loss = glyphvoice.paired_info_nce(embeddings)
            left_tokens, right_tokens = tokens[0::2], tokens[1::2]
            left_global, right_global = embeddings[0::2], embeddings[1::2]
            positive_score = model.matcher.pair_score(
                left_tokens, left_global, right_tokens, right_global
            )
            negative_score = model.matcher.pair_score(
                left_tokens,
                left_global,
                torch.roll(right_tokens, shifts=1, dims=0),
                torch.roll(right_global, shifts=1, dims=0),
            )
            relation_loss = F.softplus(0.45 - positive_score + negative_score).mean()
            bridge_mask = torch.tensor(
                [rows[index].category == "cross_script_bridge" for index in indices],
                dtype=torch.bool,
                device=device,
            )
            if int(bridge_mask.sum()) >= 4:
                script_targets = torch.tensor(
                    [0 if rows[index].script == "japanese" else 1 for index in indices],
                    dtype=torch.long,
                    device=device,
                )
                script_logits = model.script_classifier(
                    glyphvoice.gradient_reverse(embeddings[bridge_mask], 0.15)
                )
                script_loss = F.cross_entropy(
                    script_logits, script_targets[bridge_mask]
                )
            else:
                script_loss = embeddings.sum() * 0.0
            candidate_query_indices = _sample_candidate_query_indices(
                candidate_query_targets,
                queries_per_candidate=args.candidate_queries_per_candidate,
                rng=rng,
            )
            query_inputs = _augment_batch(
                _float_inputs(candidate_query_bank[candidate_query_indices], device),
                generator,
            )
            candidate_count, candidate_render_count = candidate_bank.shape[:2]
            renders_per_step = min(4, candidate_render_count)
            render_indices = torch.tensor(
                [
                    rng.sample(range(candidate_render_count), k=renders_per_step)
                    for _candidate in range(candidate_count)
                ],
                dtype=torch.long,
            )
            candidate_indices = torch.arange(candidate_count)[:, None]
            prototype_inputs = candidate_bank[candidate_indices, render_indices]
            prototype_inputs = _augment_batch(
                _float_inputs(prototype_inputs.flatten(0, 1), device), generator
            ).reshape(
                candidate_count,
                renders_per_step,
                3,
                glyphvoice.INPUT_SIZE,
                glyphvoice.INPUT_SIZE,
            )
            candidate_tokens, candidate_global = _encode_candidate_prototypes(
                model, prototype_inputs
            )
            query_tokens, query_global = model.encode(query_inputs)
            candidate_logits = model.matcher(
                query_tokens, query_global, candidate_tokens, candidate_global
            )
            candidate_targets = candidate_query_targets[candidate_query_indices].to(
                device
            )
            retrieval_loss = F.cross_entropy(
                candidate_logits,
                candidate_targets,
            )
            prototype_targets = torch.arange(
                candidate_count, device=device
            ).repeat_interleave(renders_per_step)
            auxiliary_loss = 0.5 * (
                F.cross_entropy(
                    model.candidate_aux_classifier(query_global), candidate_targets
                )
                + F.cross_entropy(
                    model.candidate_aux_classifier(candidate_global.flatten(0, 1)),
                    prototype_targets,
                )
            )
            candidate_loss = retrieval_loss + 0.55 * auxiliary_loss
            loss = (
                info_loss
                + 0.55 * relation_loss
                + 0.04 * script_loss
                + 1.35 * candidate_loss
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            optimizer.step()
            scheduler.step()
            loss_total += float(loss.detach().item())
            info_total += float(info_loss.detach().item())
            relation_total += float(relation_loss.detach().item())
            script_total += float(script_loss.detach().item())
            candidate_total += float(candidate_loss.detach().item())

        validation = _evaluate_synthetic_retrieval(
            model, rows, bank, split="validation", device=device
        )
        candidate_validation = _evaluate_candidate_query_retrieval(
            model,
            candidate_query_bank,
            candidate_query_targets,
            candidate_bank,
            device=device,
            batch_size=args.evaluation_batch_size,
        )
        score = selection_score(validation, candidate_validation)
        if score > best_score + 1e-8:
            best_score = score
            best_epoch = epoch
            best_state = _clone_state_cpu(model)
        divisor = float(args.pretrain_steps_per_epoch)
        record = {
            "epoch": epoch,
            "candidate_query": candidate_validation,
            "candidate_query_loss": candidate_total / divisor,
            "info_nce": info_total / divisor,
            "loss": loss_total / divisor,
            "relation_loss": relation_total / divisor,
            "selection_score": score,
            "script_adversary_loss": script_total / divisor,
            "validation": validation,
        }
        history.append(record)
        print(
            f"synthetic epoch {epoch}/{args.pretrain_epochs} "
            f"loss={record['loss']:.4f} selection={score:.4f} "
            f"candidate={candidate_validation['macro_top1']:.4f} "
            f"best={best_score:.4f}",
            flush=True,
        )
    model.load_state_dict(best_state, strict=True)
    test_metrics = _evaluate_synthetic_retrieval(
        model, rows, bank, split="test", device=device
    )
    candidate_metrics = _evaluate_candidate_query_retrieval(
        model,
        candidate_query_bank,
        candidate_query_targets,
        candidate_bank,
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    return {
        "best_epoch": best_epoch,
        "candidate_query": candidate_metrics,
        "history": history,
        "test": test_metrics,
        "validation_best": best_score,
    }


def _real_label_tensors(
    rows: Sequence[RealRow], device: torch.device | None = None
) -> Mapping[str, Tensor]:
    target_device = device if device is not None else torch.device("cpu")
    return {
        "eligible": torch.tensor(
            [row.eligible for row in rows], dtype=torch.bool, device=target_device
        ),
        "positive": torch.tensor(
            [row.positive for row in rows], dtype=torch.bool, device=target_device
        ),
        "preferred": torch.tensor(
            [row.preferred for row in rows], dtype=torch.bool, device=target_device
        ),
        "weights": torch.tensor(
            [row.supervision_weight for row in rows],
            dtype=torch.float32,
            device=target_device,
        ),
    }


def _reviewed_pairwise_loss(
    logits: Tensor,
    eligible: Tensor,
    positive: Tensor,
    preferred: Tensor,
    weights: Tensor,
) -> tuple[Tensor, Tensor, Tensor]:
    negative = eligible & ~positive
    positive_count = positive.sum(dim=1).clamp_min(1)
    negative_count = negative.sum(dim=1).clamp_min(1)
    positive_mean = (logits * positive).sum(dim=1) / positive_count
    negative_mean = (logits * negative).sum(dim=1) / negative_count
    valid_pair = negative.any(dim=1) & positive.any(dim=1)
    pair_rows = F.softplus(0.7 - positive_mean + negative_mean)

    acceptable = positive & ~preferred
    preferred_count = preferred.sum(dim=1).clamp_min(1)
    acceptable_count = acceptable.sum(dim=1).clamp_min(1)
    preferred_mean = (logits * preferred).sum(dim=1) / preferred_count
    acceptable_mean = (logits * acceptable).sum(dim=1) / acceptable_count
    valid_preference = preferred.any(dim=1) & acceptable.any(dim=1)
    preference_rows = F.softplus(0.2 - preferred_mean + acceptable_mean)

    reviewed_count = eligible.sum(dim=1).clamp_min(1)
    reviewed_mean = (logits * eligible).sum(dim=1, keepdim=True) / reviewed_count[
        :, None
    ]
    centered = logits - reviewed_mean
    bce_cells = F.binary_cross_entropy_with_logits(
        centered, positive.float(), reduction="none"
    )
    bce_rows = (bce_cells * eligible).sum(dim=1) / reviewed_count

    normalized = weights / weights.sum().clamp_min(1e-6)
    pair_weights = normalized * valid_pair.float()
    pair_weights = pair_weights / pair_weights.sum().clamp_min(1e-6)
    preference_weights = normalized * valid_preference.float()
    preference_weights = preference_weights / preference_weights.sum().clamp_min(1e-6)
    return (
        torch.sum(pair_rows * pair_weights),
        torch.sum(preference_rows * preference_weights),
        torch.sum(bce_rows * normalized),
    )


def _encode_candidate_prototypes(
    model: glyphvoice.GlyphVoiceLocalModel, candidate_inputs: Tensor
) -> tuple[Tensor, Tensor]:
    candidate_count, render_count = candidate_inputs.shape[:2]
    tokens, global_embedding = model.encode(candidate_inputs.flatten(0, 1))
    return (
        tokens.reshape(
            candidate_count,
            render_count,
            glyphvoice.TOKEN_COUNT,
            glyphvoice.TOKEN_DIM,
        ),
        global_embedding.reshape(candidate_count, render_count, glyphvoice.EMBED_DIM),
    )


@torch.inference_mode()
def _score_real_rows(
    model: glyphvoice.GlyphVoiceLocalModel,
    real_bank: Tensor,
    candidate_bank: Tensor,
    *,
    device: torch.device,
    batch_size: int,
) -> tuple[Tensor, Tensor]:
    model.eval()
    candidate_inputs = _float_inputs(candidate_bank, device)
    candidate_tokens, candidate_global = _encode_candidate_prototypes(
        model, candidate_inputs
    )
    score_parts: list[Tensor] = []
    embedding_parts: list[Tensor] = []
    for start in range(0, len(real_bank), batch_size):
        inputs = _float_inputs(real_bank[start : start + batch_size], device)
        query_tokens, query_global = model.encode(inputs)
        scores = model.matcher(
            query_tokens, query_global, candidate_tokens, candidate_global
        )
        score_parts.append(scores.float().cpu())
        embedding_parts.append(query_global.float().cpu())
    return torch.cat(score_parts), torch.cat(embedding_parts)


def _real_metrics(
    scores: Tensor,
    rows: Sequence[RealRow],
    candidate_ids: Sequence[str],
    *,
    split: str,
) -> Mapping[str, Any]:
    indices = [index for index, row in enumerate(rows) if row.split == split]
    if not indices:
        raise GlyphVoiceTrainingError(f"real metric split is empty: {split}")
    subset = scores[indices]
    predictions = subset.argmax(dim=1)
    positive = torch.tensor(
        [rows[index].positive for index in indices], dtype=torch.bool
    )
    preferred = torch.tensor(
        [rows[index].preferred for index in indices], dtype=torch.bool
    )
    eligible = torch.tensor(
        [rows[index].eligible for index in indices], dtype=torch.bool
    )
    row_index = torch.arange(len(indices))
    positive_hit = positive[row_index, predictions]
    eligible_hit = eligible[row_index, predictions]
    has_preferred = preferred.any(dim=1)
    preferred_hit = preferred[row_index, predictions]
    family_metrics: dict[str, Any] = {}
    for family in ("body", "variant"):
        mask = torch.tensor([rows[index].family == family for index in indices])
        family_metrics[family] = {
            "positive_top1": float(positive_hit[mask].float().mean().item())
            if bool(mask.any())
            else None,
            "rows": int(mask.sum().item()),
        }
    prediction_counts = Counter(
        candidate_ids[int(value)] for value in predictions.tolist()
    )
    body_pages: dict[str, list[str]] = defaultdict(list)
    for local_index, source_index in enumerate(indices):
        if rows[source_index].family == "body":
            body_pages[rows[source_index].page_id].append(
                candidate_ids[int(predictions[local_index])]
            )
    multi_pages = [values for values in body_pages.values() if len(values) >= 2]
    return {
        "body_page_all_same_rate": float(
            sum(len(set(values)) == 1 for values in multi_pages) / len(multi_pages)
        )
        if multi_pages
        else None,
        "body_page_mean_unique": float(
            sum(len(set(values)) for values in multi_pages) / len(multi_pages)
        )
        if multi_pages
        else None,
        "body_pages_with_multiple_rows": len(multi_pages),
        "eligible_top1": float(eligible_hit.float().mean().item()),
        "family": family_metrics,
        "positive_top1": float(positive_hit.float().mean().item()),
        "prediction_counts": dict(sorted(prediction_counts.items())),
        "preferred_rows": int(has_preferred.sum().item()),
        "preferred_top1": float(preferred_hit[has_preferred].float().mean().item())
        if bool(has_preferred.any())
        else None,
        "rows": len(indices),
        "split": split,
    }


def _train_real_stage(
    model: glyphvoice.GlyphVoiceLocalModel,
    context: Mapping[str, Any],
    banks: Mapping[str, Tensor],
    args: argparse.Namespace,
    device: torch.device,
) -> Mapping[str, Any]:
    rows: Sequence[RealRow] = context["real_rows"]
    candidate_ids: Sequence[str] = context["candidate_ids"]
    teacher_scores: Tensor = context["teacher_scores"]
    labels = _real_label_tensors(rows)
    train_indices = [index for index, row in enumerate(rows) if row.split == "train"]
    work_indices: dict[str, list[int]] = defaultdict(list)
    for index in train_indices:
        work_indices[rows[index].work_id].append(index)
    if len(work_indices) != 10:
        raise GlyphVoiceTrainingError("real work-balanced inventory drifted")
    synthetic_rows: Sequence[SyntheticRow] = context["synthetic_rows"]
    synthetic_groups = _synthetic_groups(synthetic_rows, split="train")
    candidate_query_bank = banks["candidate_queries"]
    candidate_query_targets = banks["candidate_query_targets"]
    optimizer = torch.optim.AdamW(
        (
            {
                "params": model.encoder.parameters(),
                "lr": args.real_learning_rate * 0.35,
            },
            {
                "params": (
                    *model.matcher.parameters(),
                    *model.candidate_aux_classifier.parameters(),
                ),
                "lr": args.real_learning_rate,
            },
        ),
        weight_decay=8e-5,
    )
    balanced_rows_per_epoch = max(
        len(values) for values in work_indices.values()
    ) * len(work_indices)
    total_steps = args.real_epochs * math.ceil(
        balanced_rows_per_epoch / args.real_batch_size
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, total_steps), eta_min=args.real_learning_rate * 0.04
    )
    rng = random.Random(args.seed + 2001)
    generator = torch.Generator(device=device)
    generator.manual_seed(args.seed + 2002)
    initial_scores, _initial_embeddings = _score_real_rows(
        model,
        banks["real"],
        banks["candidate"],
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    initial_train = _real_metrics(initial_scores, rows, candidate_ids, split="train")
    initial_development = _real_metrics(
        initial_scores, rows, candidate_ids, split="development"
    )
    teacher_train = _real_metrics(teacher_scores, rows, candidate_ids, split="train")
    teacher_development = _real_metrics(
        teacher_scores, rows, candidate_ids, split="development"
    )
    initial_synthetic = _evaluate_synthetic_retrieval(
        model,
        synthetic_rows,
        banks["synthetic"],
        split="validation",
        device=device,
    )
    initial_candidate = _evaluate_candidate_query_retrieval(
        model,
        candidate_query_bank,
        candidate_query_targets,
        banks["candidate"],
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    best_score = (
        float(initial_development["positive_top1"])
        + 0.35 * float(initial_development["preferred_top1"] or 0.0)
        + 0.20 * float(initial_candidate["macro_top1"])
    )
    best_epoch = 0
    best_state = _clone_state_cpu(model)
    history: list[Mapping[str, Any]] = [
        {
            "development": initial_development,
            "candidate_query": initial_candidate,
            "epoch": 0,
            "loss": None,
            "synthetic_validation": initial_synthetic,
            "teacher_development_reference": teacher_development,
            "train": initial_train,
        }
    ]
    print(
        f"real epoch 0 dev-positive={initial_development['positive_top1']:.4f} "
        f"dev-preferred={float(initial_development['preferred_top1'] or 0):.4f}",
        flush=True,
    )

    for epoch in range(1, args.real_epochs + 1):
        model.train()
        encoder_trainable = epoch > args.real_matcher_only_epochs
        for parameter in model.encoder.parameters():
            parameter.requires_grad_(encoder_trainable)
        target_per_work = max(len(values) for values in work_indices.values())
        shuffled: list[int] = []
        for work_id in sorted(work_indices):
            values = work_indices[work_id]
            shuffled.extend(values)
            shuffled.extend(rng.choices(values, k=target_per_work - len(values)))
        rng.shuffle(shuffled)
        loss_total = 0.0
        bce_total = 0.0
        distillation_total = 0.0
        pairwise_total = 0.0
        preference_total = 0.0
        real_consistency_total = 0.0
        retention_total = 0.0
        candidate_retention_total = 0.0
        steps = 0
        for start in range(0, len(shuffled), args.real_batch_size):
            indices = shuffled[start : start + args.real_batch_size]
            query_inputs = _augment_batch(
                _float_inputs(banks["real"][indices], device), generator
            )
            candidate_inputs = _float_inputs(banks["candidate"], device)
            candidate_tokens, candidate_global = _encode_candidate_prototypes(
                model, candidate_inputs
            )
            query_tokens, query_global = model.encode(query_inputs)
            logits = model.matcher(
                query_tokens, query_global, candidate_tokens, candidate_global
            )
            eligible = labels["eligible"][indices].to(device)
            positive = labels["positive"][indices].to(device)
            preferred = labels["preferred"][indices].to(device)
            weights = labels["weights"][indices].to(device)
            pairwise_loss, preference_loss, bce_loss = _reviewed_pairwise_loss(
                logits,
                eligible,
                positive,
                preferred,
                weights,
            )
            teacher = teacher_scores[indices].to(device)
            temperature = 2.0
            distillation_loss = F.kl_div(
                F.log_softmax(logits / temperature, dim=1),
                F.softmax(teacher / temperature, dim=1),
                reduction="batchmean",
            ) * (temperature * temperature)
            second_inputs = _augment_batch(
                _float_inputs(banks["real"][indices], device), generator
            )
            _second_tokens, second_global = model.encode(second_inputs)
            interleaved = torch.stack((query_global, second_global), dim=1).flatten(
                0, 1
            )
            real_consistency_loss = glyphvoice.paired_info_nce(interleaved)
            synthetic_indices = _sample_synthetic_pair_indices(
                synthetic_rows,
                synthetic_groups,
                face_count=min(10, args.pretrain_faces_per_batch),
                rng=rng,
            )
            synthetic_inputs = _augment_batch(
                _float_inputs(banks["synthetic"][synthetic_indices], device),
                generator,
            )
            _synthetic_tokens, synthetic_global = model.encode(synthetic_inputs)
            retention_loss = glyphvoice.paired_info_nce(synthetic_global)
            candidate_query_indices = _sample_candidate_query_indices(
                candidate_query_targets,
                queries_per_candidate=1,
                rng=rng,
            )
            candidate_query_inputs = _augment_batch(
                _float_inputs(candidate_query_bank[candidate_query_indices], device),
                generator,
            )
            candidate_query_tokens, candidate_query_global = model.encode(
                candidate_query_inputs
            )
            candidate_query_logits = model.matcher(
                candidate_query_tokens,
                candidate_query_global,
                candidate_tokens,
                candidate_global,
            )
            candidate_retention_loss = F.cross_entropy(
                candidate_query_logits,
                candidate_query_targets[candidate_query_indices].to(device),
            )
            candidate_auxiliary_loss = 0.5 * (
                F.cross_entropy(
                    model.candidate_aux_classifier(candidate_query_global),
                    candidate_query_targets[candidate_query_indices].to(device),
                )
                + F.cross_entropy(
                    model.candidate_aux_classifier(candidate_global.flatten(0, 1)),
                    torch.arange(len(candidate_ids), device=device).repeat_interleave(
                        candidate_global.shape[1]
                    ),
                )
            )
            candidate_retention_loss = (
                candidate_retention_loss + 0.55 * candidate_auxiliary_loss
            )
            loss = (
                0.80 * pairwise_loss
                + 0.22 * preference_loss
                + 0.22 * bce_loss
                + 0.55 * distillation_loss
                + 0.12 * real_consistency_loss
                + 0.12 * retention_loss
                + 0.65 * candidate_retention_loss
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.5)
            optimizer.step()
            scheduler.step()
            loss_total += float(loss.detach().item())
            bce_total += float(bce_loss.detach().item())
            distillation_total += float(distillation_loss.detach().item())
            pairwise_total += float(pairwise_loss.detach().item())
            preference_total += float(preference_loss.detach().item())
            real_consistency_total += float(real_consistency_loss.detach().item())
            retention_total += float(retention_loss.detach().item())
            candidate_retention_total += float(candidate_retention_loss.detach().item())
            steps += 1

        scores, _embeddings = _score_real_rows(
            model,
            banks["real"],
            banks["candidate"],
            device=device,
            batch_size=args.evaluation_batch_size,
        )
        train_metrics = _real_metrics(scores, rows, candidate_ids, split="train")
        development_metrics = _real_metrics(
            scores, rows, candidate_ids, split="development"
        )
        synthetic_metrics = _evaluate_synthetic_retrieval(
            model,
            synthetic_rows,
            banks["synthetic"],
            split="validation",
            device=device,
        )
        candidate_metrics = _evaluate_candidate_query_retrieval(
            model,
            candidate_query_bank,
            candidate_query_targets,
            banks["candidate"],
            device=device,
            batch_size=args.evaluation_batch_size,
        )
        score = (
            float(development_metrics["positive_top1"])
            + 0.35 * float(development_metrics["preferred_top1"] or 0.0)
            + 0.20 * float(candidate_metrics["macro_top1"])
        )
        synthetic_floor = float(initial_synthetic["mean_top1"] or 0.0) - 0.12
        candidate_floor = max(0.65, float(initial_candidate["macro_top1"]) - 0.03)
        if (
            score > best_score + 1e-8
            and float(synthetic_metrics["mean_top1"] or 0.0) >= synthetic_floor
            and float(candidate_metrics["macro_top1"]) >= candidate_floor
            and int(candidate_metrics["candidate_count_with_prediction"]) >= 18
        ):
            best_score = score
            best_epoch = epoch
            best_state = _clone_state_cpu(model)
        record = {
            "development": development_metrics,
            "candidate_query": candidate_metrics,
            "candidate_retention_loss": candidate_retention_total / steps,
            "epoch": epoch,
            "loss": loss_total / steps,
            "reviewed_bce_loss": bce_total / steps,
            "distillation_loss": distillation_total / steps,
            "pairwise_loss": pairwise_total / steps,
            "preference_loss": preference_total / steps,
            "real_view_consistency_loss": real_consistency_total / steps,
            "retention_loss": retention_total / steps,
            "synthetic_validation": synthetic_metrics,
            "train": train_metrics,
        }
        history.append(record)
        print(
            f"real epoch {epoch}/{args.real_epochs} loss={record['loss']:.4f} "
            f"dev+={development_metrics['positive_top1']:.4f} "
            f"dev*={float(development_metrics['preferred_top1'] or 0):.4f} "
            f"candidate={candidate_metrics['macro_top1']:.4f} "
            f"best={best_epoch}",
            flush=True,
        )
    model.load_state_dict(best_state, strict=True)
    for parameter in model.encoder.parameters():
        parameter.requires_grad_(True)
    final_scores, final_embeddings = _score_real_rows(
        model,
        banks["real"],
        banks["candidate"],
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    final_candidate = _evaluate_candidate_query_retrieval(
        model,
        candidate_query_bank,
        candidate_query_targets,
        banks["candidate"],
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    return {
        "best_epoch": best_epoch,
        "final_development": _real_metrics(
            final_scores, rows, candidate_ids, split="development"
        ),
        "final_embeddings": final_embeddings,
        "final_candidate_query": final_candidate,
        "final_scores": final_scores,
        "final_train": _real_metrics(final_scores, rows, candidate_ids, split="train"),
        "history": history,
        "teacher_development_reference": teacher_development,
        "teacher_train_reference": teacher_train,
    }


def _page_groups(rows: Sequence[RealRow], *, split: str) -> list[list[int]]:
    groups: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        if row.split == split:
            groups[row.page_id].append(index)
    return [
        sorted(indices, key=lambda index: rows[index].sample_id)
        for _page, indices in sorted(groups.items())
        if len(indices) >= 2
    ]


def _make_page_batch(
    groups: Sequence[Sequence[int]],
    scores: Tensor,
    embeddings: Tensor,
    *,
    device: torch.device,
) -> tuple[Tensor, Tensor, Tensor, Tensor]:
    maximum = max(len(group) for group in groups)
    batch = len(groups)
    candidate_count = scores.shape[1]
    local = torch.zeros(batch, maximum, candidate_count, device=device)
    rows = torch.zeros(batch, maximum, embeddings.shape[1], device=device)
    padding = torch.ones(batch, maximum, dtype=torch.bool, device=device)
    index_map = torch.full((batch, maximum), -1, dtype=torch.long, device=device)
    for batch_index, group in enumerate(groups):
        length = len(group)
        local[batch_index, :length] = scores[list(group)].to(device)
        rows[batch_index, :length] = embeddings[list(group)].to(device)
        padding[batch_index, :length] = False
        index_map[batch_index, :length] = torch.tensor(group, device=device)
    return local, rows, padding, index_map


@torch.inference_mode()
def _refine_real_scores(
    voice: glyphvoice.PageVoiceSet,
    local_scores: Tensor,
    embeddings: Tensor,
    rows: Sequence[RealRow],
    *,
    device: torch.device,
    batch_pages: int,
) -> tuple[Tensor, Tensor]:
    voice.eval()
    output = local_scores.clone()
    exception = torch.ones(len(rows), dtype=torch.float32)
    all_groups: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        all_groups[row.page_id].append(index)
    groups = [
        sorted(indices, key=lambda index: rows[index].sample_id)
        for _page, indices in sorted(all_groups.items())
        if len(indices) >= 2
    ]
    for start in range(0, len(groups), batch_pages):
        batch_groups = groups[start : start + batch_pages]
        local, row_embeddings, padding, index_map = _make_page_batch(
            batch_groups, local_scores, embeddings, device=device
        )
        refined, gates, _residual = voice(local, row_embeddings, padding)
        valid = ~padding
        flat_indices = index_map[valid].cpu()
        output[flat_indices] = refined[valid].float().cpu()
        exception[flat_indices] = gates[valid].float().cpu()
    return output, exception


def _synthetic_voice_episode(
    candidate_embeddings: Tensor,
    *,
    batch_size: int,
    length: int,
    generator: torch.Generator,
) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor]:
    device = candidate_embeddings.device
    candidate_count = candidate_embeddings.shape[0]
    main = torch.randint(
        candidate_count, (batch_size,), generator=generator, device=device
    )
    exception = torch.randint(
        candidate_count - 1, (batch_size,), generator=generator, device=device
    )
    exception = exception + (exception >= main).long()
    targets = main[:, None].expand(-1, length).clone()
    exception_mask = torch.zeros(batch_size, length, dtype=torch.bool, device=device)
    for batch_index in range(batch_size):
        count = 1 + int(
            torch.randint(2, (1,), generator=generator, device=device).item()
        )
        positions = torch.randperm(length, generator=generator, device=device)[:count]
        targets[batch_index, positions] = exception[batch_index]
        exception_mask[batch_index, positions] = True
    logits = (
        torch.randn(
            batch_size,
            length,
            candidate_count,
            generator=generator,
            device=device,
        )
        * 0.75
    )
    logits.scatter_add_(
        2,
        targets[..., None],
        torch.full((batch_size, length, 1), 2.4, device=device),
    )
    corruption = (
        torch.rand(batch_size, length, generator=generator, device=device) < 0.28
    ) & ~exception_mask
    wrong = torch.randint(
        candidate_count - 1,
        (batch_size, length),
        generator=generator,
        device=device,
    )
    wrong = wrong + (wrong >= targets).long()
    logits.scatter_add_(
        2,
        wrong[..., None],
        (corruption.float() * 3.0)[..., None],
    )
    embeddings = (
        candidate_embeddings[targets]
        + torch.randn(
            batch_size,
            length,
            candidate_embeddings.shape[1],
            generator=generator,
            device=device,
        )
        * 0.08
    )
    padding = torch.zeros(batch_size, length, dtype=torch.bool, device=device)
    return logits, embeddings, padding, targets, exception_mask


def _train_voice_stage(
    local_model: glyphvoice.GlyphVoiceLocalModel,
    context: Mapping[str, Any],
    banks: Mapping[str, Tensor],
    local_scores: Tensor,
    local_embeddings: Tensor,
    args: argparse.Namespace,
    device: torch.device,
) -> tuple[glyphvoice.PageVoiceSet, Mapping[str, Any]]:
    rows: Sequence[RealRow] = context["real_rows"]
    candidate_ids: Sequence[str] = context["candidate_ids"]
    train_pages = _page_groups(rows, split="train")
    if len(train_pages) < 20:
        raise GlyphVoiceTrainingError("not enough multi-row pages for VoiceSet")
    labels = _real_label_tensors(rows)
    local_model.eval()
    with torch.inference_mode():
        _tokens, candidate_global = _encode_candidate_prototypes(
            local_model, _float_inputs(banks["candidate"], device)
        )
        candidate_embeddings = F.normalize(candidate_global.mean(dim=1), dim=-1)
    voice = glyphvoice.PageVoiceSet(len(candidate_ids)).to(device)
    optimizer = torch.optim.AdamW(
        voice.parameters(), lr=args.voice_learning_rate, weight_decay=1e-4
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer,
        T_max=max(1, args.voice_epochs * args.voice_steps_per_epoch),
        eta_min=args.voice_learning_rate * 0.05,
    )
    rng = random.Random(args.seed + 4001)
    generator = torch.Generator(device=device)
    generator.manual_seed(args.seed + 4002)
    initial_train = _real_metrics(local_scores, rows, candidate_ids, split="train")
    initial_development = _real_metrics(
        local_scores, rows, candidate_ids, split="development"
    )
    candidate_query_metrics = _evaluate_candidate_query_retrieval(
        local_model,
        banks["candidate_queries"],
        banks["candidate_query_targets"],
        banks["candidate"],
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    if (
        float(initial_development["positive_top1"]) < 0.30
        or float(initial_development["preferred_top1"] or 0.0) < 0.18
        or float(candidate_query_metrics["macro_top1"]) < 0.70
        or int(candidate_query_metrics["candidate_count_with_prediction"]) < 18
    ):
        print(
            "VoiceSet skipped: local matcher has not crossed its precommitted quality floor",
            flush=True,
        )
        return voice, {
            "best_epoch": 0,
            "candidate_query": candidate_query_metrics,
            "exception_gate": {"body_mean": None, "variant_mean": None},
            "final_development": initial_development,
            "final_scores": local_scores.clone(),
            "final_train": initial_train,
            "history": [
                {
                    "development": initial_development,
                    "epoch": 0,
                    "loss": None,
                    "train": initial_train,
                }
            ],
            "skipped_reason": "local_matcher_quality_floor_not_met",
        }
    best_state = _clone_state_cpu(voice)
    best_epoch = 0
    best_score = float(initial_development["positive_top1"]) + 0.25 * float(
        initial_development["preferred_top1"] or 0.0
    )
    history: list[Mapping[str, Any]] = [
        {
            "development": initial_development,
            "epoch": 0,
            "loss": None,
            "train": initial_train,
        }
    ]
    for epoch in range(1, args.voice_epochs + 1):
        voice.train()
        loss_total = 0.0
        synthetic_total = 0.0
        real_total = 0.0
        for _step in range(args.voice_steps_per_epoch):
            (
                synthetic_logits,
                synthetic_embeddings,
                synthetic_padding,
                targets,
                exceptions,
            ) = _synthetic_voice_episode(
                candidate_embeddings,
                batch_size=args.voice_synthetic_pages,
                length=8,
                generator=generator,
            )
            refined, predicted_exception, _residual = voice(
                synthetic_logits, synthetic_embeddings, synthetic_padding
            )
            synthetic_loss = F.cross_entropy(
                refined.flatten(0, 1), targets.flatten()
            ) + 0.18 * F.binary_cross_entropy(predicted_exception, exceptions.float())

            selected_pages = rng.choices(
                train_pages, k=min(args.voice_real_pages, len(train_pages))
            )
            page_local, page_embeddings, padding, index_map = _make_page_batch(
                selected_pages, local_scores, local_embeddings, device=device
            )
            page_refined, page_exception, page_residual = voice(
                page_local, page_embeddings, padding
            )
            valid = ~padding
            source_indices = index_map[valid].cpu()
            real_loss = glyphvoice.partial_set_nll(
                page_refined[valid],
                labels["eligible"][source_indices].to(device),
                labels["positive"][source_indices].to(device),
                labels["preferred"][source_indices].to(device),
                labels["weights"][source_indices].to(device),
            )
            variant = torch.tensor(
                [rows[int(index)].family == "variant" for index in source_indices],
                dtype=torch.float32,
                device=device,
            )
            variant_residual = (
                page_residual[valid].square().mean(dim=1) * variant
            ).sum() / variant.sum().clamp_min(1.0)
            family_target = variant
            exception_loss = F.binary_cross_entropy(
                page_exception[valid], family_target
            )
            loss = (
                synthetic_loss
                + 0.75 * real_loss
                + 0.12 * variant_residual
                + 0.05 * exception_loss
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(voice.parameters(), 1.5)
            optimizer.step()
            scheduler.step()
            loss_total += float(loss.detach().item())
            synthetic_total += float(synthetic_loss.detach().item())
            real_total += float(real_loss.detach().item())

        refined_scores, _exceptions = _refine_real_scores(
            voice,
            local_scores,
            local_embeddings,
            rows,
            device=device,
            batch_pages=args.voice_real_pages,
        )
        train_metrics = _real_metrics(
            refined_scores, rows, candidate_ids, split="train"
        )
        development_metrics = _real_metrics(
            refined_scores, rows, candidate_ids, split="development"
        )
        score = float(development_metrics["positive_top1"]) + 0.25 * float(
            development_metrics["preferred_top1"] or 0.0
        )
        if development_metrics["body_page_all_same_rate"] is not None:
            score += 0.04 * float(development_metrics["body_page_all_same_rate"])
        local_variant = float(
            initial_development["family"]["variant"]["positive_top1"] or 0.0
        )
        current_variant = float(
            development_metrics["family"]["variant"]["positive_top1"] or 0.0
        )
        safe = (
            float(development_metrics["positive_top1"])
            >= float(initial_development["positive_top1"]) - 0.015
            and current_variant >= local_variant - 0.025
        )
        if safe and score > best_score + 1e-8:
            best_score = score
            best_epoch = epoch
            best_state = _clone_state_cpu(voice)
        divisor = float(args.voice_steps_per_epoch)
        record = {
            "development": development_metrics,
            "epoch": epoch,
            "loss": loss_total / divisor,
            "real_partial_loss": real_total / divisor,
            "synthetic_loss": synthetic_total / divisor,
            "train": train_metrics,
        }
        history.append(record)
        print(
            f"voice epoch {epoch}/{args.voice_epochs} loss={record['loss']:.4f} "
            f"dev+={development_metrics['positive_top1']:.4f} "
            f"page={float(development_metrics['body_page_all_same_rate'] or 0):.4f} "
            f"best={best_epoch}",
            flush=True,
        )
    voice.load_state_dict(best_state, strict=True)
    final_scores, exceptions = _refine_real_scores(
        voice,
        local_scores,
        local_embeddings,
        rows,
        device=device,
        batch_pages=args.voice_real_pages,
    )
    return voice, {
        "best_epoch": best_epoch,
        "candidate_query": candidate_query_metrics,
        "exception_gate": {
            "body_mean": float(
                exceptions[torch.tensor([row.family == "body" for row in rows])]
                .mean()
                .item()
            ),
            "variant_mean": float(
                exceptions[torch.tensor([row.family == "variant" for row in rows])]
                .mean()
                .item()
            ),
        },
        "final_development": _real_metrics(
            final_scores, rows, candidate_ids, split="development"
        ),
        "final_scores": final_scores,
        "final_train": _real_metrics(final_scores, rows, candidate_ids, split="train"),
        "history": history,
    }


def _state_for_save(module: nn.Module) -> dict[str, Tensor]:
    return {
        name: value.detach().cpu().contiguous()
        for name, value in module.state_dict().items()
    }


def _seal_record(record: Mapping[str, Any]) -> Mapping[str, Any]:
    payload = dict(record)
    payload.pop("record_sha256", None)
    payload["record_sha256"] = _sha256_bytes(_canonical_json(payload).encode("utf-8"))
    return payload


def _validate_record_seal(record: Mapping[str, Any], name: str) -> None:
    claimed = str(record.get("record_sha256", ""))
    payload = dict(record)
    payload.pop("record_sha256", None)
    actual = _sha256_bytes(_canonical_json(payload).encode("utf-8"))
    if claimed != actual:
        raise GlyphVoiceTrainingError(f"{name} record seal drifted")


def _producer_binding() -> Mapping[str, Any]:
    return {
        "model": _descriptor(SCRIPT_DIR / "manga_font_glyphvoice_v1_model.py"),
        "trainer": _descriptor(Path(__file__).resolve()),
    }


def _write_training_output(
    output_dir: Path,
    local_model: glyphvoice.GlyphVoiceLocalModel,
    voice_model: glyphvoice.PageVoiceSet,
    context: Mapping[str, Any],
    synthetic_result: Mapping[str, Any],
    real_result: Mapping[str, Any],
    voice_result: Mapping[str, Any],
    args: argparse.Namespace,
    *,
    training_seconds: float,
) -> None:
    output_dir.mkdir(parents=False, exist_ok=False)
    local_path = output_dir / LOCAL_CHECKPOINT
    voice_path = output_dir / VOICE_CHECKPOINT
    save_file(_state_for_save(local_model), str(local_path))
    save_file(_state_for_save(voice_model), str(voice_path))
    local_inventory = glyphvoice.model_inventory(local_model)
    voice_inventory = glyphvoice.model_inventory(voice_model)
    manifest = _seal_record(
        {
            "authority": {
                "automatic_release_allowed": False,
                "evaluation_authority": False,
                "human_gold": False,
                "page_visual_review_required": True,
                "production_use_allowed": False,
                "training_only": True,
            },
            "candidate_ids": list(context["candidate_ids"]),
            "checkpoints": {
                "local": {**_output_descriptor(local_path), **local_inventory},
                "voice": {**_output_descriptor(voice_path), **voice_inventory},
            },
            "configuration": {
                "device": args.device,
                "input_size": glyphvoice.INPUT_SIZE,
                "candidate_queries_per_candidate": args.candidate_queries_per_candidate,
                "pretrain_epochs": args.pretrain_epochs,
                "pretrain_faces_per_batch": args.pretrain_faces_per_batch,
                "pretrain_learning_rate": args.pretrain_learning_rate,
                "pretrain_steps_per_epoch": args.pretrain_steps_per_epoch,
                "real_batch_size": args.real_batch_size,
                "real_epochs": args.real_epochs,
                "real_learning_rate": args.real_learning_rate,
                "real_matcher_only_epochs": args.real_matcher_only_epochs,
                "seed": args.seed,
                "token_count": glyphvoice.TOKEN_COUNT,
                "token_dim": glyphvoice.TOKEN_DIM,
                "voice_epochs": args.voice_epochs,
                "voice_learning_rate": args.voice_learning_rate,
                "voice_steps_per_epoch": args.voice_steps_per_epoch,
            },
            "counts": _context_summary(context),
            "metrics": {
                "real": {
                    "best_epoch": real_result["best_epoch"],
                    "candidate_query": real_result["final_candidate_query"],
                    "development": real_result["final_development"],
                    "teacher_development_reference": real_result[
                        "teacher_development_reference"
                    ],
                    "teacher_train_reference": real_result["teacher_train_reference"],
                    "train": real_result["final_train"],
                },
                "synthetic": synthetic_result,
                "voice": {
                    "best_epoch": voice_result["best_epoch"],
                    "candidate_query": voice_result["candidate_query"],
                    "development": voice_result["final_development"],
                    "exception_gate": voice_result["exception_gate"],
                    "skipped_reason": voice_result.get("skipped_reason"),
                    "train": voice_result["final_train"],
                },
            },
            "model_contract": {
                "candidate_id_features_used": False,
                "active21_held_out_render_retrieval_trained": True,
                "active21_held_out_render_retrieval_required_for_page_model": True,
                "candidate_prototypes_precomputed_at_runtime": True,
                "content_style_average_vector_only": False,
                "input_channels": [
                    "tight_glyph_ink",
                    "tight_glyph_dilated",
                    "tight_glyph_blurred",
                ],
                "local_matcher": "bidirectional_learned_soft_chamfer_on_24_multiscale_stroke_tokens",
                "prototype_orientation_modes": ["horizontal", "vertical"],
                "real_domain_anchor": "frozen_r3h_distribution_distillation_only",
                "real_label_objective": "work_balanced_reviewed_pairwise_plus_candidate_balanced_bce",
                "page_consistency": "learned_transformer_set_residual_with_exception_gate",
                "production_default_font_fallback_is_model_evidence": False,
            },
            "owner": OWNER,
            "producer": _producer_binding(),
            "record_type": "manga_font_glyphvoice_training_manifest",
            "runtime_claims": {
                "cpu_benchmark_completed": False,
                "estimated_local_parameter_count": local_inventory["parameter_count"],
                "estimated_voice_parameter_count": voice_inventory["parameter_count"],
                "onnx_export_completed": False,
                "production_promotion_blocked_until_visual_ab_and_cpu_benchmark": True,
            },
            "schema_version": SCHEMA_VERSION,
            "sources": context["sources"],
            "status": "experimental_checkpoint_exported",
            "training_seconds": max(float(training_seconds), 1e-9),
        }
    )
    manifest_path = output_dir / MANIFEST
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    marker = _seal_record(
        {
            "manifest": _output_descriptor(manifest_path),
            "owner": OWNER,
            "producer": _producer_binding(),
            "record_type": "manga_font_glyphvoice_training_owner",
            "schema_version": SCHEMA_VERSION,
        }
    )
    (output_dir / MARKER).write_text(
        json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def validate_output(
    output_dir: Path, *, require_sources: bool = True
) -> Mapping[str, Any]:
    root = output_dir.expanduser().absolute()
    if root.is_symlink() or not root.is_dir():
        raise GlyphVoiceTrainingError("GlyphVoice output is not a real directory")
    root = root.resolve()
    expected = {MARKER, MANIFEST, LOCAL_CHECKPOINT, VOICE_CHECKPOINT}
    actual = {entry.name for entry in root.iterdir()}
    if actual != expected:
        raise GlyphVoiceTrainingError("GlyphVoice output inventory drifted")
    manifest = _read_json(root / MANIFEST)
    marker = _read_json(root / MARKER)
    _validate_record_seal(manifest, "manifest")
    _validate_record_seal(marker, "owner marker")
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("owner") != OWNER
        or manifest.get("status") != "experimental_checkpoint_exported"
        or marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
    ):
        raise GlyphVoiceTrainingError("GlyphVoice output identity drifted")
    producer = _producer_binding()
    if manifest.get("producer") != producer or marker.get("producer") != producer:
        raise GlyphVoiceTrainingError("GlyphVoice producer binding drifted")
    if marker.get("manifest") != _output_descriptor(root / MANIFEST):
        raise GlyphVoiceTrainingError("owner marker manifest binding drifted")
    authority = manifest.get("authority")
    if not isinstance(authority, Mapping) or authority != {
        "automatic_release_allowed": False,
        "evaluation_authority": False,
        "human_gold": False,
        "page_visual_review_required": True,
        "production_use_allowed": False,
        "training_only": True,
    }:
        raise GlyphVoiceTrainingError("GlyphVoice authority contract drifted")
    checkpoints = manifest.get("checkpoints")
    if not isinstance(checkpoints, Mapping):
        raise GlyphVoiceTrainingError("checkpoint inventory is missing")
    candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
    if len(candidate_ids) != 21 or len(set(candidate_ids)) != 21:
        raise GlyphVoiceTrainingError("candidate inventory drifted")
    local = glyphvoice.GlyphVoiceLocalModel()
    voice = glyphvoice.PageVoiceSet(len(candidate_ids))
    for name, filename, module in (
        ("local", LOCAL_CHECKPOINT, local),
        ("voice", VOICE_CHECKPOINT, voice),
    ):
        path = _assert_regular_file(root / filename, f"{name} checkpoint")
        descriptor = dict(_output_descriptor(path))
        inventory = glyphvoice.model_inventory(module)
        descriptor.update(inventory)
        if checkpoints.get(name) != descriptor:
            raise GlyphVoiceTrainingError(f"{name} checkpoint descriptor drifted")
        state = load_file(str(path), device="cpu")
        module.load_state_dict(state, strict=True)
        if any(not torch.isfinite(value).all() for value in state.values()):
            raise GlyphVoiceTrainingError(f"{name} checkpoint is non-finite")
    if require_sources:
        sources = manifest.get("sources")
        if not isinstance(sources, Mapping):
            raise GlyphVoiceTrainingError("source binding is missing")
        for descriptor in sources.values():
            if not isinstance(descriptor, Mapping):
                raise GlyphVoiceTrainingError("source descriptor is malformed")
            path = _assert_regular_file(Path(str(descriptor["file"])), "bound source")
            if descriptor != _descriptor(path):
                raise GlyphVoiceTrainingError(f"bound source drifted: {path}")
    return manifest


def _train(args: argparse.Namespace) -> None:
    output = args.output_dir.expanduser().absolute()
    if output.exists():
        raise GlyphVoiceTrainingError(f"output already exists: {output}")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise GlyphVoiceTrainingError("CUDA was requested but is unavailable")
    device = torch.device(args.device)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)
        torch.set_float32_matmul_precision("high")
    context = _load_context(args)
    print(_canonical_json(_context_summary(context)), flush=True)
    banks = _materialize_banks(context)
    model = glyphvoice.GlyphVoiceLocalModel().to(device)
    started = time.perf_counter()
    synthetic_result = _train_synthetic_stage(model, context, banks, args, device)
    real_result = _train_real_stage(model, context, banks, args, device)
    voice, voice_result = _train_voice_stage(
        model,
        context,
        banks,
        real_result["final_scores"],
        real_result["final_embeddings"],
        args,
        device,
    )
    staging = output.with_name(f"{output.name}.staging-{os.getpid()}")
    if staging.exists():
        raise GlyphVoiceTrainingError(f"staging output already exists: {staging}")
    _write_training_output(
        staging,
        model,
        voice,
        context,
        synthetic_result,
        real_result,
        voice_result,
        args,
        training_seconds=time.perf_counter() - started,
    )
    validate_output(staging, require_sources=True)
    staging.rename(output)
    validate_output(output, require_sources=True)
    print(
        _canonical_json(
            {
                "local_parameters": glyphvoice.model_inventory(model)[
                    "parameter_count"
                ],
                "output": output.as_posix(),
                "status": "experimental_checkpoint_exported",
                "voice_parameters": glyphvoice.model_inventory(voice)[
                    "parameter_count"
                ],
            }
        ),
        flush=True,
    )


def _preflight(args: argparse.Namespace) -> None:
    context = _load_context(args)
    banks = _materialize_banks(context)
    model = glyphvoice.GlyphVoiceLocalModel()
    voice = glyphvoice.PageVoiceSet(len(context["candidate_ids"]))
    with torch.inference_mode():
        query = banks["real"][:2].float() / 255.0
        candidate = banks["candidate"][:, :2].float() / 255.0
        scores, embeddings, tokens = model.score(query, candidate)
        if scores.shape != (2, 21) or embeddings.shape != (2, glyphvoice.EMBED_DIM):
            raise GlyphVoiceTrainingError("local model preflight shape drifted")
        if tokens.shape != (2, glyphvoice.TOKEN_COUNT, glyphvoice.TOKEN_DIM):
            raise GlyphVoiceTrainingError("stroke token shape drifted")
        page_logits = scores[:, None].expand(-1, 2, -1)
        page_embeddings = embeddings[:, None].expand(-1, 2, -1)
        refined, _exception, residual = voice(
            page_logits,
            page_embeddings,
            torch.zeros(2, 2, dtype=torch.bool),
        )
        if not torch.equal(refined, page_logits) or int(torch.count_nonzero(residual)):
            raise GlyphVoiceTrainingError(
                "VoiceSet epoch-zero output is not exact local"
            )
    print(
        _canonical_json(
            {
                "banks": {name: list(value.shape) for name, value in banks.items()},
                "counts": _context_summary(context),
                "local_inventory": glyphvoice.model_inventory(model),
                "candidate_query_reference": _evaluate_candidate_query_retrieval(
                    model,
                    banks["candidate_queries"],
                    banks["candidate_query_targets"],
                    banks["candidate"],
                    device=torch.device("cpu"),
                    batch_size=128,
                ),
                "status": "preflight_passed",
                "teacher_reference": {
                    "development": _real_metrics(
                        context["teacher_scores"],
                        context["real_rows"],
                        context["candidate_ids"],
                        split="development",
                    ),
                    "train": _real_metrics(
                        context["teacher_scores"],
                        context["real_rows"],
                        context["candidate_ids"],
                        split="train",
                    ),
                },
                "voice_inventory": glyphvoice.model_inventory(voice),
            }
        )
    )


def _evaluate(args: argparse.Namespace) -> None:
    manifest = validate_output(args.output_dir, require_sources=True)
    context = _load_context(args)
    if tuple(manifest["candidate_ids"]) != tuple(context["candidate_ids"]):
        raise GlyphVoiceTrainingError("evaluation candidate binding drifted")
    banks = _materialize_banks(context)
    device = torch.device(args.device)
    local = glyphvoice.GlyphVoiceLocalModel().to(device)
    voice = glyphvoice.PageVoiceSet(len(context["candidate_ids"])).to(device)
    local.load_state_dict(
        load_file(str(args.output_dir / LOCAL_CHECKPOINT), device="cpu")
    )
    voice.load_state_dict(
        load_file(str(args.output_dir / VOICE_CHECKPOINT), device="cpu")
    )
    scores, embeddings = _score_real_rows(
        local,
        banks["real"],
        banks["candidate"],
        device=device,
        batch_size=args.evaluation_batch_size,
    )
    refined, _exceptions = _refine_real_scores(
        voice,
        scores,
        embeddings,
        context["real_rows"],
        device=device,
        batch_pages=args.voice_real_pages,
    )
    result = {
        "candidate_query": _evaluate_candidate_query_retrieval(
            local,
            banks["candidate_queries"],
            banks["candidate_query_targets"],
            banks["candidate"],
            device=device,
            batch_size=args.evaluation_batch_size,
        ),
        "local_development": _real_metrics(
            scores,
            context["real_rows"],
            context["candidate_ids"],
            split="development",
        ),
        "local_train": _real_metrics(
            scores,
            context["real_rows"],
            context["candidate_ids"],
            split="train",
        ),
        "synthetic_test": _evaluate_synthetic_retrieval(
            local,
            context["synthetic_rows"],
            banks["synthetic"],
            split="test",
            device=device,
        ),
        "voice_development": _real_metrics(
            refined,
            context["real_rows"],
            context["candidate_ids"],
            split="development",
        ),
        "voice_train": _real_metrics(
            refined,
            context["real_rows"],
            context["candidate_ids"],
            split="train",
        ),
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


def _add_source_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--render-bank-dir", type=Path, default=DEFAULT_RENDER_BANK)
    parser.add_argument("--role-dataset", type=Path, default=DEFAULT_ROLE_DATASET)
    parser.add_argument("--label-dir", type=Path, default=DEFAULT_LABEL_DIR)
    parser.add_argument("--master-dir", type=Path, default=DEFAULT_MASTER)
    parser.add_argument("--split-overlay-dir", type=Path, default=DEFAULT_SPLIT_OVERLAY)
    parser.add_argument("--teacher-checkpoint", type=Path, default=DEFAULT_TEACHER)


def _add_runtime_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--evaluation-batch-size", type=int, default=128)
    parser.add_argument("--voice-real-pages", type=int, default=10)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight")
    _add_source_options(preflight)

    train = subparsers.add_parser("train")
    _add_source_options(train)
    _add_runtime_options(train)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--seed", type=int, default=20260822)
    train.add_argument("--pretrain-epochs", type=int, default=24)
    train.add_argument("--pretrain-steps-per-epoch", type=int, default=16)
    train.add_argument("--pretrain-faces-per-batch", type=int, default=28)
    train.add_argument("--candidate-queries-per-candidate", type=int, default=2)
    train.add_argument("--pretrain-learning-rate", type=float, default=3e-4)
    train.add_argument("--real-epochs", type=int, default=20)
    train.add_argument("--real-batch-size", type=int, default=40)
    train.add_argument("--real-learning-rate", type=float, default=1.8e-4)
    train.add_argument("--real-matcher-only-epochs", type=int, default=4)
    train.add_argument("--voice-epochs", type=int, default=14)
    train.add_argument("--voice-steps-per-epoch", type=int, default=32)
    train.add_argument("--voice-synthetic-pages", type=int, default=16)
    train.add_argument("--voice-learning-rate", type=float, default=3e-4)

    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)

    evaluate = subparsers.add_parser("evaluate")
    _add_source_options(evaluate)
    _add_runtime_options(evaluate)
    evaluate.add_argument("--output-dir", type=Path, required=True)
    return parser


def _validate_positive_int(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise GlyphVoiceTrainingError(f"{name} must be a positive integer")


def _validate_args(args: argparse.Namespace) -> None:
    if args.command not in {"train", "evaluate"}:
        return
    _validate_positive_int(args.evaluation_batch_size, "evaluation_batch_size")
    _validate_positive_int(args.voice_real_pages, "voice_real_pages")
    if args.command == "train":
        for name in (
            "pretrain_epochs",
            "pretrain_steps_per_epoch",
            "pretrain_faces_per_batch",
            "candidate_queries_per_candidate",
            "real_epochs",
            "real_batch_size",
            "real_matcher_only_epochs",
            "voice_epochs",
            "voice_steps_per_epoch",
            "voice_synthetic_pages",
        ):
            _validate_positive_int(getattr(args, name), name)
        for name in (
            "pretrain_learning_rate",
            "real_learning_rate",
            "voice_learning_rate",
        ):
            value = getattr(args, name)
            if not isinstance(value, float) or not math.isfinite(value) or value <= 0:
                raise GlyphVoiceTrainingError(f"{name} must be a positive finite float")


def main() -> int:
    args = _build_parser().parse_args()
    try:
        _validate_args(args)
        if args.command == "preflight":
            _preflight(args)
        elif args.command == "train":
            _train(args)
        elif args.command == "validate":
            manifest = validate_output(args.output_dir, require_sources=True)
            print(
                _canonical_json(
                    {
                        "record_sha256": manifest["record_sha256"],
                        "status": "validated_experimental_checkpoint",
                    }
                )
            )
        elif args.command == "evaluate":
            _evaluate(args)
        else:  # pragma: no cover
            raise GlyphVoiceTrainingError("unknown command")
    except GlyphVoiceTrainingError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
