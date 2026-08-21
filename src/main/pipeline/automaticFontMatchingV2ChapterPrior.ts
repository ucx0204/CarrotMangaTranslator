import {
  type FontMatchingSemanticRole,
  type FontMatchingSourceStyleAxis,
  type FontMatchingSourceStyleV2,
  type RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type { FontMatchingDecisionResultV2 } from "./fontMatchingDecisionV2";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimePolicy } from "./fontMatchingRuntimePolicyContract";

const DEFAULT_RUNTIME_POLICY: FontMatchingRuntimePolicy = {
  automaticMutation: {
    minimumAutomaticConfidence: 0.86,
    minimumRoleConfidence: 0.82,
    minimumIntentionalOverrideConfidence: 0.86,
    intentionalOverrideMinimumScoreMargin: 0.1,
  },
  chapterPrior: {
    maximumScoreContribution: 0.06,
    minimumAnchorEvidenceCount: 2,
    localOverrideMinimumScoreMargin: 0.1,
  },
};
const MINIMUM_PRIOR_SHARE = 0.67;
const MINIMUM_STYLE_AXES = 6;
const MAXIMUM_STYLE_DISTANCE = 0.16;
const MAXIMUM_CRITICAL_AXIS_DISTANCE = 0.32;
const MAXIMUM_OBSERVATIONS_PER_ROLE = 96;
const MAXIMUM_CHAPTER_PRIOR_RAW_RANK = 3;
const FAMILY_STYLE_AXES = [
  "serifness",
  "width",
  "roundness",
  "strokeContrast",
  "handwritten",
  "angularity",
  "irregularity",
  "slant",
] as const satisfies readonly FontMatchingSourceStyleAxis[];
const CRITICAL_STYLE_AXES = new Set<FontMatchingSourceStyleAxis>([
  "serifness",
  "width",
  "handwritten",
]);

type BodyFontObservation = Readonly<{
  evidenceKey: string;
  fontId: string;
  confidence: number;
  orientation: "horizontal" | "vertical";
  sourceStyle: FontMatchingSourceStyleV2;
}>;

export type AutomaticFontChapterBodyPriorV2 = Readonly<{
  prepare: (
    role: FontMatchingSemanticRole,
    inference: VerifiedAutomaticFontPixelInferenceV2,
    runtimePolicy?: FontMatchingRuntimePolicy,
  ) => FontMatchingWorkStateV2;
  record: (
    role: FontMatchingSemanticRole,
    result: FontMatchingDecisionResultV2,
    selectedFontId: string,
    inference?: VerifiedAutomaticFontPixelInferenceV2 | null,
    runtimePolicy?: FontMatchingRuntimePolicy,
  ) => void;
}>;

/** Chapter memory built only from independent high-confidence pixel choices. */
export function createAutomaticFontChapterBodyPriorV2(): AutomaticFontChapterBodyPriorV2 {
  const observationsByRole = new Map<
    FontMatchingSemanticRole,
    BodyFontObservation[]
  >();
  return {
    prepare(role, inference, runtimePolicy = DEFAULT_RUNTIME_POLICY) {
      if (prefersBlockLocalVisualEvidence(inference.sourceStyle)) {
        return { automaticStrategy: "local_visual_first" };
      }
      const prior = resolveBodyConsistencyPrior(
        observationsByRole.get(role) ?? [],
        inference,
        runtimePolicy,
      );
      return {
        automaticStrategy: "body_consistency_soft",
        ...(prior
          ? {
              bodyConsistencyFontId: prior.fontId,
              bodyConsistencyScoreBoost: prior.scoreBoost,
            }
          : {}),
      };
    },
    record(
      role,
      result,
      selectedFontId,
      inference,
      runtimePolicy = DEFAULT_RUNTIME_POLICY,
    ) {
      recordBodyObservation(
        observationsByRole,
        role,
        result,
        selectedFontId,
        inference,
        runtimePolicy,
      );
    },
  };
}

