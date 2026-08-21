import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import { STABLE_BALLOON_BODY_FONT_IDS } from "./automaticFontMatchingV2PageFamily";
import {
  candidatePixelScore,
  compareCandidates,
  compareStrings,
  DOHYEON_FONT_ID,
} from "./automaticFontMatchingV2PageConsistencyShared";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";

const MINIMUM_ANCHOR_EVIDENCE_COUNT = 3;
const MINIMUM_ANCHOR_SUPPORT_SHARE = 0.75;
const MINIMUM_STRONG_ANCHOR_EVIDENCE_COUNT = 4;
const MINIMUM_STRONG_ANCHOR_SUPPORT_SHARE = 0.999;
const MAXIMUM_RECOVERY_RAW_RANK = 8;
const MINIMUM_RESIDUAL_STABLE_BODY_MASS = 0.4;
const MINIMUM_RUNNER_SCORE = 0.02;
const MINIMUM_RUNNER_RESIDUAL_SHARE = 0.2;

type Recovery = Readonly<{
  route: NonNullable<
    FontMatchingWorkStateV2["pageBalloonDohyeonMorphologyRecoveryRoute"]
  >;
  target: RankedFontCandidateV2;
  winner: RankedFontCandidateV2;
}>;

export function applyDohyeonLocalPolicy(
  candidates: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2 | undefined,
): RankedFontCandidateV2[] | null {
  if (workState?.pageBalloonConsistencyMode !== "local_visual_variant") {
    return null;
  }
  if (workState.pageBalloonDohyeonMorphologyVeto === true) {
    const recovery = resolveRecovery(candidates, workState);
    return recovery
      ? applyRecovery(candidates, recovery)
      : suppressDohyeonMorphologyWinner(candidates);
  }
  return workState.pageBalloonDohyeonDominanceClusterRescue === true
    ? markDominanceClusterRescue(candidates)
    : null;
}

function resolveRecovery(
  candidates: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2,
): Recovery | null {
  const route = workState.pageBalloonDohyeonMorphologyRecoveryRoute;
  const targetId = workState.pageBalloonDohyeonMorphologyRecoveryFontId;
  if (!route || !targetId || targetId === DOHYEON_FONT_ID) return null;
  const winner = candidates.find(hasPositiveConfidence);
  if (winner?.fontId !== DOHYEON_FONT_ID) return null;
  const target = candidates.find((candidate) => candidate.fontId === targetId);
  if (!target || !isValidTarget(candidates, target, route, workState)) {
    return null;
  }
  return { route, target, winner };
}

function isValidTarget(
  candidates: readonly RankedFontCandidateV2[],
  target: RankedFontCandidateV2,
  route: Recovery["route"],
  workState: FontMatchingWorkStateV2,
): boolean {
  if (target.renderStatus !== "rendered") return false;
  if (route === "inverse_page_anchor") {
    return isValidInverseAnchorTarget(target, workState);
  }
  if (route === "strong_page_anchor") {
    return isValidStrongAnchorTarget(target, workState);
  }
  if (route === "residual_stable_body") {
    return isValidResidualBodyTarget(candidates, target);
  }
  if (route === "non_dohyeon_variant_top3") {
    return isValidVariantTopThreeRunner(candidates, target);
  }
  return isValidTopThreeRunner(candidates, target);
}

function isValidStrongAnchorTarget(
  target: RankedFontCandidateV2,
  workState: FontMatchingWorkStateV2,
): boolean {
  return isValidAnchorTarget(
    target,
    workState,
    MINIMUM_STRONG_ANCHOR_EVIDENCE_COUNT,
    MINIMUM_STRONG_ANCHOR_SUPPORT_SHARE,
  );
}

function isValidInverseAnchorTarget(
  target: RankedFontCandidateV2,
  workState: FontMatchingWorkStateV2,
): boolean {
  return isValidAnchorTarget(
    target,
    workState,
    MINIMUM_ANCHOR_EVIDENCE_COUNT,
    MINIMUM_ANCHOR_SUPPORT_SHARE,
  );
}

