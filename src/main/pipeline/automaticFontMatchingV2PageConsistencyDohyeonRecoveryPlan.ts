import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import { STABLE_BALLOON_BODY_FONT_IDS } from "./automaticFontMatchingV2PageFamily";
import {
  type AutomaticFontPageConsistencyState,
  candidatePixelScore,
  comparePixelCandidates,
  DOHYEON_FONT_ID,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";
import { resolveAutomaticInverseTextStyle } from "./automaticFontMatchingV2Polarity";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const MINIMUM_ANCHOR_EVIDENCE_COUNT = 3;
const MINIMUM_ANCHOR_SUPPORT_SHARE = 0.75;
const MINIMUM_STRONG_ANCHOR_EVIDENCE_COUNT = 4;
const MINIMUM_STRONG_ANCHOR_SUPPORT_SHARE = 0.999;
const MAXIMUM_RECOVERY_RAW_RANK = 8;
const MINIMUM_RESIDUAL_STABLE_BODY_MASS = 0.4;
const MINIMUM_RUNNER_SCORE = 0.02;
const MINIMUM_RUNNER_RESIDUAL_SHARE = 0.2;

type RecoveryRoute = NonNullable<
  AutomaticFontPageConsistencyState["dohyeonMorphologyRecoveryRoute"]
>;

type StrongPageAnchor = Readonly<{
  fontId: string;
  evidenceCount: number;
  supportShare: number;
}>;

export function applyDohyeonMorphologyRecoveryPlans(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  const strongAnchors = collectStrongPageAnchors(states, rows);
  for (const row of rows) {
    const state = states.get(row.inference.blockId);
    if (!isVetoedLocalVariant(state)) continue;
    const soundEffectRunner = isExplicitSoundEffect(row)
      ? resolveNonDohyeonTopThreeRunner(row.inference, true)
      : null;
    if (soundEffectRunner) {
      setRecoveryState(
        states,
        row,
        state,
        soundEffectRunner.fontId,
        "non_dohyeon_variant_top3",
      );
      continue;
    }
    if (applyPreferredRecovery(states, row, state, strongAnchors)) continue;
    const runner = resolveNonDohyeonTopThreeRunner(row.inference);
    if (runner) {
      setRecoveryState(states, row, state, runner.fontId, "non_dohyeon_top3");
    }
  }
}

function isExplicitSoundEffect(row: PageEvidenceRow): boolean {
  if (row.item?.textRole === "sound") return true;
  return row.item?.fontRole?.startsWith("sfx_") === true;
}

function isVetoedLocalVariant(
  state: AutomaticFontPageConsistencyState | undefined,
): state is AutomaticFontPageConsistencyState {
  return (
    state?.mode === "local_visual_variant" &&
    state.dohyeonMorphologyVeto === true
  );
}

function applyPreferredRecovery(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  state: AutomaticFontPageConsistencyState,
  strongAnchors: ReadonlyMap<string, StrongPageAnchor>,
): boolean {
  if (resolveAutomaticInverseTextStyle(row.inference.glyphMorphology)) {
    return applyInverseAnchorRecovery(states, row, state, strongAnchors);
  }
  if (applyStrongAnchorRecovery(states, row, state, strongAnchors)) {
    return true;
  }
  const bodyTarget = resolveResidualStableBodyTarget(row.inference);
  if (!bodyTarget) return false;
  setRecoveryState(
    states,
    row,
    state,
    bodyTarget.fontId,
    "residual_stable_body",
  );
  return true;
}

function applyStrongAnchorRecovery(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  state: AutomaticFontPageConsistencyState,
  strongAnchors: ReadonlyMap<string, StrongPageAnchor>,
): boolean {
  const direction = row.item?.direction ?? row.inference.treatment.orientation;
  const anchor = strongAnchors.get(direction);
  if (
    !anchor ||
    anchor.evidenceCount < MINIMUM_STRONG_ANCHOR_EVIDENCE_COUNT ||
    anchor.supportShare < MINIMUM_STRONG_ANCHOR_SUPPORT_SHARE ||
    !hasRecoveryCandidate(row, anchor.fontId)
  ) {
    return false;
  }
  setRecoveryState(
    states,
    row,
    state,
    anchor.fontId,
    "strong_page_anchor",
    anchor,
  );
  return true;
}

function applyInverseAnchorRecovery(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  state: AutomaticFontPageConsistencyState,
  strongAnchors: ReadonlyMap<string, StrongPageAnchor>,
): boolean {
  const direction = row.item?.direction ?? row.inference.treatment.orientation;
  const anchor = strongAnchors.get(direction);
  if (!anchor || !hasRecoveryCandidate(row, anchor.fontId)) return false;
  setRecoveryState(
    states,
    row,
    state,
    anchor.fontId,
    "inverse_page_anchor",
    anchor,
  );
  return true;
}

function collectStrongPageAnchors(
  states: ReadonlyMap<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): Map<string, StrongPageAnchor> {
  const byDirection = new Map<string, Map<string, StrongPageAnchor>>();
  for (const row of rows) {
    const anchor = resolveStrongAnchor(states.get(row.inference.blockId));
    if (!anchor) continue;
    const direction =
      row.item?.direction ?? row.inference.treatment.orientation;
    recordStrongAnchor(byDirection, direction, anchor);
  }
  return resolveUnambiguousAnchors(byDirection);
}

function resolveStrongAnchor(
  state: AutomaticFontPageConsistencyState | undefined,
): StrongPageAnchor | null {
  if (state?.mode !== "page_anchor" || !state.anchorFontId) return null;
  if (state.anchorEvidenceCount < MINIMUM_ANCHOR_EVIDENCE_COUNT) return null;
  const supportShare = state.anchorSupportShare ?? 0;
  if (supportShare < MINIMUM_ANCHOR_SUPPORT_SHARE) return null;
  if (!STABLE_BALLOON_BODY_FONT_IDS.has(state.anchorFontId)) return null;
  return {
    fontId: state.anchorFontId,
    evidenceCount: state.anchorEvidenceCount,
    supportShare,
  };
}

function recordStrongAnchor(
  byDirection: Map<string, Map<string, StrongPageAnchor>>,
  direction: string,
  anchor: StrongPageAnchor,
): void {
  const anchors = byDirection.get(direction) ?? new Map();
  const previous = anchors.get(anchor.fontId);
  if (!previous || isStrongerAnchor(anchor, previous)) {
    anchors.set(anchor.fontId, anchor);
  }
  byDirection.set(direction, anchors);
}

function isStrongerAnchor(
  candidate: StrongPageAnchor,
  previous: StrongPageAnchor,
): boolean {
  return (
    candidate.evidenceCount > previous.evidenceCount ||
    (candidate.evidenceCount === previous.evidenceCount &&
      candidate.supportShare > previous.supportShare)
  );
}

function resolveUnambiguousAnchors(
  byDirection: ReadonlyMap<string, ReadonlyMap<string, StrongPageAnchor>>,
): Map<string, StrongPageAnchor> {
  const resolved = new Map<string, StrongPageAnchor>();
  for (const [direction, anchors] of byDirection) {
    if (anchors.size !== 1) continue;
    const anchor = anchors.values().next().value;
    if (anchor) resolved.set(direction, anchor);
  }
  return resolved;
}

function setRecoveryState(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  state: AutomaticFontPageConsistencyState,
  fontId: string,
  route: RecoveryRoute,
  anchor?: StrongPageAnchor,
): void {
  states.set(row.inference.blockId, {
    ...state,
    ...(anchor
      ? {
          anchorFontId: anchor.fontId,
          anchorEvidenceCount: anchor.evidenceCount,
          anchorSupportShare: anchor.supportShare,
        }
      : {}),
    dohyeonMorphologyRecoveryFontId: fontId,
    dohyeonMorphologyRecoveryRoute: route,
  });
}

function hasRecoveryCandidate(row: PageEvidenceRow, fontId: string): boolean {
  return row.inference.localEvidence.rankedCandidates.some(
    (candidate) =>
      candidate.fontId === fontId &&
      candidate.renderStatus === "rendered" &&
      isRawRankInRange(candidate, MAXIMUM_RECOVERY_RAW_RANK),
  );
}

function resolveResidualStableBodyTarget(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): RankedFontCandidateV2 | null {
  const residual = renderedNonDohyeonCandidates(inference);
  const totalScore = sumCandidateScores(residual);
  if (totalScore <= 0) return null;
  const bodyCandidates = residual.filter((candidate) =>
    STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId),
  );
  if (
    sumCandidateScores(bodyCandidates) / totalScore <
    MINIMUM_RESIDUAL_STABLE_BODY_MASS
  ) {
    return null;
  }
  return (
    bodyCandidates
      .filter((candidate) =>
        isRawRankInRange(candidate, MAXIMUM_RECOVERY_RAW_RANK),
      )
      .sort(comparePixelCandidates)[0] ?? null
  );
}