export function applyAutomaticFontChapterBodyPrior(
  rankedCandidates: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2 | undefined,
  runtimePolicy: FontMatchingRuntimePolicy = DEFAULT_RUNTIME_POLICY,
): readonly RankedFontCandidateV2[] {
  const prior = resolveApplicablePrior(workState, runtimePolicy);
  if (!prior) return rankedCandidates;
  const priorCandidate = rankedCandidates.find(
    (candidate) => candidate.fontId === prior.fontId,
  );
  // Continuity evidence may choose among plausible local faces, but it must
  // never resurrect a catalogue-wide low-confidence option. The runtime pixel
  // rank is sealed before any chapter boost, so top-three membership is the
  // stable boundary used again by the final supervised gate.
  if (!isChapterPriorCandidateEligible(priorCandidate)) {
    return rankedCandidates;
  }
  const confidenceAuthority = [...rankedCandidates]
    .filter((candidate) => candidate.confidence > 0)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        compareRankedCandidates(left, right),
    )[0];
  const topScore = Math.max(
    ...rankedCandidates.map((candidate) => candidate.totalScore),
  );
  const anchored = rankedCandidates
    .map((candidate) =>
      promoteMatchingCandidate(candidate, prior.fontId, topScore),
    )
    .sort((left, right) => {
      if (left.fontId === prior.fontId) return -1;
      if (right.fontId === prior.fontId) return 1;
      return compareRankedCandidates(left, right);
    });
  return anchored.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    ...(confidenceAuthority
      ? {
          confidence:
            candidate.fontId === prior.fontId
              ? confidenceAuthority.confidence
              : 0,
        }
      : {}),
  }));
}

function isChapterPriorCandidateEligible(
  candidate: RankedFontCandidateV2 | undefined,
): boolean {
  const rawRank = candidate?.rawPixelRank;
  return Boolean(
    candidate?.renderStatus === "rendered" &&
    Number.isInteger(rawRank) &&
    Number(rawRank) >= 1 &&
    Number(rawRank) <= MAXIMUM_CHAPTER_PRIOR_RAW_RANK &&
    candidate.totalScore > 0,
  );
}

function resolveApplicablePrior(
  workState: FontMatchingWorkStateV2 | undefined,
  runtimePolicy: FontMatchingRuntimePolicy,
): {
  fontId: string;
  scoreBoost: number;
} | null {
  const fontId = workState?.bodyConsistencyFontId;
  const scoreBoost = workState?.bodyConsistencyScoreBoost;
  if (
    workState?.automaticStrategy !== "body_consistency_soft" ||
    !fontId ||
    !Number.isFinite(scoreBoost) ||
    Number(scoreBoost) <= 0
  ) {
    return null;
  }
  const boundedScoreBoost = Math.min(
    Number(scoreBoost),
    runtimePolicy.chapterPrior.maximumScoreContribution,
  );
  if (boundedScoreBoost <= 0) return null;
  return {
    fontId,
    scoreBoost: boundedScoreBoost,
  };
}

function promoteMatchingCandidate(
  candidate: RankedFontCandidateV2,
  fontId: string,
  topScore: number,
): RankedFontCandidateV2 {
  if (candidate.fontId !== fontId) return candidate;
  return {
    ...candidate,
    totalScore: topScore,
    reasonCodes: [
      ...new Set([...candidate.reasonCodes, "episode_body_consistency_prior"]),
    ],
  };
}

function recordBodyObservation(
  observationsByRole: Map<FontMatchingSemanticRole, BodyFontObservation[]>,
  role: FontMatchingSemanticRole,
  result: FontMatchingDecisionResultV2,
  selectedFontId: string,
  inference: VerifiedAutomaticFontPixelInferenceV2 | null | undefined,
  runtimePolicy: FontMatchingRuntimePolicy,
): void {
  if (
    !inference ||
    inference.localEvidence.noneAcceptable ||
    prefersBlockLocalVisualEvidence(inference.sourceStyle)
  ) {
    return;
  }
  const localTop = resolveIndependentLocalTop(inference);
  const observationConfidence = Math.min(
    inference.localEvidence.calibratedConfidence,
    localTop?.confidence ?? 0,
  );
  if (
    localTop?.fontId !== selectedFontId ||
    observationConfidence <
      runtimePolicy.automaticMutation.minimumAutomaticConfidence ||
    result.audit.roleConfidence <
      runtimePolicy.automaticMutation.minimumRoleConfidence
  ) {
    return;
  }
  appendUniqueObservation(observationsByRole, role, {
    evidenceKey: `${inference.pageId}\u0000${inference.blockId}`,
    fontId: selectedFontId,
    confidence: observationConfidence,
    orientation: inference.treatment.orientation,
    sourceStyle: inference.sourceStyle,
  });
}

