"""Shared fail-closed outline policy for automatic font QA decisions."""

from __future__ import annotations

import math
import re
from typing import Any, Mapping


MIN_EFFECTIVE_OUTLINE_CONTRAST_RATIO = 3.0
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class FontDecisionOutlinePolicyError(ValueError):
    """Raised when an applied automatic font has no safe effective outline."""


def validate_applied_font_decision_outline(
    decision: Mapping[str, Any], *, location: str
) -> float | None:
    """Validate one applied decision and return its recomputed contrast ratio."""

    if decision.get("applied") is not True:
        return None

    width = decision.get("effectiveOutlineWidthScale")
    if (
        isinstance(width, bool)
        or not isinstance(width, (int, float))
        or not math.isfinite(float(width))
        or float(width) <= 0
    ):
        raise FontDecisionOutlinePolicyError(
            f"{location} effectiveOutlineWidthScale must be a finite number > 0."
        )

    text_color = _require_hex_color(
        decision.get("effectiveTextColor"),
        f"{location} effectiveTextColor",
    )
    outline_color = _require_hex_color(
        decision.get("effectiveOutlineColor"),
        f"{location} effectiveOutlineColor",
    )
    contrast = text_outline_contrast_ratio(text_color, outline_color)
    if contrast < MIN_EFFECTIVE_OUTLINE_CONTRAST_RATIO:
        raise FontDecisionOutlinePolicyError(
            f"{location} effective text/outline contrast {contrast:.6g} is below "
            f"the required {MIN_EFFECTIVE_OUTLINE_CONTRAST_RATIO:g}."
        )
    return contrast


def text_outline_contrast_ratio(text_color: str, outline_color: str) -> float:
    """Return WCAG contrast between two validated six-digit hex colors."""

    text_luminance = _relative_luminance(text_color)
    outline_luminance = _relative_luminance(outline_color)
    lighter = max(text_luminance, outline_luminance)
    darker = min(text_luminance, outline_luminance)
    return (lighter + 0.05) / (darker + 0.05)


def _require_hex_color(value: Any, location: str) -> str:
    if not isinstance(value, str) or not HEX_COLOR_RE.fullmatch(value):
        raise FontDecisionOutlinePolicyError(
            f"{location} must be a six-digit hex color."
        )
    return value


def _relative_luminance(color: str) -> float:
    channels = [int(color[index : index + 2], 16) / 255 for index in (1, 3, 5)]

    def linearize(channel: float) -> float:
        if channel <= 0.04045:
            return channel / 12.92
        return ((channel + 0.055) / 1.055) ** 2.4

    red, green, blue = (linearize(channel) for channel in channels)
    return red * 0.2126 + green * 0.7152 + blue * 0.0722
