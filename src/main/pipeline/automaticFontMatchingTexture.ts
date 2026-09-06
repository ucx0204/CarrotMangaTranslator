import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { FontStyleSelectionV2 } from "../../shared/fontMatchingProfileTypes";
import {
  FONT_TEXTURE_CONTRACT,
  FONT_TEXTURE_MODEL_SHA256,
  FONT_TEXTURE_CLASSES,
  FONT_TEXTURE_WEIGHTS,
  type FontTextureInference,
} from "./fontMatchingTextureTypes";

/** C15 only: strong serif emphasis. No mapping for the unvalidated S18 classes. */
export function resolveFontTextureSelection(
  value: FontTextureInference | undefined,
  candidates: readonly AutomaticFontCandidate[],
): FontStyleSelectionV2 | null {
  if (!validTexture(value)) return null;
  const ranked = value.probabilities
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  const weights = value.weightProbabilities;
  if (
    FONT_TEXTURE_CLASSES[ranked[0].i] !== "decorative_serif" ||
    ranked[0].p < 0.8 ||
    ranked[0].p - ranked[1].p < 0.35 ||
    weights.indexOf(Math.max(...weights)) !==
      FONT_TEXTURE_WEIGHTS.indexOf("heavy") ||
    !candidates.some((c) => c.fontId === "shilla-culture")
  )
    return null;
  return { fontId: "shilla-culture", fontWeight: 500, italic: false };
}

function validTexture(
  value: FontTextureInference | undefined,
): value is FontTextureInference {
  if (
    !value ||
    value.contractVersion !== FONT_TEXTURE_CONTRACT ||
    value.modelSha256 !== FONT_TEXTURE_MODEL_SHA256 ||
    !Number.isInteger(value.patchCount) ||
    value.patchCount < 2 ||
    value.patchCount > 8 ||
    !validDistribution(value.probabilities, FONT_TEXTURE_CLASSES.length) ||
    !validDistribution(value.weightProbabilities, FONT_TEXTURE_WEIGHTS.length)
  )
    return false;
  return true;
}

function validDistribution(values: readonly number[], count: number) {
  return (
    Array.isArray(values) &&
    values.length === count &&
    values.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) &&
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 0.0001
  );
}