function appendUniqueObservation(
  observationsByRole: Map<FontMatchingSemanticRole, BodyFontObservation[]>,
  role: FontMatchingSemanticRole,
  observation: BodyFontObservation,
): void {
  const observations = observationsByRole.get(role) ?? [];
  if (
    observations.some((entry) => entry.evidenceKey === observation.evidenceKey)
  ) {
    return;
  }
  observations.push(observation);
  if (observations.length > MAXIMUM_OBSERVATIONS_PER_ROLE) {
    observations.splice(0, observations.length - MAXIMUM_OBSERVATIONS_PER_ROLE);
  }
  observationsByRole.set(role, observations);
}

function resolveIndependentLocalTop(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): RankedFontCandidateV2 | undefined {
  return [...inference.localEvidence.rankedCandidates]
    .filter((candidate) => candidate.renderStatus === "rendered")
    .sort(compareRankedCandidates)[0];
}

function resolveBodyConsistencyPrior(
  observations: readonly BodyFontObservation[],
  inference: VerifiedAutomaticFontPixelInferenceV2,
  runtimePolicy: FontMatchingRuntimePolicy,
): { fontId: string; scoreBoost: number } | null {
  const matching = observations.filter(
    (observation) =>
      observation.orientation === inference.treatment.orientation &&
      sourceStyleDistance(observation.sourceStyle, inference.sourceStyle) !==
        null,
  );
  const minimumSupport = runtimePolicy.chapterPrior.minimumAnchorEvidenceCount;
  if (matching.length < minimumSupport) return null;
  const winner = selectWinningFontVote(matching);
  if (!winner) return null;
  const [fontId, vote] = winner;
  if (
    vote.count < minimumSupport ||
    vote.count / matching.length < MINIMUM_PRIOR_SHARE ||
    vote.confidence / vote.count <
      runtimePolicy.automaticMutation.minimumAutomaticConfidence
  ) {
    return null;
  }
  return {
    fontId,
    scoreBoost: Math.min(
      runtimePolicy.chapterPrior.maximumScoreContribution,
      0.035 + vote.count * 0.005,
    ),
  };
}

function selectWinningFontVote(
  observations: readonly BodyFontObservation[],
): [string, { count: number; confidence: number }] | undefined {
  const votes = new Map<string, { count: number; confidence: number }>();
  for (const observation of observations) {
    const current = votes.get(observation.fontId) ?? {
      count: 0,
      confidence: 0,
    };
    current.count += 1;
    current.confidence += observation.confidence;
    votes.set(observation.fontId, current);
  }
  return [...votes].sort(
    ([leftId, left], [rightId, right]) =>
      right.count - left.count ||
      right.confidence - left.confidence ||
      compareStrings(leftId, rightId),
  )[0];
}

function prefersBlockLocalVisualEvidence(
  sourceStyle: FontMatchingSourceStyleV2,
): boolean {
  return (
    (sourceStyle.handwritten ?? 0) >= 0.58 ||
    (sourceStyle.irregularity ?? 0) >= 0.62
  );
}

function sourceStyleDistance(
  left: FontMatchingSourceStyleV2,
  right: FontMatchingSourceStyleV2,
): number | null {
  const leftUnknown = new Set(left.unknownFields);
  const rightUnknown = new Set(right.unknownFields);
  const distances: number[] = [];
  // Family continuity is based on glyph morphology only. Weight and energy are
  // presentation-level signals and must not split an otherwise identical family.
  for (const axis of FAMILY_STYLE_AXES) {
    if (leftUnknown.has(axis) || rightUnknown.has(axis)) continue;
    const leftValue = left[axis];
    const rightValue = right[axis];
    if (leftValue === null || rightValue === null) continue;
    const distance = Math.abs(leftValue - rightValue);
    if (
      CRITICAL_STYLE_AXES.has(axis) &&
      distance > MAXIMUM_CRITICAL_AXIS_DISTANCE
    ) {
      return null;
    }
    distances.push(distance);
  }
  if (distances.length < MINIMUM_STYLE_AXES) return null;
  const average =
    distances.reduce((total, distance) => total + distance, 0) /
    distances.length;
  return average <= MAXIMUM_STYLE_DISTANCE ? average : null;
}

function compareRankedCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
): number {
  return (
    right.totalScore - left.totalScore ||
    left.rank - right.rank ||
    compareStrings(left.fontId, right.fontId)
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