function isValidAnchorTarget(
  target: RankedFontCandidateV2,
  workState: FontMatchingWorkStateV2,
  minimumEvidenceCount: number,
  minimumSupportShare: number,
): boolean {
  return (
    target.fontId === workState.pageBalloonAnchorFontId &&
    (workState.pageBalloonAnchorEvidenceCount ?? 0) >= minimumEvidenceCount &&
    (workState.pageBalloonAnchorSupportShare ?? 0) >= minimumSupportShare &&
    STABLE_BALLOON_BODY_FONT_IDS.has(target.fontId) &&
    isRawRankInRange(target, MAXIMUM_RECOVERY_RAW_RANK)
  );
}

function isValidResidualBodyTarget(
  candidates: readonly RankedFontCandidateV2[],
  target: RankedFontCandidateV2,
): boolean {
  return (
    STABLE_BALLOON_BODY_FONT_IDS.has(target.fontId) &&
    isRawRankInRange(target, MAXIMUM_RECOVERY_RAW_RANK) &&
    resolveResidualStableBodyMass(candidates) >=
      MINIMUM_RESIDUAL_STABLE_BODY_MASS &&
    resolveBestStableRecoveryCandidate(candidates)?.fontId === target.fontId
  );
}

function isValidTopThreeRunner(
  candidates: readonly RankedFontCandidateV2[],
  target: RankedFontCandidateV2,
): boolean {
  if (resolveBestNonDohyeonTopThree(candidates)?.fontId !== target.fontId) {
    return false;
  }
  const residualScore = resolveNonDohyeonResidualScore(candidates);
  const score = candidatePixelScore(target);
  return (
    residualScore > 0 &&
    score >= MINIMUM_RUNNER_SCORE &&
    score / residualScore >= MINIMUM_RUNNER_RESIDUAL_SHARE
  );
}

function isValidVariantTopThreeRunner(
  candidates: readonly RankedFontCandidateV2[],
  target: RankedFontCandidateV2,
): boolean {
  if (
    resolveBestNonDohyeonVariantTopThree(candidates)?.fontId !== target.fontId
  ) {
    return false;
  }
  const residualScore = resolveNonDohyeonVariantResidualScore(candidates);
  const score = candidatePixelScore(target);
  return (
    residualScore > 0 &&
    score >= MINIMUM_RUNNER_SCORE &&
    score / residualScore >= MINIMUM_RUNNER_RESIDUAL_SHARE
  );
}

function applyRecovery(
  candidates: readonly RankedFontCandidateV2[],
  recovery: Recovery,
): RankedFontCandidateV2[] {
  const promotedScore = Math.max(
    recovery.winner.totalScore,
    recovery.target.totalScore,
  );
  const updated = candidates.map((candidate) =>
    updateRecoveryCandidate(candidate, recovery, promotedScore),
  );
  return updated
    .sort((left, right) =>
      comparePromotedCandidates(left, right, recovery.target.fontId),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function updateRecoveryCandidate(
  candidate: RankedFontCandidateV2,
  recovery: Recovery,
  promotedScore: number,
): RankedFontCandidateV2 {
  if (candidate.fontId === DOHYEON_FONT_ID) {
    return suppressDohyeonCandidate(candidate);
  }
  if (candidate.fontId !== recovery.target.fontId) return { ...candidate };
  return {
    ...candidate,
    totalScore: promotedScore,
    confidence: recovery.winner.confidence,
    reasonCodes: [
      ...new Set([
        ...candidate.reasonCodes,
        "dohyeon_glyph_morphology_veto",
        "dohyeon_morphology_confidence_transfer",
        resolveRecoveryReason(recovery.route),
        ...(recovery.route === "non_dohyeon_top3" ||
        recovery.route === "non_dohyeon_variant_top3"
          ? ["pixel_top3_transfer_boundary"]
          : ["pixel_raw_top8_veto_recovery_boundary"]),
        "pixel_only_policy",
      ]),
    ],
  };
}

function suppressDohyeonCandidate(
  candidate: RankedFontCandidateV2,
): RankedFontCandidateV2 {
  return {
    ...candidate,
    confidence: 0,
    reasonCodes: [
      ...new Set([
        ...candidate.reasonCodes,
        "dohyeon_glyph_morphology_veto",
        "pixel_only_policy",
      ]),
    ],
  };
}

function markDominanceClusterRescue(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2[] {
  return candidates.map((candidate) =>
    candidate.fontId === DOHYEON_FONT_ID && candidate.confidence > 0
      ? {
          ...candidate,
          reasonCodes: [
            ...new Set([
              ...candidate.reasonCodes,
              "dohyeon_same_page_top5_cluster_rescue",
              "pixel_top5_cosine_distance_0_02",
              "pixel_only_policy",
            ]),
          ],
        }
      : candidate,
  );
}

function resolveRecoveryReason(route: Recovery["route"]): string {
  if (route === "inverse_page_anchor") {
    return "inverse_page_body_anchor_after_dohyeon_veto";
  }
  if (route === "strong_page_anchor") {
    return "strong_page_anchor_after_dohyeon_veto";
  }
  if (route === "residual_stable_body") {
    return "residual_stable_body_after_dohyeon_veto";
  }
  if (route === "non_dohyeon_variant_top3") {
    return "non_dohyeon_variant_top3_after_dohyeon_veto";
  }
  return "non_dohyeon_pixel_top3_after_dohyeon_veto";
}

function resolveBestStableRecoveryCandidate(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2 | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          candidate.fontId !== DOHYEON_FONT_ID &&
          STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId) &&
          isRawRankInRange(candidate, MAXIMUM_RECOVERY_RAW_RANK),
      )
      .sort(comparePixelRecoveryCandidates)[0] ?? null
  );
}

