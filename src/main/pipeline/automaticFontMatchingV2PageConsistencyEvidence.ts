import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import {
  resolveAutomaticFontCalibratedBodyFamily,
  resolveAutomaticFontCalibratedPixelWinner,
} from "./automaticFontMatchingV2PageFamily";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import { FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION } from "./fontMatchingPagePixelPreprocessing";
import { hasVariantGeometry } from "./automaticFontMatchingV2PageConsistencyGeometryMetrics";
import {
  candidatePixelScore,
  comparePixelCandidates,
  DOHYEON_FONT_ID,
  resolveBestEligibleBodyCandidate,
  resolveCandidateBodyFamily,
  resolveVariantMass,
  type PageEvidenceRow,
  type PageGeometryItem,
} from "./automaticFontMatchingV2PageConsistencyShared";

const TRUSTED_VARIANT_ROUTE_MINIMUM_SCORE_MARGIN = 0.12;
const MINIMUM_STRONG_VARIANT_MASS = 0.78;
const MINIMUM_STRONG_VARIANT_BODY_GAP = 0.36;
const MINIMUM_STRONG_VARIANT_TOP1_SCORE = 0.48;
const MINIMUM_STRONG_VARIANT_TOP2_MARGIN = 0.35;
const MINIMUM_HIGH_DOMINANCE_VARIANT_TOP1_SCORE = 0.52;
const MINIMUM_HIGH_DOMINANCE_VARIANT_BODY_GAP = 0.4;
const MINIMUM_STRONG_BODY_MASS = 0.6;
const MAXIMUM_WEAK_BODY_VARIANT_MASS = 0.65;
const DOHYEON_MORPHOLOGY_PRIMARY_GLOBAL_MINIMUM = 1.55;
const DOHYEON_MORPHOLOGY_PRIMARY_COMPONENT_MEAN_MINIMUM = 1.7;
const DOHYEON_MORPHOLOGY_PRIMARY_COMPONENT_FILL_MINIMUM = 0.6;
const DOHYEON_MORPHOLOGY_ULTRA_GLOBAL_MINIMUM = 3;
const DOHYEON_MORPHOLOGY_DENSE_GLOBAL_MINIMUM = 1.3;
const DOHYEON_MORPHOLOGY_DENSE_COMPONENT_FILL_MINIMUM = 0.7;
const DOHYEON_DIRECT_RESCUE_MINIMUM_TOP1_SCORE = 0.87;
const DOHYEON_DIRECT_RESCUE_MINIMUM_TOP1_MARGIN = 0.82;
const DOHYEON_DIRECT_RESCUE_MINIMUM_GLOBAL_MEAN = 1.55;

type EvidenceClassification = Pick<
  PageEvidenceRow,
  "directBodyFamily" | "strongBodySeed" | "family" | "recoveredBody"
>;

export function buildInitialEvidenceRow(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  item?: PageGeometryItem,
): PageEvidenceRow {
  const morphologyVeto = resolveDohyeonMorphologyVeto(inference);
  if (isExplicitLocalVisualItem(item)) {
    return createEvidenceRow(inference, item, morphologyVeto, {
      directBodyFamily: null,
      strongBodySeed: false,
      family: null,
      recoveredBody: false,
    });
  }
  const winnerFamily = resolveAutomaticFontCalibratedBodyFamily(inference);
  const recoverableBody = resolveBestEligibleBodyCandidate(inference);
  const recoverableFamily = recoverableBody
    ? resolveCandidateBodyFamily(recoverableBody)
    : null;
  const variantMass = resolveVariantMass(inference);

  if (isStrongBodySeed(recoverableFamily, variantMass)) {
    const family = winnerFamily ?? recoverableFamily;
    return createEvidenceRow(inference, item, morphologyVeto, {
      directBodyFamily: family,
      strongBodySeed: true,
      family,
      recoveredBody: winnerFamily !== family,
    });
  }
  if (winnerFamily && recoverableFamily) {
    return createEvidenceRow(inference, item, morphologyVeto, {
      directBodyFamily: winnerFamily,
      strongBodySeed: false,
      family: winnerFamily,
      recoveredBody: false,
    });
  }
  return createWeakEvidenceRow(
    inference,
    item,
    recoverableBody,
    recoverableFamily,
    variantMass,
    morphologyVeto,
  );
}

