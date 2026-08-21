import type { MangaPage } from "../../shared/libraryTypes";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  bboxToPixelRect,
  expandRect,
  resolvePatternBlockMarginPx,
} from "./maskGeometry";
import { buildPatternTextMask } from "./patternTextMask";
import { maskComponents } from "./rasterMasks";

export const SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION =
  "source-glyph-residual-v1" as const;

export type SourceGlyphEvidenceStrategy = "adaptive" | "otsu" | "none";

export type SourceGlyphEvidence = {
  strategy: SourceGlyphEvidenceStrategy;
  windowMask: InpaintingWindowMask;
};

export type PatternSourceGlyphResidualDiagnostic = {
  contractVersion: typeof SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION;
  diagnosticOnly: true;
  promotionEligible: false;
  resolutionNormalized: false;
  blockId: string;
  sourceEvidenceStrategy: SourceGlyphEvidenceStrategy;
  sourceSeedCount: number;
  sourceLikeRemainingCount: number;
  sourceLikeRemainingRatio: number;
  largestResidualComponent: number;
  sourceSeedOutsideFirstPassCore: number;
  sourceSeedOutsideFirstPassCoreRatio: number;
  residualVeto: boolean;
};

const SOURCE_LIKE_MAX_RGB_DELTA = 24;
const MIN_SOURCE_SEED_COUNT = 24;
const MIN_SOURCE_LIKE_REMAINING_COUNT = 18;
const MIN_SOURCE_LIKE_REMAINING_RATIO = 0.62;
const MIN_LARGEST_RESIDUAL_COMPONENT = 8;
const MIN_LARGEST_RESIDUAL_COMPONENT_RATIO = 0.08;

/**
 * Builds validation-only source evidence. This deliberately uses an
 * undilated detector result and never falls back to the filled OCR rectangle:
 * neither this mask nor its pixels are allowed to affect inpainting.
 */
export function buildSourceGlyphEvidence(options: {
  bitmap: Buffer;
  block: MangaPage["blocks"][number];
  height: number;
  page: MangaPage;
  width: number;
}): SourceGlyphEvidence {
  const sourceRect = bboxToPixelRect(options.block.bbox, options.page);
  const bounds = expandRect(
    sourceRect,
    options.width,
    options.height,
    resolvePatternBlockMarginPx(options.block, options.page),
  );
  const detected = buildPatternTextMask(
    options.bitmap,
    options.width,
    options.height,
    bounds,
    0,
    { focusRect: sourceRect },
  );
  return {
    strategy: detected.strategy,
    windowMask: { bounds, data: detected.mask },
  };
}

/**
 * Measures whether independently detected source glyph pixels still look like
 * their exact pre-inpaint source. The veto intentionally requires both broad
 * retention and a non-trivial connected component so tiny line-art remnants
 * cannot turn a completed block into a false incomplete result.
 */
