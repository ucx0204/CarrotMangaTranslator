#!/usr/bin/env python3
"""Build and validate the app runtime for the cross-script font proxy.

The runtime keeps the visual experiment's exact model and candidate recipe:
an unordered set of Japanese glyph pixels is encoded into a style vector,
up to two page-local voices are decoded onto neutral Korean glyphs, and the decoded
glyphs are compared with the production font render bank.  Text identities,
translations, titles, work ids, and the current application font never enter
either ONNX graph.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import shutil
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import torch
from safetensors.torch import load_file
from torch import Tensor, nn


ROOT = Path(__file__).resolve().parents[1]
PROXY_SCRIPT = ROOT / "scripts/train_manga_font_crossscript_proxy_v1.py"
SPEC = importlib.util.spec_from_file_location(
    "crossscript_proxy_runtime_source", PROXY_SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load cross-script proxy trainer")
proxy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = proxy
SPEC.loader.exec_module(proxy)

SCHEMA = "manga-font-crossscript-proxy-runtime-v2"
OWNER = "carrot-manga-translator/manga-font-crossscript-proxy-runtime-v2"
MARKER = ".owned.json"
MANIFEST = "runtime-manifest.json"
STYLE_MODEL = "style-encoder.onnx"
DECODER_MODEL = "glyph-decoder.onnx"
CANDIDATE_BANK = "candidate-glyphs.u8"
FILES = (MANIFEST, STYLE_MODEL, DECODER_MODEL, CANDIDATE_BANK)
DEFAULT_PROXY_DIR = Path("artifacts/manga-font-crossscript-proxy-v2-r1")
DEFAULT_ACTIVE_CATALOG = Path(
    "artifacts/font-matching-runtime-active21-v9-r33-page-common-user-v3-release-v2/"
    "auto-match-active-catalog.json"
)
DEFAULT_RENDER_BANK = Path("datasets/fontclip-font-render-bank-v2/manifest.json")
DEFAULT_OUTPUT = Path("src/main/runtime/font-matching-crossscript-proxy")
VOICE_COUNT = 2
INK_MASS_RIDGE = 0.001


class RuntimeBuildError(RuntimeError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def descriptor(path: Path) -> dict[str, Any]:
    return {
        "file": path.name,
        "byte_size": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def fit_ink_mass_calibration(
    faces: Sequence[Any], japanese: Tensor, korean: Tensor
) -> dict[str, Any]:
    """Fit source-Japanese to target-Korean stroke mass on development faces."""
    source = japanese.mean(dim=(1, 2, 3, 4)).double().numpy()
    target = korean.mean(dim=(1, 2, 3, 4)).double().numpy()
    development = np.asarray([face.split != "test" for face in faces])
    design = np.stack((np.ones_like(source), source), axis=1)
    penalty = np.diag((0.0, INK_MASS_RIDGE))
    coefficients = np.linalg.solve(
        design[development].T @ design[development] + penalty,
        design[development].T @ target[development],
    )
    predicted = design @ coefficients
    heldout = [
        {
            "face_id": face.face_id,
            "predicted_ink_mass": float(predicted[index]),
            "target_ink_mass": float(target[index]),
            "absolute_error": float(abs(predicted[index] - target[index])),
        }
        for index, face in enumerate(faces)
        if face.split == "test"
    ]
    return {
        "kind": "paired_cross_script_linear_ink_mass_v1",
        "input": "mean_canonical_japanese_support_ink",
        "target": "mean_canonical_korean_probe_ink",
        "intercept": float(coefficients[0]),
        "slope": float(coefficients[1]),
        "ridge": INK_MASS_RIDGE,
        "development_face_count": int(development.sum()),
        "development_family_count": len(
            {face.family_id for face in faces if face.split != "test"}
        ),
        "heldout_diagnostic_only": heldout,
        "heldout_mean_absolute_error": float(
            np.mean([row["absolute_error"] for row in heldout])
        ),
        "face_selection": (
            "family_rank_from_glyph_generator_then_nearest_learned_ink_mass"
        ),
    }


def read_object(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeBuildError(f"cannot read JSON object: {path}") from error
    if not isinstance(value, Mapping):
        raise RuntimeBuildError(f"JSON root must be an object: {path}")
    return value


class StyleRuntime(nn.Module):
    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, support: Tensor) -> Tensor:
        return self.model.encode_style(support)


class GlyphRuntime(nn.Module):
    def __init__(self, model: nn.Module, neutral: Tensor) -> None:
        super().__init__()
        self.model = model
        self.register_buffer("neutral", neutral)

    def forward(self, style: Tensor) -> Tensor:
        voice_count = style.shape[0]
        glyph_count = self.neutral.shape[0]
        neutral = (
            self.neutral.unsqueeze(0)
            .expand(voice_count, -1, -1, -1, -1)
            .reshape(voice_count * glyph_count, 1, proxy.IMAGE_SIZE, proxy.IMAGE_SIZE)
        )
        expanded_style = (
            style[:, None, :]
            .expand(-1, glyph_count, -1)
            .reshape(voice_count * glyph_count, proxy.STYLE_DIM)
        )
        return torch.sigmoid(self.model.decode(neutral, expanded_style)).reshape(
            voice_count,
            glyph_count,
            1,
            proxy.IMAGE_SIZE,
            proxy.IMAGE_SIZE,
        )


def export_models(model: nn.Module, neutral: Tensor, output: Path) -> None:
    support = torch.linspace(
        0.0,
        1.0,
        steps=2 * proxy.SUPPORT_COUNT * proxy.IMAGE_SIZE * proxy.IMAGE_SIZE,
        dtype=torch.float32,
    ).reshape(2, proxy.SUPPORT_COUNT, 1, proxy.IMAGE_SIZE, proxy.IMAGE_SIZE)
    style = torch.zeros((2, proxy.STYLE_DIM), dtype=torch.float32)
    with torch.no_grad():
        torch.onnx.export(
            StyleRuntime(model),
            (support,),
            output / STYLE_MODEL,
            input_names=["support"],
            output_names=["style"],
            dynamic_axes={"support": {0: "block_count"}, "style": {0: "block_count"}},
            opset_version=17,
            dynamo=False,
        )
        torch.onnx.export(
            GlyphRuntime(model, neutral),
            (style,),
            output / DECODER_MODEL,
            input_names=["style"],
            output_names=["glyphs"],
            dynamic_axes={"style": {0: "voice_count"}, "glyphs": {0: "voice_count"}},
            opset_version=17,
            dynamo=False,
        )
    onnx.checker.check_model(onnx.load(output / STYLE_MODEL))
    onnx.checker.check_model(onnx.load(output / DECODER_MODEL))


def render_candidate_bank(
    raw_candidates: Sequence[Mapping[str, Any]], active_ids: Sequence[str]
) -> tuple[bytes, list[dict[str, Any]]]:
    active = set(active_ids)
    bank = bytearray()
    candidates: list[dict[str, Any]] = []
    row_bytes = len(proxy.KOREAN_PROXY_GLYPHS) * proxy.IMAGE_SIZE**2
    for raw in raw_candidates:
        font_id = str(raw.get("font_id", ""))
        if font_id not in active:
            continue
        source = (ROOT / str(raw.get("source_file", ""))).resolve()
        if not source.is_file() or source.is_symlink():
            raise RuntimeBuildError(f"candidate font is missing or linked: {source}")
        expected_sha = str(raw.get("source_sha256", ""))
        if sha256_file(source) != expected_sha:
            raise RuntimeBuildError(f"candidate font SHA drifted: {source}")
        glyphs = np.stack(
            [
                proxy._render_glyph(source, 0, glyph)
                for glyph in proxy.KOREAN_PROXY_GLYPHS
            ]
        )
        encoded = np.rint(glyphs * 255.0).astype(np.uint8, copy=False).tobytes()
        if len(encoded) != row_bytes:
            raise RuntimeBuildError("candidate glyph byte inventory drifted")
        offset = len(bank)
        bank.extend(encoded)
        candidates.append(
            {
                "bank_byte_length": len(encoded),
                "bank_byte_offset": offset,
                "display_id": str(raw.get("display_id", "")),
                "font_id": font_id,
                "font_weight": int(raw.get("render_weight", 400)),
                "italic": str(raw.get("render_style", "normal")) == "italic",
                "source_font_sha256": expected_sha,
            }
        )
    if len(candidates) != len(raw_candidates):
        missing = sorted(
            {str(row.get("font_id", "")) for row in raw_candidates} - active
        )
        if missing:
            raise RuntimeBuildError(
                f"render bank contains candidates outside active catalog: {missing}"
            )
    if len(candidates) != 41:
        raise RuntimeBuildError(f"expected 41 production faces, got {len(candidates)}")
    if set(active_ids) != {row["font_id"] for row in candidates}:
        raise RuntimeBuildError(
            "candidate bank does not cover the active catalog exactly"
        )
    return bytes(bank), candidates


def parity_and_benchmark(
    model: nn.Module, neutral: Tensor, output: Path
) -> dict[str, Any]:
    generator = torch.Generator().manual_seed(20260822)
    support = torch.rand(
        (7, proxy.SUPPORT_COUNT, 1, proxy.IMAGE_SIZE, proxy.IMAGE_SIZE),
        generator=generator,
    )
    with torch.no_grad():
        expected_style = StyleRuntime(model)(support).numpy()
        expected_glyphs = GlyphRuntime(model, neutral)(
            torch.from_numpy(expected_style[:VOICE_COUNT])
        ).numpy()
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(8, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    style_session = ort.InferenceSession(
        str(output / STYLE_MODEL),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    decoder_session = ort.InferenceSession(
        str(output / DECODER_MODEL),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    actual_style = style_session.run(None, {"support": support.numpy()})[0]
    actual_glyphs = decoder_session.run(None, {"style": actual_style[:VOICE_COUNT]})[0]
    style_error = float(np.max(np.abs(actual_style - expected_style)))
    glyph_error = float(np.max(np.abs(actual_glyphs - expected_glyphs)))
    # ORT's fused bilinear/SiLU kernels differ slightly from eager PyTorch at
    # 96px, while remaining far below one 8-bit raster step (1/255).
    if style_error > 2e-5 or glyph_error > 1e-4:
        raise RuntimeBuildError(
            f"ONNX parity failed: style={style_error} glyph={glyph_error}"
        )
    timings: list[float] = []
    for _ in range(4):
        started = time.perf_counter()
        decoder_session.run(None, {"style": actual_style[:VOICE_COUNT]})
        timings.append((time.perf_counter() - started) * 1000.0)
    return {
        "cpu_logical_threads_used": options.intra_op_num_threads,
        "decoder_two_voice_warm_median_ms": float(np.median(timings[1:])),
        "glyph_max_absolute_error": glyph_error,
        "style_max_absolute_error": style_error,
    }


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.resolve()
    if not root.is_dir() or root.is_symlink():
        raise RuntimeBuildError(f"runtime is missing or linked: {root}")
    names = sorted(path.name for path in root.iterdir())
    expected_names = sorted((MARKER, *FILES))
    if names != expected_names:
        raise RuntimeBuildError(f"runtime inventory drifted: {names}")
    marker = read_object(root / MARKER)
    manifest = read_object(root / MANIFEST)
    if (
        marker.get("schema_version") != SCHEMA
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != SCHEMA
        or manifest.get("owner") != OWNER
        or manifest.get("status") != "production_connected_user_approved_visual_pilot"
    ):
        raise RuntimeBuildError("runtime identity drifted")
    artifacts = marker.get("artifacts")
    if not isinstance(artifacts, Mapping) or sorted(artifacts) != sorted(FILES):
        raise RuntimeBuildError("marker artifact inventory drifted")
    for name in FILES:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeBuildError(f"runtime artifact is missing or linked: {name}")
        raw = artifacts.get(name)
        if not isinstance(raw, Mapping):
            raise RuntimeBuildError(f"runtime descriptor is missing: {name}")
        if raw.get("byte_size") != path.stat().st_size or raw.get(
            "sha256"
        ) != sha256_file(path):
            raise RuntimeBuildError(f"runtime descriptor drifted: {name}")
    candidates = manifest.get("candidates")
    if not isinstance(candidates, list) or len(candidates) != 41:
        raise RuntimeBuildError("candidate inventory drifted")
    calibration = manifest.get("weight_calibration")
    if not isinstance(calibration, Mapping):
        raise RuntimeBuildError("weight calibration is missing")
    intercept = calibration.get("intercept")
    slope = calibration.get("slope")
    if (
        calibration.get("kind") != "paired_cross_script_linear_ink_mass_v1"
        or calibration.get("input") != "mean_canonical_japanese_support_ink"
        or calibration.get("target") != "mean_canonical_korean_probe_ink"
        or calibration.get("face_selection")
        != "family_rank_from_glyph_generator_then_nearest_learned_ink_mass"
        or isinstance(intercept, bool)
        or not isinstance(intercept, (int, float))
        or not math.isfinite(float(intercept))
        or isinstance(slope, bool)
        or not isinstance(slope, (int, float))
        or not math.isfinite(float(slope))
        or float(slope) <= 0
    ):
        raise RuntimeBuildError("weight calibration contract drifted")
    bank_size = (root / CANDIDATE_BANK).stat().st_size
    expected_bank_size = 41 * len(proxy.KOREAN_PROXY_GLYPHS) * proxy.IMAGE_SIZE**2
    if bank_size != expected_bank_size:
        raise RuntimeBuildError("candidate glyph bank size drifted")
    for model_name in (STYLE_MODEL, DECODER_MODEL):
        onnx.checker.check_model(onnx.load(root / model_name))
    return manifest


def build(args: argparse.Namespace) -> None:
    output = (ROOT / args.output_dir).resolve()
    if output.exists() or output.is_symlink():
        raise RuntimeBuildError(f"output already exists: {output}")
    staging = output.with_name(output.name + ".staging")
    if staging.exists() or staging.is_symlink():
        raise RuntimeBuildError(f"staging already exists: {staging}")
    proxy_dir = (ROOT / args.proxy_dir).resolve()
    checkpoint = proxy_dir / proxy.CHECKPOINT
    source_manifest = proxy_dir / proxy.MANIFEST
    if not checkpoint.is_file() or checkpoint.is_symlink():
        raise RuntimeBuildError(f"proxy checkpoint is missing or linked: {checkpoint}")
    source_contract = read_object(source_manifest)
    if source_contract.get("schema_version") != proxy.SCHEMA:
        raise RuntimeBuildError("proxy source schema drifted")
    active_catalog_path = (ROOT / args.active_catalog).resolve()
    render_bank_path = (ROOT / args.render_bank).resolve()
    active_catalog = read_object(active_catalog_path)
    raw_active_ids = active_catalog.get("candidate_ids")
    if not isinstance(raw_active_ids, list) or not all(
        isinstance(value, str) for value in raw_active_ids
    ):
        raise RuntimeBuildError("active catalog candidate ids are malformed")
    render_bank = read_object(render_bank_path)
    raw_candidates = render_bank.get("candidates")
    if not isinstance(raw_candidates, list) or not all(
        isinstance(row, Mapping) for row in raw_candidates
    ):
        raise RuntimeBuildError("render bank candidate inventory is malformed")
    staging.mkdir(parents=True)
    try:
        state = load_file(str(checkpoint), device="cpu")
        model = proxy.CrossScriptProxy()
        model.load_state_dict(state, strict=True)
        model.eval()
        faces = proxy.load_faces(ROOT, proxy.DEFAULT_CORPUS)
        neutral_face = next(
            face
            for face in faces
            if face.face_id == "gf-notosanskr-notosanskr-instance-wght400-face0"
        )
        japanese, korean, neutral = proxy.build_raster_cache(faces, neutral_face)
        ink_mass_calibration = fit_ink_mass_calibration(faces, japanese, korean)
        export_models(model, neutral, staging)
        bank, candidates = render_candidate_bank(raw_candidates, raw_active_ids)
        (staging / CANDIDATE_BANK).write_bytes(bank)
        validation = parity_and_benchmark(model, neutral, staging)
        manifest = {
            "candidate_bank": {
                "dtype": "uint8",
                "glyph_count": len(proxy.KOREAN_PROXY_GLYPHS),
                "image_size": proxy.IMAGE_SIZE,
                "layout": "candidate,glyph,channel,height,width",
            },
            "candidate_order_sha256": str(
                active_catalog.get("candidate_order_sha256", "")
            ),
            "candidates": candidates,
            "eligible_font_roles": [
                "dialogue",
                "narration",
                "thought",
                "whisper",
                "aside_balloon_edge",
                "emphasis_dialogue",
                "shout",
                "other",
            ],
            "excluded_font_roles": [
                "sign_ui_title",
                "sfx_impact",
                "sfx_motion",
                "sfx_ambient",
                "sfx_emotion",
                "sfx_comic",
            ],
            "meaning_free_contract": {
                "font_selection_inputs": [
                    "source_glyph_pixels",
                    "writing_direction",
                    "glyph_count_only",
                ],
                "forbidden_inputs": list(proxy.BANNED_MODEL_INPUTS),
                "semantic_font_role_is_eligibility_gate_only": True,
            },
            "model": {
                "decoder_input": ["voice_count", proxy.STYLE_DIM],
                "decoder_output": [
                    "voice_count",
                    len(proxy.KOREAN_PROXY_GLYPHS),
                    1,
                    proxy.IMAGE_SIZE,
                    proxy.IMAGE_SIZE,
                ],
                "style_input": [
                    "block_count",
                    proxy.SUPPORT_COUNT,
                    1,
                    proxy.IMAGE_SIZE,
                    proxy.IMAGE_SIZE,
                ],
                "style_output": ["block_count", proxy.STYLE_DIM],
            },
            "owner": OWNER,
            "page_policy": {
                "cluster_count": VOICE_COUNT,
                "cluster_method": "deterministic_normalized_farthest_kmeans20",
                "merge_singletons": False,
            },
            "weight_calibration": ink_mass_calibration,
            "production_connected": True,
            "release_published": False,
            "schema_version": SCHEMA,
            "source_bindings": {
                "active_catalog": descriptor(active_catalog_path),
                "proxy_checkpoint": descriptor(checkpoint),
                "proxy_manifest": descriptor(source_manifest),
                "render_bank": descriptor(render_bank_path),
            },
            "status": "production_connected_user_approved_visual_pilot",
            "validation": validation,
        }
        (staging / MANIFEST).write_text(
            canonical_json(manifest) + "\n", encoding="utf-8"
        )
        marker = {
            "artifacts": {name: descriptor(staging / name) for name in FILES},
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        with (staging / MARKER).open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(
                json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
            )
        validate_output(staging)
        output.parent.mkdir(parents=True, exist_ok=True)
        staging.replace(output)
        print(
            canonical_json(
                {"ok": True, "output": str(output), "validation": validation}
            )
        )
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_command = commands.add_parser("build")
    build_command.add_argument("--proxy-dir", default=str(DEFAULT_PROXY_DIR))
    build_command.add_argument("--active-catalog", default=str(DEFAULT_ACTIVE_CATALOG))
    build_command.add_argument("--render-bank", default=str(DEFAULT_RENDER_BANK))
    build_command.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    validate_command = commands.add_parser("validate")
    validate_command.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "build":
        build(args)
    else:
        output = (ROOT / args.output_dir).resolve()
        manifest = validate_output(output)
        print(
            canonical_json(
                {"ok": True, "output": str(output), "status": manifest["status"]}
            )
        )


if __name__ == "__main__":
    main()