function isExplicitLocalVisualItem(
  item: PageGeometryItem | undefined,
): boolean {
  if (item?.textRole === "sound") return true;
  const role = item?.fontRole;
  return role?.startsWith("sfx_") === true || role === "sign_ui_title";
}

function createWeakEvidenceRow(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  item: PageGeometryItem | undefined,
  recoverableBody: RankedFontCandidateV2 | null,
  recoverableFamily: PageEvidenceRow["family"],
  variantMass: number,
  morphologyVeto: boolean,
): PageEvidenceRow {
  const weakBodyEligible =
    Boolean(recoverableFamily) && variantMass <= MAXIMUM_WEAK_BODY_VARIANT_MASS;
  const preserveVariant = shouldPreserveVariant(
    inference,
    item,
    recoverableBody,
    weakBodyEligible,
    morphologyVeto,
  );
  return createEvidenceRow(inference, item, morphologyVeto, {
    directBodyFamily: null,
    strongBodySeed: false,
    family: preserveVariant ? null : recoverableFamily,
    recoveredBody: !preserveVariant && Boolean(recoverableFamily),
  });
}

function createEvidenceRow(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  item: PageGeometryItem | undefined,
  dohyeonMorphologyVeto: boolean,
  classification: EvidenceClassification,
): PageEvidenceRow {
  return {
    inference,
    ...(item ? { item } : {}),
    ...classification,
    geometryComponentForced: false,
    geometryComponentId: null,
    geometryComponentAnchorFontId: null,
    geometryComponentEvidenceCount: 0,
    dohyeonMorphologyVeto,
  };
}

function isStrongBodySeed(
  recoverableFamily: PageEvidenceRow["family"],
  variantMass: number,
): recoverableFamily is NonNullable<PageEvidenceRow["family"]> {
  return (
    Boolean(recoverableFamily) && 1 - variantMass >= MINIMUM_STRONG_BODY_MASS
  );
}

function shouldPreserveVariant(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  item: PageGeometryItem | undefined,
  recoverableBody: RankedFontCandidateV2 | null,
  weakBodyEligible: boolean,
  morphologyVeto: boolean,
): boolean {
  if (morphologyVeto) return false;
  if (!weakBodyEligible) return true;
  return (
    hasVariantGeometry(item) ||
    hasTrustedPixelVariantRoute(inference, recoverableBody) ||
    hasStrongPixelVariantEvidence(inference, recoverableBody)
  );
}

function resolveDohyeonMorphologyVeto(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): boolean {
  const winner = resolveAutomaticFontCalibratedPixelWinner(inference);
  if (winner?.fontId !== DOHYEON_FONT_ID) return false;
  return !passesDohyeonGlyphMorphology(inference);
}

function hasTrustedPixelVariantRoute(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  bodyCandidate: RankedFontCandidateV2 | null,
): boolean {
  if (inference.scoreRoute?.family !== "variant") return false;
  if (inference.selectionCalibration.operatingFamily !== "variant") {
    return false;
  }
  const winner = resolveAutomaticFontCalibratedPixelWinner(inference);
  return (
    candidatePixelScore(winner) - candidatePixelScore(bodyCandidate) >=
    TRUSTED_VARIANT_ROUTE_MINIMUM_SCORE_MARGIN
  );
}

function hasStrongPixelVariantEvidence(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  bodyCandidate: RankedFontCandidateV2 | null,
): boolean {
  const ranked = [...inference.localEvidence.rankedCandidates].sort(
    comparePixelCandidates,
  );
  const winnerScore = candidatePixelScore(ranked[0] ?? null);
  const top2Margin = winnerScore - candidatePixelScore(ranked[1] ?? null);
  const bodyGap = winnerScore - candidatePixelScore(bodyCandidate);
  return (
    hasMassCorroboratedVariant(inference, winnerScore, top2Margin, bodyGap) ||
    hasHighDominanceVariant(winnerScore, top2Margin, bodyGap)
  );
}

function hasMassCorroboratedVariant(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  winnerScore: number,
  top2Margin: number,
  bodyGap: number,
): boolean {
  if (resolveVariantMass(inference) < MINIMUM_STRONG_VARIANT_MASS) return false;
  if (bodyGap < MINIMUM_STRONG_VARIANT_BODY_GAP) return false;
  return (
    winnerScore >= MINIMUM_STRONG_VARIANT_TOP1_SCORE ||
    top2Margin >= MINIMUM_STRONG_VARIANT_TOP2_MARGIN
  );
}