export function measureSourceGlyphResidual(options: {
  after: Buffer;
  before: Buffer;
  blockId: string;
  firstPassCore: InpaintingWindowMask;
  pageWidth: number;
  sourceEvidence: SourceGlyphEvidence;
}): PatternSourceGlyphResidualDiagnostic {
  validateBitmapContract(options.before, options.after, options.pageWidth);
  const pageHeight = options.before.length / (options.pageWidth * 4);
  validateWindowMask(
    options.sourceEvidence.windowMask,
    options.pageWidth,
    pageHeight,
  );
  validateWindowMask(options.firstPassCore, options.pageWidth, pageHeight);

  const sourceMask = options.sourceEvidence.windowMask;
  const remainingMask = new Uint8Array(sourceMask.data.length);
  let sourceSeedCount = 0;
  let sourceLikeRemainingCount = 0;
  let sourceSeedOutsideFirstPassCore = 0;
  for (let localY = 0; localY < sourceMask.bounds.h; localY += 1) {
    for (let localX = 0; localX < sourceMask.bounds.w; localX += 1) {
      const localIndex = localY * sourceMask.bounds.w + localX;
      if (!sourceMask.data[localIndex]) continue;
      sourceSeedCount += 1;
      const pageX = sourceMask.bounds.x + localX;
      const pageY = sourceMask.bounds.y + localY;
      if (!windowMaskContainsPixel(options.firstPassCore, pageX, pageY)) {
        sourceSeedOutsideFirstPassCore += 1;
      }
      const offset = (pageY * options.pageWidth + pageX) * 4;
      if (
        pixelRgbDelta(options.before, options.after, offset) <=
        SOURCE_LIKE_MAX_RGB_DELTA
      ) {
        remainingMask[localIndex] = 1;
        sourceLikeRemainingCount += 1;
      }
    }
  }

  const sourceLikeRemainingRatio = safeRatio(
    sourceLikeRemainingCount,
    sourceSeedCount,
  );
  const largestResidualComponent = findLargestMaskComponent(
    remainingMask,
    sourceMask.bounds.w,
    sourceMask.bounds.h,
  );
  const residualVeto =
    sourceSeedCount >= MIN_SOURCE_SEED_COUNT &&
    sourceLikeRemainingCount >= MIN_SOURCE_LIKE_REMAINING_COUNT &&
    sourceLikeRemainingRatio >= MIN_SOURCE_LIKE_REMAINING_RATIO &&
    largestResidualComponent >= MIN_LARGEST_RESIDUAL_COMPONENT &&
    largestResidualComponent / sourceSeedCount >=
      MIN_LARGEST_RESIDUAL_COMPONENT_RATIO;

  return {
    contractVersion: SOURCE_GLYPH_RESIDUAL_CONTRACT_VERSION,
    diagnosticOnly: true,
    promotionEligible: false,
    resolutionNormalized: false,
    blockId: options.blockId,
    sourceEvidenceStrategy: options.sourceEvidence.strategy,
    sourceSeedCount,
    sourceLikeRemainingCount,
    sourceLikeRemainingRatio,
    largestResidualComponent,
    sourceSeedOutsideFirstPassCore,
    sourceSeedOutsideFirstPassCoreRatio: safeRatio(
      sourceSeedOutsideFirstPassCore,
      sourceSeedCount,
    ),
    residualVeto,
  };
}

function validateBitmapContract(
  before: Buffer,
  after: Buffer,
  pageWidth: number,
): void {
  if (
    !Number.isInteger(pageWidth) ||
    pageWidth <= 0 ||
    before.length !== after.length ||
    before.length % (pageWidth * 4) !== 0
  ) {
    throw new Error("Invalid source-glyph residual bitmap contract.");
  }
}

function validateWindowMask(
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  pageHeight: number,
): void {
  const { bounds, data } = windowMask;
  if (
    !Number.isInteger(bounds.x) ||
    !Number.isInteger(bounds.y) ||
    !Number.isInteger(bounds.w) ||
    !Number.isInteger(bounds.h) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.w <= 0 ||
    bounds.h <= 0 ||
    bounds.x + bounds.w > pageWidth ||
    bounds.y + bounds.h > pageHeight ||
    data.length !== bounds.w * bounds.h
  ) {
    throw new Error("Invalid source-glyph residual window mask contract.");
  }
}

function windowMaskContainsPixel(
  windowMask: InpaintingWindowMask,
  pageX: number,
  pageY: number,
): boolean {
  const localX = pageX - windowMask.bounds.x;
  const localY = pageY - windowMask.bounds.y;
  if (
    localX < 0 ||
    localY < 0 ||
    localX >= windowMask.bounds.w ||
    localY >= windowMask.bounds.h
  ) {
    return false;
  }
  return Boolean(windowMask.data[localY * windowMask.bounds.w + localX]);
}

function pixelRgbDelta(before: Buffer, after: Buffer, offset: number): number {
  return (
    Math.abs((before[offset] ?? 0) - (after[offset] ?? 0)) +
    Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0)) +
    Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0))
  );
}

function findLargestMaskComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): number {
  return maskComponents(mask, width, height, 1)[0]?.area ?? 0;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
