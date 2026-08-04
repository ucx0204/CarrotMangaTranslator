import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import type { OverlayItem } from "./types";
import {
  isAutomaticFontPageTransferEligible,
  isStableAutomaticFontBodyCandidate,
  STABLE_BALLOON_SANS_FONT_IDS,
  STABLE_BALLOON_SERIF_FONT_IDS,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";

export const DOHYEON_FONT_ID = "dohyeon";

export type PageGeometryItem = Pick<
  OverlayItem,
  "bbox" | "candidateIds" | "direction" | "type"
>;

export type AutomaticFontPageConsistencyState = Readonly<{
  mode: "stable_body" | "page_anchor" | "local_visual_variant";
  anchorFontId?: string;
  anchorEvidenceCount: number;
  anchorSupportShare?: number;
  /** Coarse family comes from eligible pixel candidates, never text or role. */
  printedFamily?: AutomaticFontPrintedFamily;
  /** True only when a weak non-body winner was recovered through pixel/geometry evidence. */
  recoveredBody?: boolean;
  /** A strict overlapping/adjacent OCR component supplied the body family. */
  geometryComponentForced?: boolean;
  /** A neutral-head row matched repeated page-body pixel morphology. */
  ordinaryMorphologyConsensus?: boolean;
  /** A narrow, heavy-glyph cluster shared one local emphasis face. */
  emphasisMorphologyConsensus?: boolean;
  /** A strong Dohyeon winner failed the raw-pixel glyph morphology gate. */
  dohyeonMorphologyVeto?: boolean;
  /** A same-page raw-top5 pixel cluster supplied enough Dohyeon corroboration. */
  dohyeonDominanceClusterRescue?: boolean;
  /** Pixel-only target authorized after rejecting a false Dohyeon winner. */
  dohyeonMorphologyRecoveryFontId?: string;
  /** Sealed evidence route that authorized the Dohyeon replacement. */
  dohyeonMorphologyRecoveryRoute?:
    | "inverse_page_anchor"
    | "strong_page_anchor"
    | "residual_stable_body"
    | "non_dohyeon_top3";
}>;

export type PageEvidenceRow = {
  inference: VerifiedAutomaticFontPixelInferenceV2;
  item?: PageGeometryItem;
  directBodyFamily: AutomaticFontPrintedFamily | null;
  strongBodySeed: boolean;
  family: AutomaticFontPrintedFamily | null;
  recoveredBody: boolean;
  geometryComponentForced: boolean;
  geometryComponentId: number | null;
  geometryComponentAnchorFontId: string | null;
  geometryComponentEvidenceCount: number;
  dohyeonMorphologyVeto: boolean;
};

export type NormalizedBbox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function resolveBestEligibleBodyCandidate(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  family: AutomaticFontPrintedFamily | null = null,
): RankedFontCandidateV2 | null {
  return (
    [...inference.localEvidence.rankedCandidates]
      .filter(
        (candidate) =>
          isStableAutomaticFontBodyCandidate(candidate, family) &&
          isAutomaticFontPageTransferEligible(candidate),
      )
      .sort(comparePixelCandidates)[0] ?? null
  );
}

export function resolveCandidateBodyFamily(
  candidate: Pick<RankedFontCandidateV2, "fontId">,
): AutomaticFontPrintedFamily | null {
  if (STABLE_BALLOON_SANS_FONT_IDS.has(candidate.fontId)) return "sans";
  return STABLE_BALLOON_SERIF_FONT_IDS.has(candidate.fontId) ? "serif" : null;
}

export function resolveVariantMass(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): number {
  let variantScore = 0;
  let totalScore = 0;
  for (const candidate of inference.localEvidence.rankedCandidates) {
    if (candidate.renderStatus !== "rendered") continue;
    const score = candidatePixelScore(candidate);
    totalScore += score;
    if (!isStableAutomaticFontBodyCandidate(candidate, null)) {
      variantScore += score;
    }
  }
  return totalScore > 0 ? variantScore / totalScore : 1;
}

export function normalizeBbox(
  bbox: OverlayItem["bbox"] | undefined,
): NormalizedBbox | null {
  if (!bbox) return null;
  const coordinates = [bbox.x, bbox.y, bbox.w, bbox.h];
  if (!coordinates.every(Number.isFinite)) return null;
  return bbox.w > 0 && bbox.h > 0 ? bbox : null;
}

export function candidatePixelScore(
  candidate: Pick<RankedFontCandidateV2, "rawPixelScore" | "totalScore"> | null,
): number {
  return Math.max(0, candidate?.rawPixelScore ?? candidate?.totalScore ?? 0);
}

export function comparePixelCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
): number {
  return (
    (left.rawPixelRank ?? left.rank) - (right.rawPixelRank ?? right.rank) ||
    candidatePixelScore(right) - candidatePixelScore(left) ||
    compareStrings(left.fontId, right.fontId)
  );
}

export function compareCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
): number {
  return (
    left.rank - right.rank ||
    right.totalScore - left.totalScore ||
    compareStrings(left.fontId, right.fontId)
  );
}

export function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function find(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root] ?? root;
  let cursor = index;
  while (parents[cursor] !== root) {
    const next = parents[cursor] ?? root;
    parents[cursor] = root;
    cursor = next;
  }
  return root;
}

export function union(parents: number[], left: number, right: number): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
