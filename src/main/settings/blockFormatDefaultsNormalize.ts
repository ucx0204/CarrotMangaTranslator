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

export function normalizeBlockFormatDefaults(
  raw: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["blockFormatDefaults"]> {
  const base = defaults.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS;
  const data = raw ?? {};
  const fontFamily = resolveOptionalString(data.fontFamily);
  return {
    renderDirection: resolveBlockFormatDirection(
      data.renderDirection,
      base.renderDirection,
    ),
    textAlign: resolveTextAlign(data.textAlign, base.textAlign),
    ...(fontFamily ? { fontFamily } : {}),
    autoFitText: resolveBoolean(data.autoFitText, base.autoFitText),
    fontSizePx: Math.round(
      resolveNumberRange(data.fontSizePx, base.fontSizePx, 1, 512),
    ),
    lineHeight: resolveNumberRange(data.lineHeight, base.lineHeight, 0.5, 4),
    letterSpacing: resolveNumberRange(
      data.letterSpacing,
      base.letterSpacing,
      -0.5,
      2,
    ),
    fontWidthScale: resolveNumberRange(
      data.fontWidthScale,
      base.fontWidthScale,
      0.5,
      1.5,
    ),
    wordBreak: resolveTextWordBreak(data.wordBreak, base.wordBreak),
    textColor: resolveHexColor(data.textColor, base.textColor),
    textOpacity: resolveNumberRange(data.textOpacity, base.textOpacity, 0, 1),
    outlineEnabled: resolveBoolean(data.outlineEnabled, base.outlineEnabled),
    outlineColor: resolveHexColor(data.outlineColor, base.outlineColor),
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
