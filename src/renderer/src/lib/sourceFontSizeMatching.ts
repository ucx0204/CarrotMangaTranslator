import type { TranslationBlock } from "../../../shared/textTypes";
import { parseRichText } from "../../../shared/richTextMarkup";
import { resolveBlockFontFamily, type BlockFontCatalog } from "./fonts";
import { getTextMeasureContext } from "./blockTextMeasurement";

const REFERENCE_FONT_SIZE_PX = 100;
const MIN_MATCHED_FONT_SIZE_PX = 4;
const MAX_MATCHED_FONT_SIZE_PX = 200;
const MAX_PROBE_GRAPHEMES = 80;
const MAX_CACHE_ENTRIES = 4_096;

const faceRatioCache = new Map<string, number>();

/**
 * Convert a source-raster glyph-face measurement into the nominal size of the
 * font that will actually render the Korean text. The result is only an upper
 * bound: ordinary box fitting may still shrink a long translation.
 */
export function resolveSourceMatchedFontSizeCapPx(
  block: TranslationBlock,
  text: string,
  fontCatalog: BlockFontCatalog,
): number | null {
  const sourceFacePx = Number(block.sourceFontFacePx);
  if (
    !Number.isFinite(sourceFacePx) ||
    sourceFacePx <= 0 ||
    block.sourceFontSizeMethod !== "raster-core-v1"
  ) {
    return null;
  }
  const confidence = Number(block.sourceFontSizeConfidence);
  if (!Number.isFinite(confidence) || confidence < 0.5) return null;

  const { plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const probe = visibleProbe(plainText);
  if (!probe) return null;
  const direction =
    block.sourceDirection === "vertical" ? "vertical" : "horizontal";
  const fontFamily = resolveBlockFontFamily(block.fontFamily, fontCatalog);
  const ratio = resolveTargetFaceRatio({
    bold: Boolean(block.bold),
    direction,
    fontFamily,
    italic: Boolean(block.italic),
    probe,
  });
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return clamp(
    Math.round(sourceFacePx / ratio),
    MIN_MATCHED_FONT_SIZE_PX,
    MAX_MATCHED_FONT_SIZE_PX,
  );
}

function resolveTargetFaceRatio(input: {
  bold: boolean;
  direction: "horizontal" | "vertical";
  fontFamily: string;
  italic: boolean;
  probe: string;
}): number {
  const key = [
    input.fontFamily,
    input.bold ? "800" : "400",
    input.italic ? "italic" : "normal",
    input.direction,
    input.probe,
  ].join("\u0000");
  const cached = faceRatioCache.get(key);
  if (cached !== undefined) return cached;
  const context = getTextMeasureContext();
  context.font = `${input.italic ? "italic " : ""}${input.bold ? 800 : 400} ${REFERENCE_FONT_SIZE_PX}px ${input.fontFamily}`;
  const facePx =
    input.direction === "vertical"
      ? measureVerticalFacePx(context, input.probe)
      : measureHorizontalFacePx(context, input.probe);
  const ratio = facePx / REFERENCE_FONT_SIZE_PX;
  rememberRatio(key, ratio);
  return ratio;
}

function measureHorizontalFacePx(
  context: CanvasRenderingContext2D,
  text: string,
): number {
  const metrics = context.measureText(text);
  return (
    positiveMetric(metrics.actualBoundingBoxAscent) +
    positiveMetric(metrics.actualBoundingBoxDescent)
  );
}

function measureVerticalFacePx(
  context: CanvasRenderingContext2D,
  text: string,
): number {
  let maximum = 0;
  for (const grapheme of Array.from(text)) {
    const metrics = context.measureText(grapheme);
    maximum = Math.max(
      maximum,
      positiveMetric(metrics.actualBoundingBoxLeft) +
        positiveMetric(metrics.actualBoundingBoxRight),
    );
  }
  return maximum;
}

function positiveMetric(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function visibleProbe(value: string): string {
  return Array.from(value)
    .filter((grapheme) => !/^\s$/u.test(grapheme))
    .slice(0, MAX_PROBE_GRAPHEMES)
    .join("");
}

function rememberRatio(key: string, ratio: number): void {
  if (faceRatioCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = faceRatioCache.keys().next().value;
    if (typeof oldest === "string") faceRatioCache.delete(oldest);
  }
  faceRatioCache.set(key, ratio);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
