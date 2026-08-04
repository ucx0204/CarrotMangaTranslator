import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";
import {
  isAutomaticFontPageTransferEligible,
  isStableAutomaticFontBodyCandidate,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import {
  applyDohyeonLocalPolicy,
  suppressDohyeonMorphologyWinner,
} from "./automaticFontMatchingV2PageConsistencyDohyeonSelection";
import {
  candidatePixelScore,
  compareCandidates,
} from "./automaticFontMatchingV2PageConsistencyShared";

const DEFAULT_LOCAL_OVERRIDE_MINIMUM_SCORE_MARGIN = 0.12;

type PageConsistencyPromotion = {
  supervisedWinner: RankedFontCandidateV2;
  target: RankedFontCandidateV2;
  usedRequestedTarget: boolean;
};

export function applyPageConsistencyToCandidates(
  candidates: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2 | undefined,
): RankedFontCandidateV2[] {
  const mode = workState?.pageBalloonConsistencyMode;
  if (!mode) return [...candidates];
  const ordered = [...candidates].sort(compareCandidates);
  const morphologyVeto = workState?.pageBalloonDohyeonMorphologyVeto === true;
  const localPolicyResult = applyDohyeonLocalPolicy(ordered, workState);
  if (localPolicyResult) return localPolicyResult;
  if (mode === "local_visual_variant") return ordered;
  return applyBodyConsistency(ordered, workState, morphologyVeto);
}

function applyBodyConsistency(
  ordered: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2,
  morphologyVeto: boolean,
): RankedFontCandidateV2[] {
  const supervisedWinner = ordered.find(hasPositiveConfidence);
  if (shouldRejectUnstableWinner(supervisedWinner, workState)) {
    return [...ordered];
  }
  const family = workState.pageBalloonPrintedFamily ?? null;
  const requestedTargetId = resolveRequestedTargetId(
    ordered,
    workState,
    family,
  );
  const promotion = resolvePageConsistencyPromotion(
    ordered,
    requestedTargetId,
    family,
    workState.pageBalloonOrdinaryMorphologyConsensus === true,
    workState.pageBalloonEmphasisMorphologyConsensus === true,
  );
  if (!promotion) return suppressUnavailablePromotion(ordered, morphologyVeto);
  if (shouldKeepLocalBodyOverride(promotion, workState)) return [...ordered];
  return promoteCandidateOrder(ordered, promotion, workState, morphologyVeto);
}

function hasPositiveConfidence(candidate: RankedFontCandidateV2): boolean {
  return candidate.confidence > 0;
}

function shouldRejectUnstableWinner(
  winner: RankedFontCandidateV2 | undefined,
  workState: FontMatchingWorkStateV2,
): boolean {
  if (!winner) return false;
  if (workState.pageBalloonRecoveredBody === true) return false;
  if (workState.pageBalloonOrdinaryMorphologyConsensus === true) return false;
  if (workState.pageBalloonEmphasisMorphologyConsensus === true) return false;
  return !isStableAutomaticFontBodyCandidate(
    winner,
    workState.pageBalloonPrintedFamily ?? null,
  );
}

function resolveRequestedTargetId(
  candidates: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2,
  family: AutomaticFontPrintedFamily | null,
): string | undefined {
  return (
    workState.pageBalloonAnchorFontId ||
    candidates.find((candidate) => isEligibleBodyTarget(candidate, family))
      ?.fontId
  );
}

function isEligibleBodyTarget(
  candidate: RankedFontCandidateV2,
  family: AutomaticFontPrintedFamily | null,
  allowOutsideTopThree = false,
): boolean {
  return (
    isStableAutomaticFontBodyCandidate(candidate, family) &&
    (allowOutsideTopThree || isAutomaticFontPageTransferEligible(candidate))
  );
}

function resolvePageConsistencyPromotion(
  candidates: readonly RankedFontCandidateV2[],
  requestedTargetId: string | undefined,
  printedFamily: AutomaticFontPrintedFamily | null,
  allowRequestedTargetOutsideTopThree: boolean,
  allowAnyRequestedTarget: boolean,
): PageConsistencyPromotion | null {
  const supervisedWinner = candidates.find(hasPositiveConfidence);
  if (!supervisedWinner) return null;
  const requestedTarget = requestedTargetId
    ? candidates.find((candidate) => candidate.fontId === requestedTargetId)
    : undefined;
  if (
    requestedTarget &&
    (allowAnyRequestedTarget
      ? requestedTarget.renderStatus === "rendered"
      : isEligibleBodyTarget(
          requestedTarget,
          printedFamily,
          allowRequestedTargetOutsideTopThree,
        ))
  ) {
    return {
      supervisedWinner,
      target: requestedTarget,
      usedRequestedTarget: true,
    };
  }
  const fallback = candidates.find((candidate) =>
    isEligibleBodyTarget(candidate, printedFamily),
  );
  return fallback
    ? { supervisedWinner, target: fallback, usedRequestedTarget: false }
    : null;
}

function shouldKeepLocalBodyOverride(
  promotion: PageConsistencyPromotion,
  workState: FontMatchingWorkStateV2,
): boolean {
  const { supervisedWinner: localWinner, target } = promotion;
  if (localWinner.fontId === target.fontId) return false;
  if (workState.pageBalloonRecoveredBody) return false;
  if (workState.pageBalloonGeometryComponentForced) return false;
  if (workState.pageBalloonEmphasisMorphologyConsensus) return false;
  const minimumMargin =
    workState.pageBalloonLocalOverrideMinimumScoreMargin ??
    DEFAULT_LOCAL_OVERRIDE_MINIMUM_SCORE_MARGIN;
  return (
    candidatePixelScore(localWinner) - candidatePixelScore(target) >=
    minimumMargin
  );
}

function promoteCandidateOrder(
  candidates: readonly RankedFontCandidateV2[],
  promotion: PageConsistencyPromotion,
  workState: FontMatchingWorkStateV2,
  morphologyVeto: boolean,
): RankedFontCandidateV2[] {
  const targetId = promotion.target.fontId;
  const promotedScore = Math.max(
    promotion.supervisedWinner.totalScore,
    promotion.target.totalScore,
  );
  const promoted = candidates.map((candidate) =>
    promoteCandidate(
      candidate,
      promotion,
      workState,
      morphologyVeto,
      promotedScore,
    ),
  );
  return promoted
    .sort((left, right) => comparePromotedCandidates(left, right, targetId))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function promoteCandidate(
  candidate: RankedFontCandidateV2,
  promotion: PageConsistencyPromotion,
  workState: FontMatchingWorkStateV2,
  morphologyVeto: boolean,
  promotedScore: number,
): RankedFontCandidateV2 {
  if (candidate.fontId !== promotion.target.fontId) return { ...candidate };
  return {
    ...candidate,
    totalScore: promotedScore,
    confidence: promotion.supervisedWinner.confidence,
    reasonCodes: buildPromotionReasonCodes(
      candidate,
      promotion,
      workState,
      morphologyVeto,
    ),
  };
}

function buildPromotionReasonCodes(
  candidate: RankedFontCandidateV2,
  promotion: PageConsistencyPromotion,
  workState: FontMatchingWorkStateV2,
  morphologyVeto: boolean,
): string[] {
  const reason = promotion.usedRequestedTarget
    ? "page_balloon_consistency_anchor"
    : "ordinary_balloon_body_palette";
  return [
    ...new Set([
      ...candidate.reasonCodes,
      reason,
      "pixel_morphology_cluster",
      "pixel_top3_transfer_boundary",
      ...(workState.pageBalloonRecoveredBody
        ? ["weak_variant_recovered_to_page_body"]
        : []),
      ...(workState.pageBalloonGeometryComponentForced
        ? ["geometry_split_component_body_anchor"]
        : []),
      ...(workState.pageBalloonOrdinaryMorphologyConsensus
        ? ["neutral_head_page_glyph_body_consensus"]
        : []),
      ...(workState.pageBalloonEmphasisMorphologyConsensus
        ? ["neutral_head_page_glyph_emphasis_consensus"]
        : []),
      ...(morphologyVeto ? ["dohyeon_glyph_morphology_veto"] : []),
      "pixel_only_policy",
    ]),
  ];
}

function comparePromotedCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
  targetId: string,
): number {
  if (left.fontId === targetId) return -1;
  if (right.fontId === targetId) return 1;
  return compareCandidates(left, right);
}

function suppressUnavailablePromotion(
  candidates: readonly RankedFontCandidateV2[],
  morphologyVeto: boolean,
): RankedFontCandidateV2[] {
  return morphologyVeto
    ? suppressDohyeonMorphologyWinner(candidates)
    : suppressUnsafeOrdinaryBalloonWinner(candidates);
}

function suppressUnsafeOrdinaryBalloonWinner(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2[] {
  return candidates.map((candidate) =>
    candidate.confidence > 0
      ? {
          ...candidate,
          confidence: 0,
          reasonCodes: [
            ...new Set([
              ...candidate.reasonCodes,
              "ordinary_balloon_no_eligible_body_candidate",
              "pixel_only_policy",
            ]),
          ],
        }
      : candidate,
  );
}
