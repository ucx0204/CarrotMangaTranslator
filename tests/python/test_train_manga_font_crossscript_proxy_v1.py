from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import torch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "train_manga_font_crossscript_proxy_v1.py"
SPEC = importlib.util.spec_from_file_location("crossscript_proxy_v1", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_proxy_shapes_and_order_invariance() -> None:
    torch.manual_seed(7)
    model = MODULE.CrossScriptProxy().eval()
    support = torch.rand(
        2, MODULE.SUPPORT_COUNT, 1, MODULE.IMAGE_SIZE, MODULE.IMAGE_SIZE
    )
    content = torch.rand(2, 1, MODULE.IMAGE_SIZE, MODULE.IMAGE_SIZE)
    with torch.no_grad():
        logits, style = model(support, content)
        reversed_style = model.encode_style(support.flip(1))
    assert logits.shape == content.shape
    assert style.shape == (2, MODULE.STYLE_DIM)
    assert torch.equal(style, reversed_style)


def test_zero_decoder_starts_from_exact_neutral_glyph() -> None:
    torch.manual_seed(11)
    model = MODULE.CrossScriptProxy().eval()
    support = torch.rand(
        2, MODULE.SUPPORT_COUNT, 1, MODULE.IMAGE_SIZE, MODULE.IMAGE_SIZE
    )
    content = torch.rand(2, 1, MODULE.IMAGE_SIZE, MODULE.IMAGE_SIZE).clamp(
        1e-3, 1 - 1e-3
    )
    with torch.no_grad():
        logits, _ = model(support, content)
    assert torch.equal(logits, torch.logit(content))


def test_reconstruction_loss_is_finite() -> None:
    logits = torch.randn(3, 1, MODULE.IMAGE_SIZE, MODULE.IMAGE_SIZE)
    target = torch.rand_like(logits).round()
    loss, parts = MODULE.reconstruction_loss(logits, target)
    assert torch.isfinite(loss)
    assert set(parts) == {"bce", "dice", "edge", "projection", "ink_mass"}


def test_ink_mass_loss_detects_overly_heavy_output() -> None:
    target = torch.zeros(2, 1, MODULE.IMAGE_SIZE, MODULE.IMAGE_SIZE)
    target[:, :, 30:66, 42:54] = 1
    matching = torch.logit(target.clamp(1e-3, 1 - 1e-3))
    heavy_target = target.clone()
    heavy_target[:, :, 26:70, 36:60] = 1
    heavy = torch.logit(heavy_target.clamp(1e-3, 1 - 1e-3))
    _, matching_parts = MODULE.reconstruction_loss(
        matching, target, positive_weight=1.0, ink_mass_weight=2.0
    )
    _, heavy_parts = MODULE.reconstruction_loss(
        heavy, target, positive_weight=1.0, ink_mass_weight=2.0
    )
    assert heavy_parts["ink_mass"] > matching_parts["ink_mass"]


def test_meaning_free_contract_has_no_semantic_inputs() -> None:
    assert "ocr_text" in MODULE.BANNED_MODEL_INPUTS
    assert "translation" in MODULE.BANNED_MODEL_INPUTS
    assert len(MODULE.KOREAN_PROXY_GLYPHS) == 24
    assert len(set(MODULE.KOREAN_PROXY_GLYPHS)) == 24
