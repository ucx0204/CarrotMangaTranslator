import type {
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
} from "../../shared/fontMatchingProfileTypes";

const SINGLE_DAY_FONT_ID = "single-day";
const MINIMUM_SPECIALIST_ROLE_CONFIDENCE = 0.75;
const MINIMUM_SPECIALIST_RAW_LOGIT_MARGIN = Math.log(2);
const MASKED_SCORE_GAP = 1;

const BODY_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

const UNRESTRICTED_SPECIALIST_ROLES = new Set<FontMatchingSemanticRole>([
  "whisper",
  "aside_balloon_edge",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
]);

/**
 * Apply production specialist-font eligibility to one pixel-ranker row.
 * Inputs deliberately exclude OCR text, translation text, font names, and LLM
 * metadata: only sealed candidate ids, original logits, and the pixel role may
 * affect the mask.
 */
export function maskIneligiblePixelCandidateScores(
  candidateIds: readonly string[],
  candidateScores: ArrayLike<number>,
  pixelRole: FontMatchRolePredictionV2,
): Float32Array {
  return resolvePixelCandidateEligibility(
    candidateIds,
    candidateScores,
    pixelRole,
  ).scores;
}

export type PixelCandidateEligibility = Readonly<{
  scores: Float32Array;
  /** One means eligible; zero means a downstream reranker must not promote it. */
  eligibleMask: Uint8Array;
}>;

/**
 * Return the adjusted scores together with the authoritative eligibility mask.
 * The finite score floor keeps calibration features numerically stable, while
 * the separate mask prevents later page-local preferences from reviving a
 * candidate whose score was intentionally suppressed.
 */
export function resolvePixelCandidateEligibility(
  candidateIds: readonly string[],
  candidateScores: ArrayLike<number>,
  pixelRole: FontMatchRolePredictionV2,
): PixelCandidateEligibility {
  if (candidateIds.length !== candidateScores.length) {
    throw new Error("Font matching candidate eligibility boundary drifted.");
  }
  const scores = Float32Array.from(candidateScores);
  const eligibleMask = new Uint8Array(candidateIds.length).fill(1);
  const singleDayIndex = candidateIds.indexOf(SINGLE_DAY_FONT_ID);
  if (
    singleDayIndex < 0 ||
    singleDayEligible(scores, singleDayIndex, pixelRole)
  ) {
    return { scores, eligibleMask };
  }
  scores[singleDayIndex] = maskedScoreBelowAllCompetitors(
    scores,
    singleDayIndex,
  );
  eligibleMask[singleDayIndex] = 0;
  return { scores, eligibleMask };
}

function singleDayEligible(
  scores: Float32Array,
  candidateIndex: number,
  pixelRole: FontMatchRolePredictionV2,
): boolean {
  if (BODY_ROLES.has(pixelRole.primary)) return false;
  if (UNRESTRICTED_SPECIALIST_ROLES.has(pixelRole.primary)) return true;
  return (
    pixelRole.confidence >= MINIMUM_SPECIALIST_ROLE_CONFIDENCE &&
    candidateRawLogitMargin(scores, candidateIndex) >=
      MINIMUM_SPECIALIST_RAW_LOGIT_MARGIN
  );
}

function candidateRawLogitMargin(
  scores: Float32Array,
  candidateIndex: number,
): number {
  const candidateScore = scores[candidateIndex];
  if (!Number.isFinite(candidateScore)) return -Infinity;
  let bestCompetitor = -Infinity;
  for (let index = 0; index < scores.length; index += 1) {
    if (index === candidateIndex) continue;
    bestCompetitor = Math.max(bestCompetitor, scores[index] ?? -Infinity);
  }
  return Number.isFinite(bestCompetitor)
    ? Number(candidateScore) - bestCompetitor
    : -Infinity;
}

function maskedScoreBelowAllCompetitors(
  scores: Float32Array,
  candidateIndex: number,
): number {
  let minimumCompetitor = Infinity;
  for (let index = 0; index < scores.length; index += 1) {
    if (index === candidateIndex) continue;
    minimumCompetitor = Math.min(minimumCompetitor, scores[index] ?? Infinity);
  }
  return Number.isFinite(minimumCompetitor)
    ? Math.fround(minimumCompetitor - MASKED_SCORE_GAP)
    : Math.fround(-MASKED_SCORE_GAP);
}
