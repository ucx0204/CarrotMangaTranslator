import type {
  FontMatchingSemanticRole,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";

/** Aggregate held-out evidence sealed into the deployed runtime contract. */
type FontMatchingReleaseSelectionMetrics = Readonly<{
  overallAcceptableAt1: number;
  ordinaryAcceptableAt1: number;
  variantAcceptableAt1: number;
}>;

type SelectionConfidenceInput = Readonly<{
  rankedCandidates: readonly RankedFontCandidateV2[];
  role: FontMatchingSemanticRole;
  noneProbability: number;
  releaseMetrics: FontMatchingReleaseSelectionMetrics;
}>;

const BODY_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

const VARIANT_ROLES = new Set<FontMatchingSemanticRole>([
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
]);

const STYLE_VERIFICATION_SHORTLIST_SIZE = 3;
const MINIMUM_STYLE_FIT = 0.7;
const MINIMUM_STYLE_LEAD = 0.025;
const UNCORROBORATED_CONFIDENCE_CAP = 0.79;
const NONE_PROBABILITY_PENALTY = 0.35;

/**
 * Converts the ranker's top choice into selection evidence. The 15-way
 * softmax value is deliberately not used as correctness confidence: held-out
 * labels show that its absolute value and top-2 margin do not predict whether
 * the selected font is acceptable. A choice must instead be corroborated by
 * the independent source-style head inside the model's top-3 shortlist.
 *
 * Only the original local winner receives confidence. If glyph/layout gates
 * later remove it, the decision layer abstains instead of silently treating a
 * lower-ranked font as equally proven.
 */
export function applyReleaseCalibratedSelectionConfidence({
  rankedCandidates,
  role,
  noneProbability,
  releaseMetrics,
}: SelectionConfidenceInput): RankedFontCandidateV2[] {
  const ordered = [...rankedCandidates].sort(compareRankedCandidates);
  const top = ordered[0];
  if (!top) return [];
  const confidence = resolveTopSelectionConfidence({
    top,
    shortlist: ordered.slice(0, STYLE_VERIFICATION_SHORTLIST_SIZE),
    role,
    noneProbability,
    releaseMetrics,
  });
  return ordered.map((candidate, index) => ({
    ...candidate,
    confidence: index === 0 ? confidence : 0,
    reasonCodes: [
      ...candidate.reasonCodes,
      ...(index === 0
        ? [
            confidence > UNCORROBORATED_CONFIDENCE_CAP
              ? "release_calibrated_style_corroborated"
              : "release_calibrated_abstain",
          ]
        : ["selection_confidence_reserved_for_local_winner"]),
    ],
  }));
}

function sameAutomaticFontRoleFamily(
  left: FontMatchingSemanticRole,
  right: FontMatchingSemanticRole,
): boolean {
  return roleFamily(left) === roleFamily(right);
}

/** A body/variant routing conflict invalidates the release cohort estimate. */
export function requireSelectionRoleFamilyAgreement(
  rankedCandidates: readonly RankedFontCandidateV2[],
  pixelRole: FontMatchingSemanticRole,
  combinedRole: FontMatchingSemanticRole,
): RankedFontCandidateV2[] {
  if (sameAutomaticFontRoleFamily(pixelRole, combinedRole)) {
    return [...rankedCandidates];
  }
  return rankedCandidates.map((candidate) => ({
    ...candidate,
    confidence: Math.min(candidate.confidence, UNCORROBORATED_CONFIDENCE_CAP),
    reasonCodes: [...candidate.reasonCodes, "pixel_llm_role_family_conflict"],
  }));
}

function resolveTopSelectionConfidence({
  top,
  shortlist,
  role,
  noneProbability,
  releaseMetrics,
}: Readonly<{
  top: RankedFontCandidateV2;
  shortlist: readonly RankedFontCandidateV2[];
  role: FontMatchingSemanticRole;
  noneProbability: number;
  releaseMetrics: FontMatchingReleaseSelectionMetrics;
}>): number {
  const base = releaseBaseRate(role, releaseMetrics);
  if (!styleHeadCorroborates(top, shortlist)) {
    return Math.min(UNCORROBORATED_CONFIDENCE_CAP, base);
  }
  const styleStrength = clampProbability(
    (top.styleFit - MINIMUM_STYLE_FIT) / (1 - MINIMUM_STYLE_FIT),
  );
  // The held-out base rate remains the dominant term. Cross-head agreement
  // can recover only part of the remaining uncertainty, while the none head
  // continuously subtracts evidence before its separate hard gate fires.
  const corroborationShare = 0.3 + 0.25 * styleStrength;
  return clampProbability(
    base +
      (1 - base) * corroborationShare -
      clampProbability(noneProbability) * NONE_PROBABILITY_PENALTY,
  );
}

function styleHeadCorroborates(
  top: RankedFontCandidateV2,
  shortlist: readonly RankedFontCandidateV2[],
): boolean {
  if (top.styleFit < MINIMUM_STYLE_FIT) return false;
  const alternatives = shortlist.filter(
    (candidate) => candidate.fontId !== top.fontId,
  );
  const bestAlternative = alternatives.reduce(
    (best, candidate) => Math.max(best, candidate.styleFit),
    -Infinity,
  );
  return (
    bestAlternative === -Infinity ||
    top.styleFit - bestAlternative >= MINIMUM_STYLE_LEAD
  );
}

function releaseBaseRate(
  role: FontMatchingSemanticRole,
  metrics: FontMatchingReleaseSelectionMetrics,
): number {
  const family = roleFamily(role);
  if (family === "body") return metrics.ordinaryAcceptableAt1;
  if (family === "variant") return metrics.variantAcceptableAt1;
  return metrics.overallAcceptableAt1;
}

function roleFamily(
  role: FontMatchingSemanticRole,
): "body" | "variant" | "other" {
  if (BODY_ROLES.has(role)) return "body";
  if (VARIANT_ROLES.has(role)) return "variant";
  return "other";
}

function compareRankedCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
): number {
  return (
    left.rank - right.rank ||
    right.totalScore - left.totalScore ||
    compareStrings(left.fontId, right.fontId)
  );
}

function clampProbability(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
