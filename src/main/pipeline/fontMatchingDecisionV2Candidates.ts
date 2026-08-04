import type {
  FontMatchingDecisionPrioritySource,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type {
  FontCandidateDecisionAuditV2,
  FontCandidateHardRejectReasonV2,
  FontDecisionPriorityTraceV2,
  FontMatchingDecisionInputV2,
  TranslationFontAssessmentV2,
} from "./fontMatchingDecisionV2Types";
import { resolveCompatibleProfile } from "./fontMatchingDecisionV2Compatibility";

export type CandidateEvaluation = FontCandidateDecisionAuditV2;

export type DecisionState = {
  input: FontMatchingDecisionInputV2;
  candidates: Map<string, RankedFontCandidateV2>;
  assessments: Map<string, TranslationFontAssessmentV2>;
  evaluations: Map<string, CandidateEvaluation>;
  rejections: Map<string, Map<"hard" | "policy", Set<string>>>;
  trace: Map<FontMatchingDecisionPrioritySource, FontDecisionPriorityTraceV2>;
  genreCap: number;
};

export function createDecisionState(
  input: FontMatchingDecisionInputV2,
): DecisionState {
  const compatibleProfile = resolveCompatibleProfile(input);
  const state: DecisionState = {
    input,
    candidates: uniqueMap(
      input.localEvidence.rankedCandidates,
      "ranked candidate",
    ),
    assessments: uniqueMap(
      input.translationAssessments,
      "translation assessment",
    ),
    evaluations: new Map(),
    rejections: new Map(),
    trace: new Map(),
    genreCap: Math.min(
      0.1,
      compatibleProfile?.genrePrior?.maxScoreContribution ?? 0,
    ),
  };
  for (const fontId of state.candidates.keys())
    evaluateCandidate(state, fontId);
  return state;
}

export function evaluateCandidate(
  state: DecisionState,
  fontId: string,
): CandidateEvaluation {
  const cached = state.evaluations.get(fontId);
  if (cached) return cached;
  const candidate = state.candidates.get(fontId);
  const assessment = state.assessments.get(fontId);
  const hardRejectReasons = resolveHardRejectReasons(state, fontId, assessment);
  const genre = resolveGenreContribution(
    state,
    candidate?.genrePriorContribution ?? 0,
  );
  const evaluation = buildCandidateEvaluation(
    fontId,
    candidate,
    assessment,
    hardRejectReasons,
    genre,
  );
  state.evaluations.set(fontId, evaluation);
  if (hardRejectReasons.length > 0) {
    addDecisionRejection(state, fontId, "hard", hardRejectReasons);
  }
  return evaluation;
}

export function rankedEligibleCandidates(
  state: DecisionState,
): CandidateEvaluation[] {
  return [...state.candidates.keys()]
    .map((fontId) => evaluateCandidate(state, fontId))
    .filter(isEligibleScoredCandidate)
    .sort((left, right) => compareCandidateScores(state, left, right));
}

export function firstEligibleCandidate(
  state: DecisionState,
  fontIds: readonly string[],
): CandidateEvaluation | null {
  return (
    uniqueSorted(fontIds)
      .map((fontId) => evaluateCandidate(state, fontId))
      .find((candidate) => candidate.hardRejectReasons.length === 0) ?? null
  );
}

export function rejectEligibleOutsideSet(
  state: DecisionState,
  allowed: ReadonlySet<string>,
  reason: "outside_anchor_set" | "outside_role_palette",
): void {
  for (const candidate of rankedEligibleCandidates(state)) {
    if (!allowed.has(candidate.fontId)) {
      addDecisionRejection(state, candidate.fontId, "policy", [reason]);
    }
  }
}

export function addDecisionRejection(
  state: DecisionState,
  fontId: string,
  kind: "hard" | "policy",
  reasons: readonly string[],
): void {
  const byKind = state.rejections.get(fontId) ?? new Map();
  const values = byKind.get(kind) ?? new Set<string>();
  for (const reason of reasons) values.add(reason);
  byKind.set(kind, values);
  state.rejections.set(fontId, byKind);
}

function buildCandidateEvaluation(
  fontId: string,
  candidate: RankedFontCandidateV2 | undefined,
  assessment: TranslationFontAssessmentV2 | undefined,
  hardRejectReasons: FontCandidateHardRejectReasonV2[],
  genre: { value: number; clamped: boolean },
): CandidateEvaluation {
  const candidateFields = resolveCandidateAuditFields(
    candidate,
    assessment,
    genre.value,
  );
  const translationFields = resolveTranslationAuditFields(assessment);
  return {
    fontId,
    ...candidateFields,
    ...translationFields,
    appliedGenreContribution: genre.value,
    genreContributionClamped: genre.clamped,
    hardRejectReasons,
  };
}

function resolveCandidateAuditFields(
  candidate: RankedFontCandidateV2 | undefined,
  assessment: TranslationFontAssessmentV2 | undefined,
  genreContribution: number,
): Pick<
  CandidateEvaluation,
  | "originalRank"
  | "originalTotalScore"
  | "effectiveScore"
  | "calibratedCandidateConfidence"
> {
  if (!candidate) {
    return {
      originalRank: null,
      originalTotalScore: null,
      effectiveScore: null,
      calibratedCandidateConfidence: null,
    };
  }
  const previousLayout = candidate.layoutFit === null ? 0 : candidate.layoutFit;
  const translationLayout = assessment ? assessment.layoutScore : 0;
  return {
    originalRank: candidate.rank,
    originalTotalScore: candidate.totalScore,
    effectiveScore:
      candidate.totalScore -
      previousLayout -
      candidate.genrePriorContribution +
      translationLayout +
      genreContribution,
    calibratedCandidateConfidence: candidate.confidence,
  };
}

function resolveTranslationAuditFields(
  assessment: TranslationFontAssessmentV2 | undefined,
): Pick<
  CandidateEvaluation,
  "translationGlyphCoverage" | "translationLayoutScore"
> {
  return assessment
    ? {
        translationGlyphCoverage: assessment.glyphCoverage,
        translationLayoutScore: assessment.layoutScore,
      }
    : { translationGlyphCoverage: null, translationLayoutScore: null };
}

function resolveHardRejectReasons(
  state: DecisionState,
  fontId: string,
  assessment: TranslationFontAssessmentV2 | undefined,
): FontCandidateHardRejectReasonV2[] {
  const reasons = resolveRenderReasons(
    state.candidates.get(fontId),
    assessment,
  );
  if (!assessment) return reasons;
  if (!assessment.glyphsRenderable) reasons.push("glyph_render_failure");
  if (assessment.glyphCoverage < 1 || assessment.missingGlyphCount > 0) {
    reasons.push("glyph_coverage_incomplete");
  }
  if (!assessment.layoutFeasible) reasons.push("layout_infeasible");
  const orientationReason = resolveOrientationRejectReason(state, fontId);
  if (orientationReason) reasons.push(orientationReason);
  return reasons;
}

function resolveRenderReasons(
  candidate: RankedFontCandidateV2 | undefined,
  assessment: TranslationFontAssessmentV2 | undefined,
): FontCandidateHardRejectReasonV2[] {
  const reasons: FontCandidateHardRejectReasonV2[] = [];
  if (candidate?.renderStatus === "unrenderable")
    reasons.push("render_unavailable");
  if (!assessment) reasons.push("translation_assessment_missing");
  return reasons;
}

function resolveOrientationRejectReason(
  state: DecisionState,
  fontId: string,
): FontCandidateHardRejectReasonV2 | null {
  const policy = resolveCompatibleProfile(state.input)?.orientationPolicy;
  if (!policy) return null;
  if (state.input.treatment.orientation === "horizontal") {
    const forbidden =
      policy.verticalOnlyFontIds.includes(fontId) ||
      (policy.horizontalAllowedFontIds !== null &&
        !policy.horizontalAllowedFontIds.includes(fontId));
    return forbidden ? "horizontal_orientation_forbidden" : null;
  }
  const forbidden =
    policy.verticalAllowedFontIds !== null &&
    !policy.verticalAllowedFontIds.includes(fontId);
  return forbidden ? "vertical_orientation_forbidden" : null;
}

function resolveGenreContribution(
  state: DecisionState,
  value: number,
): { value: number; clamped: boolean } {
  const applied = Math.max(-state.genreCap, Math.min(state.genreCap, value));
  return { value: applied, clamped: applied !== value };
}

function isEligibleScoredCandidate(candidate: CandidateEvaluation): boolean {
  return (
    candidate.hardRejectReasons.length === 0 &&
    candidate.effectiveScore !== null
  );
}

function compareCandidateScores(
  state: DecisionState,
  left: CandidateEvaluation,
  right: CandidateEvaluation,
): number {
  if (state.input.localEvidence.supervisedSelectionAccepted === true) {
    const confidenceOrder =
      (right.calibratedCandidateConfidence ?? Number.NEGATIVE_INFINITY) -
      (left.calibratedCandidateConfidence ?? Number.NEGATIVE_INFINITY);
    if (confidenceOrder !== 0) return confidenceOrder;
  }
  return (
    (right.effectiveScore ?? Number.NEGATIVE_INFINITY) -
      (left.effectiveScore ?? Number.NEGATIVE_INFINITY) ||
    (left.originalRank ?? Number.MAX_SAFE_INTEGER) -
      (right.originalRank ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(left.fontId, right.fontId)
  );
}

function uniqueMap<T extends { fontId: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.fontId)) {
      throw new Error(`duplicate ${label} fontId: ${value.fontId}`);
    }
    result.set(value.fontId, value);
  }
  return result;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
