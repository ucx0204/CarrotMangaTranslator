import type { BlockFormatDefaults } from "../../shared/blockFormat";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../shared/blockFormat";
import type { AppSettings } from "../../shared/settingsTypes";
import { resolveTextWordBreak } from "../../shared/textWrapping";
import {
  resolveBoolean,
  resolveHexColor,
  resolveNumberRange,
  resolveOptionalString,
} from "./appSettingsResolvers";
import {
  MAX_FONT_SIZE_PX,
  MAX_FONT_WIDTH_SCALE,
  MAX_LETTER_SPACING_EM,
  MAX_LINE_HEIGHT,
  MIN_FONT_SIZE_PX,
  MIN_FONT_WIDTH_SCALE,
  MIN_LETTER_SPACING_EM,
  MIN_LINE_HEIGHT,
  clampFontSizePx,
} from "../../shared/blockFormatValues";

export function normalizeBlockFormatDefaults(
  raw: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["blockFormatDefaults"]> {
  const base = defaults.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS;
  const data = raw ?? {};
  const fontFamily = resolveOptionalString(data.fontFamily);
  const outlineWidthPx = resolveOptionalOutlineWidthPx(data.outlineWidthPx);
  return {
    renderDirection: resolveBlockFormatDirection(
      data.renderDirection,
      base.renderDirection,
    ),
    textAlign: resolveTextAlign(data.textAlign, base.textAlign),
    ...(fontFamily ? { fontFamily } : {}),
    autoFitText: resolveBoolean(data.autoFitText, base.autoFitText),
    fontSizePx: clampFontSizePx(
      resolveNumberRange(
        data.fontSizePx,
        base.fontSizePx,
        MIN_FONT_SIZE_PX,
        MAX_FONT_SIZE_PX,
      ),
    ),
    lineHeight: resolveNumberRange(
      data.lineHeight,
      base.lineHeight,
      MIN_LINE_HEIGHT,
      MAX_LINE_HEIGHT,
    ),
    letterSpacing: resolveNumberRange(
      data.letterSpacing,
      base.letterSpacing,
      MIN_LETTER_SPACING_EM,
      MAX_LETTER_SPACING_EM,
    ),
    fontWidthScale: resolveNumberRange(
      data.fontWidthScale,
      base.fontWidthScale,
      MIN_FONT_WIDTH_SCALE,
      MAX_FONT_WIDTH_SCALE,
    ),
    wordBreak: resolveTextWordBreak(data.wordBreak, base.wordBreak),
    textColor: resolveHexColor(data.textColor, base.textColor),
    textOpacity: resolveNumberRange(data.textOpacity, base.textOpacity, 0, 1),
    outlineEnabled: resolveBoolean(data.outlineEnabled, base.outlineEnabled),
    outlineColor: resolveHexColor(data.outlineColor, base.outlineColor),
    ...(outlineWidthPx === undefined ? {} : { outlineWidthPx }),
    outlineWidthScale: resolveNumberRange(
      data.outlineWidthScale,
      base.outlineWidthScale,
      0,
      8,
    ),
    bold: resolveBoolean(data.bold, base.bold),
    italic: resolveBoolean(data.italic, base.italic),
  };
}

function resolveOptionalOutlineWidthPx(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(64, Math.max(0, value))
    : undefined;
}

function resolveBlockFormatDirection(
  value: unknown,
  fallback: BlockFormatDefaults["renderDirection"],
): BlockFormatDefaults["renderDirection"] {
  return value === "auto" || value === "horizontal" || value === "vertical"
    ? value
    : fallback;
}

function resolveTextAlign(
  value: unknown,
  fallback: BlockFormatDefaults["textAlign"],
): BlockFormatDefaults["textAlign"] {
  return value === "left" || value === "center" || value === "right"
    ? value
    : fallback;
}