function resolveNonDohyeonTopThreeRunner(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  variantsOnly = false,
): RankedFontCandidateV2 | null {
  const residual = renderedNonDohyeonCandidates(inference).filter(
    (candidate) =>
      !variantsOnly || !STABLE_BALLOON_BODY_FONT_IDS.has(candidate.fontId),
  );
  const residualScore = sumCandidateScores(residual);
  if (residualScore <= 0) return null;
  const runner = residual
    .filter((candidate) => isRawRankInRange(candidate, 3))
    .sort(comparePixelCandidates)[0];
  if (!runner) return null;
  const score = candidatePixelScore(runner);
  return score >= MINIMUM_RUNNER_SCORE &&
    score / residualScore >= MINIMUM_RUNNER_RESIDUAL_SHARE
    ? runner
    : null;
}

function renderedNonDohyeonCandidates(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): RankedFontCandidateV2[] {
  return inference.localEvidence.rankedCandidates.filter(
    (candidate) =>
      candidate.renderStatus === "rendered" &&
      candidate.fontId !== DOHYEON_FONT_ID,
  );
}

function sumCandidateScores(candidates: readonly RankedFontCandidateV2[]) {
  return candidates.reduce(
    (sum, candidate) => sum + candidatePixelScore(candidate),
    0,
  );
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
