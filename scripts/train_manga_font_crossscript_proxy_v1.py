#!/usr/bin/env python3
"""Train a meaning-free Japanese-style to Korean-glyph proxy generator.

This is an isolated research trainer.  It does not import or mutate the
production font matcher.  The model sees only raster pixels:

* an unordered set of isolated Japanese glyph rasters supplies style;
* a fixed neutral Korean glyph raster supplies content geometry; and
* the target is the same Korean glyph rendered by the source font.

No OCR text, translation, reading order, semantic role, work identity,
candidate ID, or current application font enters the network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import shutil
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from safetensors.torch import load_file, save_file
from torch import Tensor, nn
from torch.nn import functional as F


SCHEMA = "manga-font-crossscript-proxy-v2"
OWNER = "carrot-manga-translator/manga-font-crossscript-proxy-v2"
MARKER = ".manga-font-crossscript-proxy-v2-owned.json"
MANIFEST = "manifest.json"
CHECKPOINT = "crossscript-proxy.safetensors"
DEFAULT_CORPUS = Path("artifacts/manga-font-glyphvoice-bridge-corpus-v3")
DEFAULT_OUTPUT = Path("artifacts/manga-font-crossscript-proxy-v2")
IMAGE_SIZE = 96
SUPPORT_COUNT = 8
STYLE_DIM = 192

# Isolated syllables selected for structural diversity.  Their order is fixed
# and they are never passed to the model as text tokens.
KOREAN_PROXY_GLYPHS = tuple("가너고무세조자이히해일말건정상변돌같괜줘있했싶믿")
JAPANESE_STYLE_GLYPHS = tuple("これはですをりたいかにしてもうだよがわっじきのろ")

BANNED_MODEL_INPUTS = (
    "ocr_text",
    "translation",
    "reading_order",
    "semantic_role",
    "work_id",
    "chapter_id",
    "candidate_id",
    "current_font",
)


class ProxyTrainingError(RuntimeError):
    pass


@dataclass(frozen=True)
class Face:
    face_id: str
    family_id: str
    split: str
    font_path: Path
    font_file: str
    face_index: int
    font_sha256: str


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


def descriptor(path: Path, *, relative_to: Path | None = None) -> dict[str, Any]:
    absolute = path.resolve()
    name = (
        absolute.relative_to(relative_to.resolve()).as_posix()
        if relative_to is not None
        else absolute.as_posix()
    )
    return {
        "file": name,
        "byte_size": absolute.stat().st_size,
        "sha256": sha256_file(absolute),
    }


def read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    rows: list[Mapping[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise ProxyTrainingError(f"non-object JSONL row: {path}:{line_number}")
            rows.append(value)
    return rows


def _valid_characters(rows: Sequence[Mapping[str, Any]], script: str) -> set[str]:
    valid: set[str] = set()
    for row in rows:
        if row.get("valid") is True and isinstance(row.get("character"), str):
            valid.add(str(row["character"]))
    return valid


def load_faces(repo_root: Path, corpus_dir: Path) -> list[Face]:
    faces_path = (repo_root / corpus_dir / "faces.jsonl").resolve()
    if not faces_path.is_file() or faces_path.is_symlink():
        raise ProxyTrainingError(f"missing regular faces.jsonl: {faces_path}")
    result: list[Face] = []
    for raw in read_jsonl(faces_path):
        font = raw.get("font")
        evidence = raw.get("glyph_evidence")
        if not isinstance(font, Mapping) or not isinstance(evidence, Mapping):
            raise ProxyTrainingError("cross-script face is missing font/evidence")
        jp_rows = evidence.get("japanese")
        ko_rows = evidence.get("korean")
        if not isinstance(jp_rows, list) or not isinstance(ko_rows, list):
            raise ProxyTrainingError("cross-script face glyph evidence is malformed")
        japanese_valid = _valid_characters(jp_rows, "japanese")
        korean_valid = _valid_characters(ko_rows, "korean")
        if not set(JAPANESE_STYLE_GLYPHS).issubset(japanese_valid):
            continue
        if not set(KOREAN_PROXY_GLYPHS).issubset(korean_valid):
            continue
        font_file = str(font.get("file"))
        font_path = (repo_root / font_file).resolve()
        if not font_path.is_file() or font_path.is_symlink():
            raise ProxyTrainingError(f"font is not a regular file: {font_path}")
        expected_sha = str(font.get("sha256"))
        actual_sha = sha256_file(font_path)
        if actual_sha != expected_sha:
            raise ProxyTrainingError(f"font SHA drifted: {font_path}")
        face_index = font.get("face_index")
        if (
            isinstance(face_index, bool)
            or not isinstance(face_index, int)
            or face_index < 0
        ):
            raise ProxyTrainingError("invalid face index")
        family_id = str(raw.get("family_id"))
        result.append(
            Face(
                face_id=str(raw.get("face_id")),
                family_id=family_id,
                split="test" if family_id == "nanum-gothic" else "development",
                font_path=font_path,
                font_file=font_file,
                face_index=face_index,
                font_sha256=actual_sha,
            )
        )
    if len(result) != 27:
        raise ProxyTrainingError(f"expected 27 bilingual-kana faces, got {len(result)}")
    if sum(face.split == "test" for face in result) != 4:
        raise ProxyTrainingError("expected exactly four held-out Nanum Gothic faces")
    if len({face.family_id for face in result if face.split != "test"}) != 11:
        raise ProxyTrainingError("expected eleven development font families")
    return result


def _render_glyph(font_path: Path, face_index: int, character: str) -> np.ndarray:
    """Render one glyph as canonical white-ink-on-black float32 raster."""
    render_size = 144
    try:
        font = ImageFont.truetype(str(font_path), size=render_size, index=face_index)
        bbox = font.getbbox(character, stroke_width=0)
    except (OSError, ValueError) as error:
        raise ProxyTrainingError(
            f"cannot render {character!r} from {font_path}"
        ) from error
    width = max(1, bbox[2] - bbox[0])
    height = max(1, bbox[3] - bbox[1])
    canvas = Image.new("L", (width + 32, height + 32), 0)
    draw = ImageDraw.Draw(canvas)
    draw.text((16 - bbox[0], 16 - bbox[1]), character, font=font, fill=255)
    ink_box = canvas.getbbox()
    if ink_box is None:
        raise ProxyTrainingError(f"blank glyph {character!r} from {font_path}")
    cropped = canvas.crop(ink_box)
    canvas.close()
    target = round(IMAGE_SIZE * 0.76)
    scale = min(target / cropped.width, target / cropped.height)
    resized = cropped.resize(
        (max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))),
        Image.Resampling.LANCZOS,
    )
    cropped.close()
    output = Image.new("L", (IMAGE_SIZE, IMAGE_SIZE), 0)
    output.paste(
        resized,
        ((IMAGE_SIZE - resized.width) // 2, (IMAGE_SIZE - resized.height) // 2),
    )
    resized.close()
    values = np.asarray(output, dtype=np.float32).copy() / 255.0
    output.close()
    if float(values.sum()) < 10.0:
        raise ProxyTrainingError(f"glyph has too little ink: {character!r} {font_path}")
    return values


def build_raster_cache(
    faces: Sequence[Face], neutral_face: Face
) -> tuple[Tensor, Tensor, Tensor]:
    japanese = np.stack(
        [
            np.stack(
                [
                    _render_glyph(face.font_path, face.face_index, char)
                    for char in JAPANESE_STYLE_GLYPHS
                ]
            )
            for face in faces
        ]
    )
    korean = np.stack(
        [
            np.stack(
                [
                    _render_glyph(face.font_path, face.face_index, char)
                    for char in KOREAN_PROXY_GLYPHS
                ]
            )
            for face in faces
        ]
    )
    neutral = np.stack(
        [
            _render_glyph(neutral_face.font_path, neutral_face.face_index, char)
            for char in KOREAN_PROXY_GLYPHS
        ]
    )
    return (
        torch.from_numpy(japanese)[:, :, None],
        torch.from_numpy(korean)[:, :, None],
        torch.from_numpy(neutral)[:, None],
    )


class ConvNormAct(nn.Module):
    def __init__(
        self, input_channels: int, output_channels: int, *, stride: int = 1
    ) -> None:
        super().__init__()
        groups = min(8, output_channels)
        while output_channels % groups:
            groups -= 1
        self.layers = nn.Sequential(
            nn.Conv2d(input_channels, output_channels, 3, stride=stride, padding=1),
            nn.GroupNorm(groups, output_channels),
            nn.SiLU(inplace=True),
        )

    def forward(self, inputs: Tensor) -> Tensor:
        return self.layers(inputs)


class ResidualBlock(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.first = ConvNormAct(channels, channels)
        groups = min(8, channels)
        while channels % groups:
            groups -= 1
        self.second = nn.Sequential(
            nn.Conv2d(channels, channels, 3, padding=1),
            nn.GroupNorm(groups, channels),
        )

    def forward(self, inputs: Tensor) -> Tensor:
        return F.silu(inputs + self.second(self.first(inputs)), inplace=True)


class StyleEncoder(nn.Module):
    """Permutation-invariant encoder for an unordered Japanese glyph set."""

    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            ConvNormAct(1, 32, stride=2),
            ResidualBlock(32),
            ConvNormAct(32, 64, stride=2),
            ResidualBlock(64),
            ConvNormAct(64, 128, stride=2),
            ResidualBlock(128),
            ConvNormAct(128, 192, stride=2),
            ResidualBlock(192),
        )
        self.projection = nn.Sequential(
            nn.Linear(384, 256),
            nn.SiLU(),
            nn.Linear(256, STYLE_DIM),
            nn.LayerNorm(STYLE_DIM),
        )

    def forward(self, support: Tensor) -> Tensor:
        if support.ndim != 5 or support.shape[2] != 1:
            raise ValueError("support must be [batch,set,1,height,width]")
        batch, count = support.shape[:2]
        features = self.features(support.flatten(0, 1))
        pooled = torch.cat(
            (features.mean(dim=(2, 3)), features.std(dim=(2, 3), unbiased=False)), dim=1
        ).reshape(batch, count, -1)
        # Accumulate the tiny set in float64 before returning to float32.  This
        # removes float32 reduction-order noise, so reversing the glyph set is
        # byte-identical while keeping the operation differentiable.
        pooled_set = pooled.to(torch.float64).mean(dim=1).to(pooled.dtype)
        return self.projection(pooled_set)


class ContentEncoder(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.level0 = nn.Sequential(ConvNormAct(1, 32), ResidualBlock(32))
        self.level1 = nn.Sequential(ConvNormAct(32, 64, stride=2), ResidualBlock(64))
        self.level2 = nn.Sequential(ConvNormAct(64, 128, stride=2), ResidualBlock(128))
        self.level3 = nn.Sequential(ConvNormAct(128, 192, stride=2), ResidualBlock(192))

    def forward(self, inputs: Tensor) -> tuple[Tensor, Tensor, Tensor, Tensor]:
        level0 = self.level0(inputs)
        level1 = self.level1(level0)
        level2 = self.level2(level1)
        level3 = self.level3(level2)
        return level0, level1, level2, level3


class StyledBlock(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.norm1 = nn.GroupNorm(min(8, channels), channels, affine=False)
        self.norm2 = nn.GroupNorm(min(8, channels), channels, affine=False)
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1)
        self.film = nn.Linear(STYLE_DIM, channels * 4)
        nn.init.zeros_(self.film.bias)

    def forward(self, inputs: Tensor, style: Tensor) -> Tensor:
        scale1, bias1, scale2, bias2 = self.film(style).chunk(4, dim=1)
        hidden = self.norm1(inputs)
        hidden = hidden * (1.0 + 0.25 * torch.tanh(scale1)[:, :, None, None])
        hidden = hidden + bias1[:, :, None, None]
        hidden = F.silu(self.conv1(hidden), inplace=True)
        hidden = self.norm2(hidden)
        hidden = hidden * (1.0 + 0.25 * torch.tanh(scale2)[:, :, None, None])
        hidden = hidden + bias2[:, :, None, None]
        return F.silu(inputs + self.conv2(F.silu(hidden, inplace=True)), inplace=True)


class ProxyDecoder(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.deep = StyledBlock(192)
        self.up2 = ConvNormAct(192 + 128, 128)
        self.block2 = StyledBlock(128)
        self.up1 = ConvNormAct(128 + 64, 64)
        self.block1 = StyledBlock(64)
        self.up0 = ConvNormAct(64 + 32, 48)
        self.block0 = StyledBlock(48)
        self.output = nn.Sequential(
            nn.Conv2d(48, 32, 3, padding=1),
            nn.SiLU(inplace=True),
            nn.Conv2d(32, 1, 1),
        )
        nn.init.zeros_(self.output[-1].weight)
        nn.init.zeros_(self.output[-1].bias)

    def forward(
        self, content: tuple[Tensor, Tensor, Tensor, Tensor], style: Tensor
    ) -> Tensor:
        level0, level1, level2, level3 = content
        hidden = self.deep(level3, style)
        hidden = F.interpolate(
            hidden, size=level2.shape[-2:], mode="bilinear", align_corners=False
        )
        hidden = self.block2(self.up2(torch.cat((hidden, level2), dim=1)), style)
        hidden = F.interpolate(
            hidden, size=level1.shape[-2:], mode="bilinear", align_corners=False
        )
        hidden = self.block1(self.up1(torch.cat((hidden, level1), dim=1)), style)
        hidden = F.interpolate(
            hidden, size=level0.shape[-2:], mode="bilinear", align_corners=False
        )
        hidden = self.block0(self.up0(torch.cat((hidden, level0), dim=1)), style)
        return self.output(hidden)


class CrossScriptProxy(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.style_encoder = StyleEncoder()
        self.content_encoder = ContentEncoder()
        self.decoder = ProxyDecoder()

    def encode_style(self, japanese_support: Tensor) -> Tensor:
        return self.style_encoder(japanese_support)

    def decode(self, neutral_korean: Tensor, style: Tensor) -> Tensor:
        residual = self.decoder(self.content_encoder(neutral_korean), style)
        neutral_logits = torch.logit(neutral_korean.clamp(1e-3, 1.0 - 1e-3))
        return neutral_logits + residual

    def forward(
        self, japanese_support: Tensor, neutral_korean: Tensor
    ) -> tuple[Tensor, Tensor]:
        style = self.encode_style(japanese_support)
        return self.decode(neutral_korean, style), style


def _sobel(values: Tensor) -> Tensor:
    kernel_x = values.new_tensor(
        [[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]]
    ).reshape(1, 1, 3, 3)
    kernel_y = kernel_x.transpose(2, 3)
    x = F.conv2d(values, kernel_x, padding=1)
    y = F.conv2d(values, kernel_y, padding=1)
    return torch.sqrt(x.square() + y.square() + 1e-8)


def reconstruction_loss(
    logits: Tensor,
    target: Tensor,
    *,
    positive_weight: float = 3.0,
    ink_mass_weight: float = 0.0,
) -> tuple[Tensor, dict[str, Tensor]]:
    prediction = torch.sigmoid(logits)
    positive_weight_tensor = target.new_tensor(positive_weight)
    bce = F.binary_cross_entropy_with_logits(
        logits, target, pos_weight=positive_weight_tensor
    )
    intersection = (prediction * target).sum(dim=(1, 2, 3))
    dice = (
        1.0
        - (
            (2.0 * intersection + 1.0)
            / (prediction.sum(dim=(1, 2, 3)) + target.sum(dim=(1, 2, 3)) + 1.0)
        ).mean()
    )
    edge = F.l1_loss(_sobel(prediction), _sobel(target))
    projection = 0.5 * (
        F.l1_loss(prediction.mean(dim=2), target.mean(dim=2))
        + F.l1_loss(prediction.mean(dim=3), target.mean(dim=3))
    )
    ink_mass = F.l1_loss(prediction.mean(dim=(1, 2, 3)), target.mean(dim=(1, 2, 3)))
    total = (
        bce + 0.8 * dice + 0.35 * edge + 0.5 * projection + ink_mass_weight * ink_mass
    )
    return total, {
        "bce": bce,
        "dice": dice,
        "edge": edge,
        "projection": projection,
        "ink_mass": ink_mass,
    }


def _sample_support_indices(
    batch: int, count: int, generator: torch.Generator, device: torch.device
) -> tuple[Tensor, Tensor]:
    first: list[Tensor] = []
    second: list[Tensor] = []
    for _ in range(batch):
        order = torch.randperm(len(JAPANESE_STYLE_GLYPHS), generator=generator)
        first.append(order[:count])
        second.append(order[count : count * 2])
    return torch.stack(first).to(device), torch.stack(second).to(device)


def _gather_support(
    cache: Tensor, face_indices: Tensor, glyph_indices: Tensor
) -> Tensor:
    return cache[face_indices[:, None], glyph_indices]


@torch.no_grad()
def evaluate_loss(
    model: CrossScriptProxy,
    japanese: Tensor,
    korean: Tensor,
    neutral: Tensor,
    face_indices: Sequence[int],
    device: torch.device,
    *,
    positive_weight: float,
    ink_mass_weight: float,
) -> float:
    model.eval()
    losses: list[float] = []
    for face_index in face_indices:
        support = japanese[face_index : face_index + 1, :SUPPORT_COUNT].to(device)
        style = model.encode_style(support)
        for start in range(0, len(KOREAN_PROXY_GLYPHS), 8):
            stop = min(len(KOREAN_PROXY_GLYPHS), start + 8)
            batch = stop - start
            logits = model.decode(
                neutral[start:stop].to(device), style.expand(batch, -1)
            )
            loss, _ = reconstruction_loss(
                logits,
                korean[face_index, start:stop].to(device),
                positive_weight=positive_weight,
                ink_mass_weight=ink_mass_weight,
            )
            losses.append(float(loss.item()))
    return float(sum(losses) / max(1, len(losses)))


def _label_font(neutral_face: Face, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(
        str(neutral_face.font_path), size=size, index=neutral_face.face_index
    )


def _ink_to_pil(values: Tensor, size: int) -> Image.Image:
    array = (
        values.detach()
        .float()
        .clamp(0, 1)
        .mul(255)
        .round()
        .to(torch.uint8)
        .cpu()
        .numpy()
    )
    image = Image.fromarray(255 - array).convert("RGB")
    return image.resize((size, size), Image.Resampling.NEAREST)


@torch.no_grad()
def write_visuals(
    model: CrossScriptProxy,
    faces: Sequence[Face],
    japanese: Tensor,
    korean: Tensor,
    neutral: Tensor,
    neutral_face: Face,
    output_dir: Path,
    device: torch.device,
) -> list[dict[str, Any]]:
    visual_dir = output_dir / "visual"
    visual_dir.mkdir(parents=True, exist_ok=False)
    label = _label_font(neutral_face, 26)
    small_label = _label_font(neutral_face, 19)
    rows: list[dict[str, Any]] = []
    test_indices = [index for index, face in enumerate(faces) if face.split == "test"]
    target_indices = (0, 3, 7, 11, 16, 20)
    support_ids = torch.arange(SUPPORT_COUNT)
    model.eval()
    for face_index in test_indices:
        face = faces[face_index]
        support = japanese[face_index : face_index + 1, support_ids].to(device)
        style = model.encode_style(support)
        for target_index in target_indices:
            logits = model.decode(
                neutral[target_index : target_index + 1].to(device), style
            )
            generated = torch.sigmoid(logits)[0, 0]
            truth = korean[face_index, target_index, 0]
            neutral_glyph = neutral[target_index, 0]
            canvas = Image.new("RGB", (980, 430), "white")
            draw = ImageDraw.Draw(canvas)
            draw.text(
                (24, 16),
                f"보지 않은 테스트 폰트: {face.face_id}",
                fill="black",
                font=small_label,
            )
            draw.text(
                (24, 52),
                "일본어 스타일 입력 (순서 없는 8글자)",
                fill="black",
                font=small_label,
            )
            x = 24
            for support_index in support_ids.tolist():
                glyph = _ink_to_pil(japanese[face_index, support_index, 0], 68)
                canvas.paste(glyph, (x, 84))
                glyph.close()
                x += 76
            columns = (
                ("내용 골격", neutral_glyph),
                ("AI 생성 한글", generated),
                ("실제 같은 폰트", truth),
            )
            for column, (title, glyph_values) in enumerate(columns):
                left = 60 + column * 305
                draw.text((left, 183), title, fill="black", font=label)
                glyph = _ink_to_pil(glyph_values, 188)
                canvas.paste(glyph, (left + 20, 226))
                glyph.close()
            target = KOREAN_PROXY_GLYPHS[target_index]
            file_name = f"{face.face_id}__u{ord(target):04x}.png"
            path = visual_dir / file_name
            canvas.save(path)
            canvas.close()
            rows.append(
                {
                    "face_id": face.face_id,
                    "family_id": face.family_id,
                    "target_codepoint": f"U+{ord(target):04X}",
                    "target_character": target,
                    "file": path.relative_to(output_dir).as_posix(),
                    "sha256": sha256_file(path),
                }
            )
    return rows


def _safe_new_output(path: Path) -> Path:
    absolute = path.expanduser().absolute()
    if absolute.exists() or absolute.is_symlink():
        raise ProxyTrainingError(f"output already exists: {absolute}")
    absolute.parent.mkdir(parents=True, exist_ok=True)
    staging = absolute.with_name(absolute.name + ".staging")
    if staging.exists() or staging.is_symlink():
        raise ProxyTrainingError(f"staging already exists: {staging}")
    staging.mkdir()
    return staging


def _model_parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())


def _load_initial_state(initial_artifact: str | None) -> dict[str, Tensor] | None:
    if initial_artifact is None:
        return None
    root = Path(initial_artifact).expanduser().absolute().resolve()
    manifest_path = root / MANIFEST
    checkpoint_path = root / CHECKPOINT
    if (
        root.is_symlink()
        or not root.is_dir()
        or manifest_path.is_symlink()
        or not manifest_path.is_file()
        or checkpoint_path.is_symlink()
        or not checkpoint_path.is_file()
    ):
        raise ProxyTrainingError("initial artifact is missing, linked, or malformed")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != SCHEMA or manifest.get("owner") != OWNER:
        raise ProxyTrainingError("initial artifact identity drifted")
    bindings = manifest.get("bindings")
    if not isinstance(bindings, Mapping) or bindings.get("checkpoint") != descriptor(
        checkpoint_path, relative_to=root
    ):
        raise ProxyTrainingError("initial checkpoint binding drifted")
    return load_file(str(checkpoint_path), device="cpu")


def _configure_trainable_scope(model: CrossScriptProxy, scope: str) -> list[Tensor]:
    if scope == "all":
        return list(model.parameters())
    if scope != "decoder-output":
        raise ProxyTrainingError(f"unsupported trainable scope: {scope}")
    trainable: list[Tensor] = []
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith("decoder.output."))
        if parameter.requires_grad:
            trainable.append(parameter)
    if not trainable:
        raise ProxyTrainingError("decoder-output scope selected no parameters")
    return trainable


def train(args: argparse.Namespace) -> None:
    repo_root = Path.cwd().resolve()
    corpus_dir = Path(args.corpus_dir)
    output_dir = Path(args.output_dir).expanduser().absolute()
    staging = _safe_new_output(output_dir)
    started = time.monotonic()
    try:
        faces = load_faces(repo_root, corpus_dir)
        development_indices = [
            index for index, face in enumerate(faces) if face.split != "test"
        ]
        test_indices = [
            index for index, face in enumerate(faces) if face.split == "test"
        ]
        if len(development_indices) != 23 or len(test_indices) != 4:
            raise ProxyTrainingError("development/test face partition drifted")
        neutral_face = next(
            face
            for face in faces
            if face.face_id == "gf-notosanskr-notosanskr-instance-wght400-face0"
        )
        japanese_cpu, korean_cpu, neutral_cpu = build_raster_cache(faces, neutral_face)
        device = torch.device(args.device)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise ProxyTrainingError("CUDA requested but unavailable")
        torch.manual_seed(args.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(args.seed)
        random.seed(args.seed)
        np.random.seed(args.seed)
        model = CrossScriptProxy().to(device)
        initial_state = _load_initial_state(args.init_artifact)
        if initial_state is not None:
            model.load_state_dict(initial_state, strict=True)
        trainable_parameters = _configure_trainable_scope(model, args.trainable_scope)
        optimizer = torch.optim.AdamW(
            trainable_parameters,
            lr=args.learning_rate,
            weight_decay=args.weight_decay,
        )
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            optimizer, T_max=max(1, args.steps), eta_min=args.learning_rate * 0.05
        )
        generator = torch.Generator(device="cpu").manual_seed(args.seed + 11)
        japanese = japanese_cpu.to(device)
        korean = korean_cpu.to(device)
        neutral = neutral_cpu.to(device)
        development = torch.tensor(development_indices, dtype=torch.long)
        best_state: dict[str, Tensor] | None = None
        final_test_diagnostic = math.inf
        history: list[dict[str, Any]] = []
        model.train()
        for step in range(1, args.steps + 1):
            face_choice = torch.randint(
                len(development_indices), (args.batch_size,), generator=generator
            )
            face_indices_cpu = development[face_choice]
            target_indices_cpu = torch.randint(
                len(KOREAN_PROXY_GLYPHS), (args.batch_size,), generator=generator
            )
            first_ids, second_ids = _sample_support_indices(
                args.batch_size, SUPPORT_COUNT, generator, device
            )
            face_indices = face_indices_cpu.to(device)
            target_indices = target_indices_cpu.to(device)
            first_support = _gather_support(japanese, face_indices, first_ids)
            second_support = _gather_support(japanese, face_indices, second_ids)
            content = neutral[target_indices]
            target = korean[face_indices, target_indices]
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(
                device_type=device.type,
                dtype=torch.bfloat16,
                enabled=device.type == "cuda",
            ):
                first_logits, first_style = model(first_support, content)
                second_logits, second_style = model(second_support, content)
                first_reconstruction, parts = reconstruction_loss(
                    first_logits,
                    target,
                    positive_weight=args.positive_weight,
                    ink_mass_weight=args.ink_mass_weight,
                )
                second_reconstruction, _ = reconstruction_loss(
                    second_logits,
                    target,
                    positive_weight=args.positive_weight,
                    ink_mass_weight=args.ink_mass_weight,
                )
                style_consistency = F.mse_loss(first_style, second_style)
                output_consistency = F.l1_loss(
                    torch.sigmoid(first_logits), torch.sigmoid(second_logits)
                )
                # Prevent a constant style code without introducing a semantic classifier.
                centered = first_style - first_style.mean(dim=0, keepdim=True)
                style_variance = F.relu(
                    0.20 - centered.std(dim=0, unbiased=False)
                ).mean()
                neutral_logits = torch.logit(content.clamp(1e-3, 1.0 - 1e-3))
                residual_magnitude = 0.5 * (
                    (first_logits - neutral_logits).abs().mean()
                    + (second_logits - neutral_logits).abs().mean()
                )
                loss = (
                    0.5 * (first_reconstruction + second_reconstruction)
                    + args.style_consistency_weight * style_consistency
                    + args.output_consistency_weight * output_consistency
                    + args.residual_weight * residual_magnitude
                    + 0.05 * style_variance
                )
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            optimizer.step()
            scheduler.step()
            if step == 1 or step % args.report_every == 0 or step == args.steps:
                row = {
                    "step": step,
                    "train_loss": float(loss.detach().item()),
                    "bce": float(parts["bce"].detach().item()),
                    "dice": float(parts["dice"].detach().item()),
                    "ink_mass": float(parts["ink_mass"].detach().item()),
                    "style_consistency": float(style_consistency.detach().item()),
                    "output_consistency": float(output_consistency.detach().item()),
                    "residual_magnitude": float(residual_magnitude.detach().item()),
                    "learning_rate": float(scheduler.get_last_lr()[0]),
                }
                history.append(row)
                print(canonical_json(row), flush=True)
                model.train()
        best_state = {
            name: tensor.detach().cpu() for name, tensor in model.state_dict().items()
        }
        if best_state is None:
            raise ProxyTrainingError("training produced no checkpoint")
        save_file(best_state, str(staging / CHECKPOINT))
        model.load_state_dict(best_state)
        model.to(device)
        # The held-out Nanum family is opened only after the final checkpoint is fixed.
        final_test_diagnostic = evaluate_loss(
            model,
            japanese_cpu,
            korean_cpu,
            neutral_cpu,
            test_indices,
            device,
            positive_weight=args.positive_weight,
            ink_mass_weight=args.ink_mass_weight,
        )
        visuals = write_visuals(
            model,
            faces,
            japanese_cpu,
            korean_cpu,
            neutral_cpu,
            neutral_face,
            staging,
            device,
        )
        corpus_faces_path = (repo_root / corpus_dir / "faces.jsonl").resolve()
        script_path = Path(__file__).resolve()
        manifest: dict[str, Any] = {
            "schema_version": SCHEMA,
            "owner": OWNER,
            "status": "experimental_visual_proxy_generated",
            "production_connected": False,
            "promotion_claimed": False,
            "meaning_free_contract": {
                "network_inputs": [
                    "unordered_japanese_glyph_pixels",
                    "neutral_korean_glyph_pixels",
                ],
                "banned_inputs": list(BANNED_MODEL_INPUTS),
                "style_aggregation": "exact permutation-invariant mean",
                "target_is_single_isolated_glyph": True,
            },
            "configuration": {
                "image_size": IMAGE_SIZE,
                "support_count": SUPPORT_COUNT,
                "korean_proxy_glyph_count": len(KOREAN_PROXY_GLYPHS),
                "japanese_style_glyph_count": len(JAPANESE_STYLE_GLYPHS),
                "steps": args.steps,
                "batch_size": args.batch_size,
                "learning_rate": args.learning_rate,
                "weight_decay": args.weight_decay,
                "style_consistency_weight": args.style_consistency_weight,
                "output_consistency_weight": args.output_consistency_weight,
                "residual_weight": args.residual_weight,
                "positive_weight": args.positive_weight,
                "ink_mass_weight": args.ink_mass_weight,
                "trainable_scope": args.trainable_scope,
                "initial_artifact": (
                    Path(args.init_artifact).expanduser().absolute().as_posix()
                    if args.init_artifact
                    else None
                ),
                "seed": args.seed,
                "device": str(device),
            },
            "data": {
                "development_faces": [
                    asdict(face) | {"font_path": face.font_file}
                    for face in faces
                    if face.split != "test"
                ],
                "heldout_test_faces": [
                    asdict(face) | {"font_path": face.font_file}
                    for face in faces
                    if face.split == "test"
                ],
                "heldout_family_ids": sorted(
                    {face.family_id for face in faces if face.split == "test"}
                ),
                "korean_proxy_codepoints": [
                    f"U+{ord(value):04X}" for value in KOREAN_PROXY_GLYPHS
                ],
                "japanese_style_codepoints": [
                    f"U+{ord(value):04X}" for value in JAPANESE_STYLE_GLYPHS
                ],
            },
            "bindings": {
                "producer": descriptor(script_path),
                "faces": descriptor(corpus_faces_path),
                "checkpoint": descriptor(staging / CHECKPOINT, relative_to=staging),
                **(
                    {
                        "initial_checkpoint": descriptor(
                            Path(args.init_artifact).expanduser().absolute().resolve()
                            / CHECKPOINT
                        )
                    }
                    if args.init_artifact
                    else {}
                ),
            },
            "model": {
                "parameter_count": _model_parameter_count(model),
                "architecture": "unordered-style-set-encoder+film-unet-glyph-decoder",
            },
            "history": history,
            "final_test_diagnostic_loss": final_test_diagnostic,
            "visuals": visuals,
            "training_seconds": max(time.monotonic() - started, 1e-9),
        }
        # dataclasses contain Paths; replace them with sealed repo-relative strings.
        for group in ("development_faces", "heldout_test_faces"):
            for row in manifest["data"][group]:
                row["font_path"] = row.pop("font_file")
        manifest_path = staging / MANIFEST
        manifest_path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")
        marker = {
            "schema_version": SCHEMA,
            "owner": OWNER,
            "manifest": descriptor(manifest_path, relative_to=staging),
        }
        (staging / MARKER).write_text(canonical_json(marker) + "\n", encoding="utf-8")
        staging.replace(output_dir)
        print(
            canonical_json(
                {
                    "ok": True,
                    "output_dir": output_dir.as_posix(),
                    "visual_count": len(visuals),
                    "parameter_count": _model_parameter_count(model),
                }
            )
        )
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise


def validate(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir).expanduser().absolute().resolve()
    marker_path = output_dir / MARKER
    manifest_path = output_dir / MANIFEST
    checkpoint_path = output_dir / CHECKPOINT
    for path in (marker_path, manifest_path, checkpoint_path):
        if path.is_symlink() or not path.is_file():
            raise ProxyTrainingError(f"missing regular artifact file: {path}")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if marker.get("schema_version") != SCHEMA or marker.get("owner") != OWNER:
        raise ProxyTrainingError("marker identity drifted")
    if manifest.get("schema_version") != SCHEMA or manifest.get("owner") != OWNER:
        raise ProxyTrainingError("manifest identity drifted")
    expected_manifest = marker.get("manifest")
    if expected_manifest != descriptor(manifest_path, relative_to=output_dir):
        raise ProxyTrainingError("marker/manifest binding drifted")
    bindings = manifest.get("bindings")
    if not isinstance(bindings, Mapping):
        raise ProxyTrainingError("manifest bindings missing")
    if bindings.get("checkpoint") != descriptor(
        checkpoint_path, relative_to=output_dir
    ):
        raise ProxyTrainingError("checkpoint binding drifted")
    state = load_file(str(checkpoint_path), device="cpu")
    model = CrossScriptProxy()
    model.load_state_dict(state, strict=True)
    if manifest.get("model", {}).get("parameter_count") != _model_parameter_count(
        model
    ):
        raise ProxyTrainingError("parameter count drifted")
    visuals = manifest.get("visuals")
    if not isinstance(visuals, list) or len(visuals) != 24:
        raise ProxyTrainingError("visual inventory drifted")
    for row in visuals:
        if not isinstance(row, Mapping):
            raise ProxyTrainingError("visual row malformed")
        path = output_dir / str(row.get("file"))
        if (
            path.is_symlink()
            or not path.is_file()
            or sha256_file(path) != row.get("sha256")
        ):
            raise ProxyTrainingError(f"visual binding drifted: {path}")
    print(canonical_json({"ok": True, "visual_count": len(visuals)}))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    train_parser = subparsers.add_parser("train")
    train_parser.add_argument("--corpus-dir", default=str(DEFAULT_CORPUS))
    train_parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    train_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    train_parser.add_argument("--steps", type=int, default=4000)
    train_parser.add_argument("--batch-size", type=int, default=28)
    train_parser.add_argument("--learning-rate", type=float, default=3e-4)
    train_parser.add_argument("--weight-decay", type=float, default=1e-4)
    train_parser.add_argument("--style-consistency-weight", type=float, default=0.4)
    train_parser.add_argument("--output-consistency-weight", type=float, default=0.25)
    train_parser.add_argument("--residual-weight", type=float, default=0.015)
    train_parser.add_argument("--positive-weight", type=float, default=3.0)
    train_parser.add_argument("--ink-mass-weight", type=float, default=0.0)
    train_parser.add_argument(
        "--trainable-scope", choices=("all", "decoder-output"), default="all"
    )
    train_parser.add_argument("--init-artifact")
    train_parser.add_argument("--report-every", type=int, default=200)
    train_parser.add_argument("--seed", type=int, default=20260822)
    train_parser.set_defaults(handler=train)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    validate_parser.set_defaults(handler=validate)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if getattr(args, "steps", 1) <= 0 or getattr(args, "batch_size", 1) <= 0:
        raise ProxyTrainingError("steps and batch size must be positive")
    if getattr(args, "positive_weight", 1.0) <= 0:
        raise ProxyTrainingError("positive weight must be positive")
    if getattr(args, "ink_mass_weight", 0.0) < 0:
        raise ProxyTrainingError("ink mass weight must be non-negative")
    args.handler(args)


if __name__ == "__main__":
    main()
