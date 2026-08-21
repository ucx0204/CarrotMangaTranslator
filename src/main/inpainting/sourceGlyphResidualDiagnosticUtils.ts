import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { SourceGlyphComponentResidualProfile } from "./sourceGlyphResidualDiagnosticTypes";

export const SOURCE_LIKE_MAX_RGB_DELTA = 24;

export function validateDiagnosticBitmapContract(
  before: Buffer,
  after: Buffer,
  pageWidth: number,
): number {
  if (
    !Number.isInteger(pageWidth) ||
    pageWidth <= 0 ||
    before.length !== after.length ||
    before.length % (pageWidth * 4) !== 0
  ) {
    throw new Error("Invalid source-glyph diagnostic bitmap contract.");
  }
  return before.length / (pageWidth * 4);
}

export function validateDiagnosticWindowMask(
  mask: InpaintingWindowMask,
  pageWidth: number,
  pageHeight: number,
): void {
  const { bounds, data } = mask;
  const dimensionsValid =
    Number.isInteger(bounds.x) &&
    Number.isInteger(bounds.y) &&
    Number.isInteger(bounds.w) &&
    Number.isInteger(bounds.h) &&
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.w > 0 &&
    bounds.h > 0 &&
    bounds.x + bounds.w <= pageWidth &&
    bounds.y + bounds.h <= pageHeight;
  if (!dimensionsValid || data.length !== bounds.w * bounds.h) {
    throw new Error("Invalid source-glyph diagnostic window mask contract.");
  }
}

export function validateComponentProfile(
  profile: SourceGlyphComponentResidualProfile,
): void {
  const positiveCounts = [
    profile.minSourcePixelCount,
    profile.minRetainedPixelCount,
    profile.minLargestExactLikeRun,
  ];
  const ratios = [
    profile.minRetainedRatio,
    profile.minLargestExactLikeRunRatio,
    profile.minFillRatio,
    profile.maxFillRatio,
  ];
  const invalid =
    !Object.values(profile).every(Number.isFinite) ||
    positiveCounts.some((value) => value <= 0) ||
    ratios.some((value) => value < 0 || value > 1) ||
    profile.maxSourcePixelCount < profile.minSourcePixelCount ||
    profile.maxFillRatio < profile.minFillRatio ||
    profile.maxAspectRatio < 1;
  if (invalid) {
    throw new Error("Invalid source-glyph component diagnostic profile.");
  }
}

export function windowMaskContainsPixel(
  mask: InpaintingWindowMask,
  pageX: number,
  pageY: number,
): boolean {
  const x = pageX - mask.bounds.x;
  const y = pageY - mask.bounds.y;
  return (
    x >= 0 &&
    y >= 0 &&
    x < mask.bounds.w &&
    y < mask.bounds.h &&
    Boolean(mask.data[y * mask.bounds.w + x])
  );
}

export function pixelRgbDelta(
  before: Buffer,
  after: Buffer,
  offset: number,
): number {
  return (
    Math.abs((before[offset] ?? 0) - (after[offset] ?? 0)) +
    Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0)) +
    Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0))
  );
}

export function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
