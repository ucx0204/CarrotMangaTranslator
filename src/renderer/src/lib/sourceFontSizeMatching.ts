import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import { isGeneratedBubbleLayout } from "../../../shared/bubbleLayout";
import { parseRichText } from "../../../shared/richTextMarkup";
import { resolveBlockFontFamily, type BlockFontCatalog } from "./fonts";
import { getTextMeasureContext } from "./blockTextMeasurement";

const REFERENCE_FONT_SIZE_PX = 100;
const MIN_MATCHED_FONT_SIZE_PX = 4;
const MAX_MATCHED_FONT_SIZE_PX = 200;
const MAX_PROBE_GRAPHEMES = 80;
const MAX_CACHE_ENTRIES = 4_096;
// One small optical step, proportional to the source rather than page pixels.
export const SOURCE_MATCH_OPTICAL_SCALE = 1.06;
const MIN_CORNER_FRAGMENT_GRAPHEMES = 8;
const MAX_CORNER_FRAGMENT_AREA_SHARE = 1 / 8;
const CENTRAL_HALF_MAX_CENTER_OFFSET = 1 / 4;

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
  pageSize?: Readonly<{ height: number; width: number }>,
  fallbackSourceFacePx?: number,
): number | null {
  const sourceFacePx = resolveUsableSourceFacePx(
    block,
    pageSize,
    fallbackSourceFacePx,
  );
  if (sourceFacePx === null) return null;

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
    Math.round(
      (sourceFacePx / ratio) *
        (block.fontSizeIntent === "source-match"
          ? SOURCE_MATCH_OPTICAL_SCALE
          : 1),
    ),
    MIN_MATCHED_FONT_SIZE_PX,
    MAX_MATCHED_FONT_SIZE_PX,
  );
}

function resolveUsableSourceFacePx(
  block: TranslationBlock,
  pageSize: Readonly<{ height: number; width: number }> | undefined,
  fallbackSourceFacePx: number | undefined,
): number | null {
  if (
    hasUsableSourceFaceMeasurement(block) &&
    hasReliableSourceGeometry(block, pageSize)
  ) {
    return Number(block.sourceFontFacePx);
  }
  const fallback = Number(fallbackSourceFacePx);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Resolve a page-local source-face fallback for blocks whose own merged OCR
 * geometry is contradictory. Source face pixels are comparable before target
 * font conversion, so a robust median of trusted, stylistically compatible
 * dialogue peers preserves the page's actual typographic scale.
 */
export function resolvePageSourceFontFaceFallbacks(
  blocks: readonly TranslationBlock[],
  pageSize: Readonly<{ height: number; width: number }>,
): ReadonlyMap<string, number> {
  const reliablePeers = blocks.filter(
    (block) =>
      hasUsableSourceFaceMeasurement(block) &&
      hasReliableSourceGeometry(block, pageSize),
  );
  const fallbacks = new Map<string, number>();
  for (const block of blocks) {
    if (
      !canUsePageSourceFaceFallback(block) ||
      (hasUsableSourceFaceMeasurement(block) &&
        hasReliableSourceGeometry(block, pageSize))
    ) {
      continue;
    }
    const directionPeers = reliablePeers.filter(
      (peer) =>
        peer.id !== block.id &&
        peer.sourceDirection === block.sourceDirection &&
        peer.textRole !== "sound",
    );
    const rolePeers = directionPeers.filter(
      (peer) => peer.fontRole === block.fontRole,
    );
    const weightPeers = rolePeers.filter(
      (peer) => Boolean(peer.bold) === Boolean(block.bold),
    );
    const selected =
      weightPeers.length > 0
        ? weightPeers
        : rolePeers.length > 0
          ? rolePeers
          : directionPeers;
    const fallback = median(
      selected.map((peer) => Number(peer.sourceFontFacePx)),
    );
    if (fallback !== null) fallbacks.set(block.id, fallback);
  }
  return fallbacks;
}

function canUsePageSourceFaceFallback(block: TranslationBlock): boolean {
  return (
    block.textRole !== "sound" &&
    (block.sourceDirection === "horizontal" ||
      block.sourceDirection === "vertical") &&
    visibleProbe(block.sourceText).length >= 2 &&
    (hasUsableSourceFaceMeasurement(block) ||
      block.fontSizeIntent === "source-match")
  );
}

/**
 * Bubble detection can expose an upstream merged-OCR failure: a long source
 * string is paired with only one small corner fragment of its raster geometry.
 * The raster estimator can score that fragment confidently, but its face size
 * is not representative of the complete utterance. Reject it only for this
 * strongly contradictory generated geometry so a page-local source-size
 * fallback can preserve the original artwork's typographic scale.
 */
function hasReliableSourceGeometry(
  block: TranslationBlock,
  pageSize: Readonly<{ height: number; width: number }> | undefined,
): boolean {
  if (
    !pageSize ||
    !block.renderBbox ||
    !isGeneratedBubbleLayout(block.bubbleLayout) ||
    visibleProbe(block.sourceText).length < MIN_CORNER_FRAGMENT_GRAPHEMES
  ) {
    return true;
  }

  const source = toPageRelativeBbox(block.bbox, block.bboxSpace, pageSize);
  const render = toPageRelativeBbox(
    block.renderBbox,
    block.renderBboxSpace,
    pageSize,
  );
  const renderArea = render.w * render.h;
  if (renderArea <= 0) return true;
  const sourceAreaShare = (source.w * source.h) / renderArea;
  if (sourceAreaShare > MAX_CORNER_FRAGMENT_AREA_SHARE) return true;

  const sourceCenterX = source.x + source.w / 2;
  const sourceCenterY = source.y + source.h / 2;
  const renderCenterX = render.x + render.w / 2;
  const renderCenterY = render.y + render.h / 2;
  const centerOffsetX =
    Math.abs(sourceCenterX - renderCenterX) / Math.max(1, render.w);
  const centerOffsetY =
    Math.abs(sourceCenterY - renderCenterY) / Math.max(1, render.h);

  return !(
    centerOffsetX > CENTRAL_HALF_MAX_CENTER_OFFSET &&
    centerOffsetY > CENTRAL_HALF_MAX_CENTER_OFFSET
  );
}

function toPageRelativeBbox(
  bbox: BBox,
  space: TranslationBlock["bboxSpace"],
  pageSize: Readonly<{ height: number; width: number }>,
): BBox {
  if (space !== "pixels") return bbox;
  return {
    x: (bbox.x / Math.max(1, pageSize.width)) * 1_000,
    y: (bbox.y / Math.max(1, pageSize.height)) * 1_000,
    w: (bbox.w / Math.max(1, pageSize.width)) * 1_000,
    h: (bbox.h / Math.max(1, pageSize.height)) * 1_000,
  };
}

function hasUsableSourceFaceMeasurement(block: TranslationBlock): boolean {
  const sourceFacePx = Number(block.sourceFontFacePx);
  const confidence = Number(block.sourceFontSizeConfidence);
  return (
    block.sourceFontSizeMethod === "raster-core-v1" &&
    Number.isFinite(sourceFacePx) &&
    sourceFacePx > 0 &&
    Number.isFinite(confidence) &&
    confidence >= 0.5
  );
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
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
      positiveMetric(
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
      ),
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
