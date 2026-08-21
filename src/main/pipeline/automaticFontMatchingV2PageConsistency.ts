import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";
import { resolveAutomaticFontCalibratedPixelWinner } from "./automaticFontMatchingV2PageFamily";
import { buildInitialEvidenceRow } from "./automaticFontMatchingV2PageConsistencyEvidence";
import { buildPageConsistencyPlan } from "./automaticFontMatchingV2PageConsistencyPlan";
import { applyPageConsistencyToCandidates } from "./automaticFontMatchingV2PageConsistencySelection";
import type {
  AutomaticFontPageConsistencyState,
  PageGeometryItem,
} from "./automaticFontMatchingV2PageConsistencyShared";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const DEFAULT_LOCAL_OVERRIDE_MINIMUM_SCORE_MARGIN = 0.12;

/**
 * Build page-local body anchors from verified candidate scores and OCR
 * geometry. Translation text and genre remain outside this boundary. Explicit
 * high-confidence sound/dialogue roles only stop geometry from mistaking
 * short speech for display text or sound effects for balloon body text; they
 * never choose the font.
 */
export function buildAutomaticFontPageConsistencyPlan(
  inferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | null
    | undefined
  )[],
  items: readonly PageGeometryItem[] = [],
): ReadonlyMap<string, AutomaticFontPageConsistencyState> {
  return buildPageConsistencyPlan(inferences, items);
}

export function mergeAutomaticFontPageConsistencyState(
  workState: FontMatchingWorkStateV2 | undefined,
  pageState: AutomaticFontPageConsistencyState | undefined,
  localOverrideMinimumScoreMargin = DEFAULT_LOCAL_OVERRIDE_MINIMUM_SCORE_MARGIN,
): FontMatchingWorkStateV2 | undefined {
  if (!pageState) return workState;
  return {
    ...workState,
    ...(pageState.mode === "local_visual_variant"
      ? { automaticStrategy: "local_visual_first" as const }
      : {}),
    pageBalloonConsistencyMode: pageState.mode,
    pageBalloonAnchorFontId: pageState.anchorFontId ?? null,
    pageBalloonAnchorEvidenceCount: pageState.anchorEvidenceCount,
    pageBalloonAnchorSupportShare: pageState.anchorSupportShare ?? null,
    pageBalloonPrintedFamily: pageState.printedFamily ?? null,
    pageBalloonRecoveredBody: pageState.recoveredBody ?? false,
    pageBalloonGeometryComponentForced:
      pageState.geometryComponentForced ?? false,
    pageBalloonOrdinaryMorphologyConsensus:
      pageState.ordinaryMorphologyConsensus === true,
    pageBalloonStableMeanConsensus: pageState.stableMeanConsensus === true,
    pageBalloonEmphasisMorphologyConsensus:
      pageState.emphasisMorphologyConsensus === true,
    pageBalloonDohyeonMorphologyVeto: pageState.dohyeonMorphologyVeto ?? false,
    pageBalloonDohyeonDominanceClusterRescue:
      pageState.dohyeonDominanceClusterRescue === true,
    pageBalloonDohyeonMorphologyRecoveryFontId:
      pageState.dohyeonMorphologyRecoveryFontId ?? null,
    pageBalloonDohyeonMorphologyRecoveryRoute:
      pageState.dohyeonMorphologyRecoveryRoute ?? null,
    pageBalloonLocalOverrideMinimumScoreMargin: localOverrideMinimumScoreMargin,
    pageBalloonWeightBaseline: null,
    pageBalloonWeightBaselineSampleCount: 0,
  };
}

/**
 * Promote only an eligible body target. Manual locks still resolve later at a
 * higher decision priority, while confidence transfer stays inside raw top3
 * or the sealed supervised-acceptable boundary.
 */
export function applyAutomaticFontPageConsistency(
  candidates: readonly RankedFontCandidateV2[],
  workState: FontMatchingWorkStateV2 | undefined,
): RankedFontCandidateV2[] {
  return applyPageConsistencyToCandidates(candidates, workState);
}

export function resolvePixelConsistencyMode(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  item?: PageGeometryItem,
): AutomaticFontPageConsistencyState["mode"] | null {
  if (!resolveAutomaticFontCalibratedPixelWinner(inference)) return null;
  return buildInitialEvidenceRow(inference, item).family
    ? "stable_body"
    : "local_visual_variant";
}
