import {
  FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION,
  type FontMatchingGlyphMorphologyV1,
} from "./fontMatchingPagePixelPreprocessing";

const INVERSE_TEXT_COLOR = "#f7f7f2";
const INVERSE_OUTLINE_COLOR = "#141414";
const MINIMUM_FOREGROUND_LUMA = 210;
const MAXIMUM_BACKGROUND_LUMA = 70;
const MINIMUM_LUMA_GAP = 150;
const MINIMUM_FOREGROUND_SHARE = 0.0075;
const MAXIMUM_FOREGROUND_SHARE = 0.45;
const MINIMUM_COMPONENT_COUNT = 2;
const MAXIMUM_COMPONENT_COUNT = 128;
const MINIMUM_MEDIAN_COMPONENT_FILL = 0.18;

export type AutomaticInverseTextStyleV1 = Readonly<{
  source: "pixel_glyph_morphology_v1";
  textColor: typeof INVERSE_TEXT_COLOR;
  outlineColor: typeof INVERSE_OUTLINE_COLOR;
}>;

/**
 * Detect only an unambiguous light-glyph-on-dark-crop case. This deliberately
 * ignores OCR text, semantic roles, genre and model treatment heads. A weak or
 * noisy pixel signal must preserve the block's existing colors.
 */
export function resolveAutomaticInverseTextStyle(
  morphology: FontMatchingGlyphMorphologyV1 | undefined,
): AutomaticInverseTextStyleV1 | undefined {
  if (!morphology || !isSupportedLightForegroundMask(morphology)) {
    return undefined;
  }
  const pixelCount = morphology.maskWidth * morphology.maskHeight;
  const foregroundShare = morphology.foregroundPixelCount / pixelCount;
  const lumaGap = morphology.foregroundMeanLuma - morphology.backgroundMeanLuma;
  if (!hasStrongInverseLuma(morphology, lumaGap)) return undefined;
  if (!hasGlyphLikeForeground(morphology, foregroundShare)) {
    return undefined;
  }
  return {
    source: "pixel_glyph_morphology_v1",
    textColor: INVERSE_TEXT_COLOR,
    outlineColor: INVERSE_OUTLINE_COLOR,
  };
}

function isSupportedLightForegroundMask(
  morphology: FontMatchingGlyphMorphologyV1,
): boolean {
  return (
    morphology.foregroundPolarity === "light" &&
    morphology.contractVersion ===
      FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION &&
    morphology.maskSource === "raw_grayscale_otsu_minority_area3" &&
    morphology.maskWidth > 0 &&
    morphology.maskHeight > 0
  );
}

function hasStrongInverseLuma(
  morphology: FontMatchingGlyphMorphologyV1,
  lumaGap: number,
): boolean {
  return (
    Number.isFinite(lumaGap) &&
    morphology.foregroundMeanLuma >= MINIMUM_FOREGROUND_LUMA &&
    morphology.backgroundMeanLuma <= MAXIMUM_BACKGROUND_LUMA &&
    lumaGap >= MINIMUM_LUMA_GAP
  );
}

function hasGlyphLikeForeground(
  morphology: FontMatchingGlyphMorphologyV1,
  foregroundShare: number,
): boolean {
  return (
    Number.isFinite(foregroundShare) &&
    foregroundShare >= MINIMUM_FOREGROUND_SHARE &&
    foregroundShare <= MAXIMUM_FOREGROUND_SHARE &&
    morphology.connectedComponentCount >= MINIMUM_COMPONENT_COUNT &&
    morphology.connectedComponentCount <= MAXIMUM_COMPONENT_COUNT &&
    Number.isFinite(morphology.medianComponentFill) &&
    morphology.medianComponentFill >= MINIMUM_MEDIAN_COMPONENT_FILL
  );
}
