export const MIN_AUTOMATIC_TEXT_OUTLINE_CONTRAST_RATIO = 3;

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_OUTLINE_COLOR = "#ffffff";
const DARK_OUTLINE_COLOR = "#111111";
const LIGHT_OUTLINE_COLOR = "#ffffff";

type TextOutlineStyle = Readonly<{
  automaticFontMatch?: unknown;
  outlineColor?: string;
  outlineWidthScale?: number;
  textColor?: string;
}>;

export function resolveEffectiveTextOutlineWidthScale(
  style: TextOutlineStyle,
): number {
  return normalizeOutlineWidthScale(style.outlineWidthScale);
}

export function resolveEffectiveTextOutlineWidthPx(
  style: TextOutlineStyle,
  fontSizePx: number,
): number {
  const scale = resolveEffectiveTextOutlineWidthScale(style);
  if (scale <= 0) return 0;
  return (
    (Math.round(Math.min(4, Math.max(0.35, fontSizePx * 0.055)) * 10) / 10) *
    scale
  );
}

export function resolveEffectiveTextColor(style: TextOutlineStyle): string {
  return resolveHexColor(style.textColor, DEFAULT_TEXT_COLOR);
}

export function resolveEffectiveTextOutlineColor(
  style: TextOutlineStyle,
): string {
  const textColor = resolveEffectiveTextColor(style);
  const outlineColor = resolveHexColor(
    style.outlineColor,
    DEFAULT_OUTLINE_COLOR,
  );
  if (
    !style.automaticFontMatch ||
    resolveTextOutlineContrastRatio(textColor, outlineColor) >=
      MIN_AUTOMATIC_TEXT_OUTLINE_CONTRAST_RATIO
  ) {
    return outlineColor;
  }
  const darkContrast = resolveTextOutlineContrastRatio(
    textColor,
    DARK_OUTLINE_COLOR,
  );
  const lightContrast = resolveTextOutlineContrastRatio(
    textColor,
    LIGHT_OUTLINE_COLOR,
  );
  return darkContrast > lightContrast
    ? DARK_OUTLINE_COLOR
    : LIGHT_OUTLINE_COLOR;
}

export function resolveTextOutlineContrastRatio(
  textColor: string,
  outlineColor: string,
): number {
  const textLuminance = relativeLuminance(
    resolveHexColor(textColor, DEFAULT_TEXT_COLOR),
  );
  const outlineLuminance = relativeLuminance(
    resolveHexColor(outlineColor, DEFAULT_OUTLINE_COLOR),
  );
  const lighter = Math.max(textLuminance, outlineLuminance);
  const darker = Math.min(textLuminance, outlineLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function normalizeOutlineWidthScale(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 1;
}

function resolveHexColor(value: string | undefined, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function relativeLuminance(color: string): number {
  const channels = [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    (channels[0] ?? 0) * 0.2126 +
    (channels[1] ?? 0) * 0.7152 +
    (channels[2] ?? 0) * 0.0722
  );
}