function resolveBestNonDohyeonTopThree(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2 | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          candidate.fontId !== DOHYEON_FONT_ID &&
          isRawRankInRange(candidate, 3),
      )
      .sort(comparePixelRecoveryCandidates)[0] ?? null
  );
}

function resolveBestNonDohyeonVariantTopThree(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2 | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.renderStatus === "rendered" &&
          candidate.fontId !== DOHYEON_FONT_ID &&
          !STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId) &&
          isRawRankInRange(candidate, 3),
      )
      .sort(comparePixelRecoveryCandidates)[0] ?? null
  );
}

function resolveResidualStableBodyMass(
  candidates: readonly RankedFontCandidateV2[],
): number {
  const residualScore = resolveNonDohyeonResidualScore(candidates);
  if (residualScore <= 0) return 0;
  const bodyScore = candidates
    .filter(
      (candidate) =>
        candidate.renderStatus === "rendered" &&
        candidate.fontId !== DOHYEON_FONT_ID &&
        STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId),
    )
    .reduce((sum, candidate) => sum + candidatePixelScore(candidate), 0);
  return bodyScore / residualScore;
}

function resolveNonDohyeonResidualScore(
  candidates: readonly RankedFontCandidateV2[],
): number {
  return candidates
    .filter(
      (candidate) =>
        candidate.renderStatus === "rendered" &&
        candidate.fontId !== DOHYEON_FONT_ID,
    )
    .reduce((sum, candidate) => sum + candidatePixelScore(candidate), 0);
}

function resolveNonDohyeonVariantResidualScore(
  candidates: readonly RankedFontCandidateV2[],
): number {
  return candidates
    .filter(
      (candidate) =>
        candidate.renderStatus === "rendered" &&
        candidate.fontId !== DOHYEON_FONT_ID &&
        !STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId),
    )
    .reduce((sum, candidate) => sum + candidatePixelScore(candidate), 0);
}

function isRawRankInRange(
  candidate: Pick<RankedFontCandidateV2, "rawPixelRank">,
  maximum: number,
): boolean {
  return Boolean(
    Number.isInteger(candidate.rawPixelRank) &&
    Number(candidate.rawPixelRank) >= 1 &&
    Number(candidate.rawPixelRank) <= maximum,
  );
}

function comparePixelRecoveryCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
): number {
  return (
    Number(left.rawPixelRank ?? left.rank) -
      Number(right.rawPixelRank ?? right.rank) ||
    candidatePixelScore(right) - candidatePixelScore(left) ||
    compareStrings(left.fontId, right.fontId)
  );
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

function hasPositiveConfidence(candidate: RankedFontCandidateV2): boolean {
  return candidate.confidence > 0;
}

export function suppressDohyeonMorphologyWinner(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2[] {
  return candidates.map((candidate) =>
    candidate.fontId === DOHYEON_FONT_ID && candidate.confidence > 0
      ? suppressDohyeonCandidate(candidate)
      : candidate,
  );
}