function hasHighDominanceVariant(
  winnerScore: number,
  top2Margin: number,
  bodyGap: number,
): boolean {
  return (
    winnerScore >= MINIMUM_HIGH_DOMINANCE_VARIANT_TOP1_SCORE &&
    bodyGap >= MINIMUM_HIGH_DOMINANCE_VARIANT_BODY_GAP &&
    top2Margin >= MINIMUM_STRONG_VARIANT_TOP2_MARGIN
  );
}

function passesDohyeonGlyphMorphology(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): boolean {
  const morphology = inference.glyphMorphology;
  if (!hasValidMorphologyContract(morphology)) return false;
  if (!hasFiniteMorphologyMeasurements(morphology)) return false;
  return (
    passesAnyMorphologyGate(morphology) ||
    passesDirectDohyeonDominanceRescue(inference, morphology)
  );
}

type GlyphMorphology = NonNullable<
  VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]
>;

function hasValidMorphologyContract(
  morphology: GlyphMorphology | undefined,
): morphology is GlyphMorphology {
  if (!morphology) return false;
  if (
    morphology.contractVersion !==
    FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION
  ) {
    return false;
  }
  if (morphology.maskSource !== "raw_grayscale_otsu_minority_area3") {
    return false;
  }
  return (
    morphology.distanceTransform === "opencv_dist_l2_mask5" &&
    morphology.connectivity === 8
  );
}

function hasFiniteMorphologyMeasurements(morphology: GlyphMorphology): boolean {
  return [
    morphology.globalForegroundDistanceMean,
    morphology.medianComponentDistanceMean,
    morphology.medianComponentFill,
  ].every(Number.isFinite);
}

function passesAnyMorphologyGate(morphology: GlyphMorphology): boolean {
  const globalMean = morphology.globalForegroundDistanceMean;
  const componentMean = morphology.medianComponentDistanceMean;
  const componentFill = morphology.medianComponentFill;
  return (
    passesPrimaryMorphologyGate(globalMean, componentMean, componentFill) ||
    globalMean >= DOHYEON_MORPHOLOGY_ULTRA_GLOBAL_MINIMUM ||
    passesDenseMorphologyGate(globalMean, componentFill)
  );
}

function passesPrimaryMorphologyGate(
  globalMean: number,
  componentMean: number,
  componentFill: number,
): boolean {
  if (globalMean < DOHYEON_MORPHOLOGY_PRIMARY_GLOBAL_MINIMUM) return false;
  return (
    componentMean >= DOHYEON_MORPHOLOGY_PRIMARY_COMPONENT_MEAN_MINIMUM ||
    componentFill >= DOHYEON_MORPHOLOGY_PRIMARY_COMPONENT_FILL_MINIMUM
  );
}

function passesDenseMorphologyGate(
  globalMean: number,
  componentFill: number,
): boolean {
  return (
    globalMean >= DOHYEON_MORPHOLOGY_DENSE_GLOBAL_MINIMUM &&
    componentFill >= DOHYEON_MORPHOLOGY_DENSE_COMPONENT_FILL_MINIMUM
  );
}

/**
 * Preserve an unmistakable direct Dohyeon pixel match even when fragmented
 * source glyphs depress the component summary. This is deliberately additive
 * to the morphology gate and never reads OCR text, roles, genre, or semantics.
 */
function passesDirectDohyeonDominanceRescue(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  morphology: GlyphMorphology,
): boolean {
  if (
    morphology.globalForegroundDistanceMean <
    DOHYEON_DIRECT_RESCUE_MINIMUM_GLOBAL_MEAN
  ) {
    return false;
  }
  const ranked = [...inference.localEvidence.rankedCandidates]
    .filter((candidate) => candidate.renderStatus === "rendered")
    .sort(comparePixelCandidates);
  const winner = ranked[0];
  if (winner?.fontId !== DOHYEON_FONT_ID) return false;
  const winnerScore = candidatePixelScore(winner);
  const runnerUpScore = candidatePixelScore(ranked[1] ?? null);
  return (
    winnerScore >= DOHYEON_DIRECT_RESCUE_MINIMUM_TOP1_SCORE &&
    winnerScore - runnerUpScore >= DOHYEON_DIRECT_RESCUE_MINIMUM_TOP1_MARGIN
  );
}
