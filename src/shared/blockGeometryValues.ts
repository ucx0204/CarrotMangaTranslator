import type { BBox, BlockType, RenderTextDirection } from "./textTypes";
import {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
  clampBlockFormatNumber,
} from "./blockFormatValues";

export { MAX_FONT_WIDTH_SCALE, MIN_FONT_WIDTH_SCALE };

/** 장평 (horizontal glyph scale) bounds, shared by editor preview and export. */
const DEFAULT_FONT_WIDTH_SCALE = 1;

/** Clamp a 장평 value to the supported range; undefined/invalid means 1. */
export function resolveFontWidthScale(
  value: number | undefined | null,
): number {
  return clampBlockFormatNumber(
    Number(value ?? DEFAULT_FONT_WIDTH_SCALE),
    MIN_FONT_WIDTH_SCALE,
    MAX_FONT_WIDTH_SCALE,
    DEFAULT_FONT_WIDTH_SCALE,
  );
}

export function enforceRenderDirection(
  type: BlockType,
  direction: unknown,
): RenderTextDirection {
  void type;
  return direction === "vertical" ? "vertical" : "horizontal";
}

export function enforceRotationDeg(type: BlockType, value: unknown): number {
  void type;
  return normalizeRotationDeg(value);
}

export function normalizeRotationDeg(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  let normalized = ((((numeric + 180) % 360) + 360) % 360) - 180;
  if (normalized === -180 && numeric > 0) {
    normalized = 180;
  }

  const rounded = Math.round((normalized + Number.EPSILON) * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeBlockType(value: unknown): BlockType {
  void value;
  return "nonsolid";
}

export function normalizeRenderDirection(
  value: unknown,
  fallback: RenderTextDirection | "rotated" | "hidden",
): RenderTextDirection {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "vertical") {
    return "vertical";
  }
  if (text === "horizontal" || text === "rotated" || text === "hidden") {
    return "horizontal";
  }
  return fallback === "vertical" ? "vertical" : "horizontal";
}

export function estimateFontSizePx(
  text: string,
  bbox: BBox,
  pageSize: { width: number; height: number },
): number {
  const widthPx = (bbox.w / 1000) * pageSize.width;
  const heightPx = (bbox.h / 1000) * pageSize.height;
  const compactLength = Math.max(
    1,
    [...text.replace(/\r/g, "").replace(/\n/g, " ")].length,
  );
  const approxCharsPerLine = Math.max(4, Math.floor(widthPx / 20));
  const lineCount = Math.max(1, Math.ceil(compactLength / approxCharsPerLine));
  const heightLimited = Math.floor(heightPx / (lineCount * 1.2));
  const widthLimited = Math.floor(
    widthPx / Math.min(12, Math.max(4, compactLength)),
  );
  return clamp(Math.min(heightLimited, widthLimited, 40), 12, 72);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
