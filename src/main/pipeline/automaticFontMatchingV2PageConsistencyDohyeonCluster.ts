import { resolveAutomaticFontCalibratedPixelWinner } from "./automaticFontMatchingV2PageFamily";
import {
  type AutomaticFontPageConsistencyState,
  candidatePixelScore,
  comparePixelCandidates,
  DOHYEON_FONT_ID,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const MINIMUM_TOP1_SCORE = 0.87;
const MINIMUM_TOP1_MARGIN = 0.82;
const MAXIMUM_RAW_RANK = 5;
const MAXIMUM_COSINE_DISTANCE = 0.02;
const MINIMUM_NEIGHBORHOOD_SIZE = 3;

/**
 * Rescue only vetoed rows directly neighboring a verified Dohyeon seed. This
 * deliberately rejects transitive A-B-C propagation even when both edges are
 * individually close.
 */
export function applyDohyeonDominanceClusterRescues(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  for (const group of groupDominantRows(rows).values()) {
    const rescuedBlockIds = collectSeedNeighborhood(group);
    for (const row of group) {
      rescueVetoedLocalRow(states, row, rescuedBlockIds);
    }
  }
}

function rescueVetoedLocalRow(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  rescuedBlockIds: ReadonlySet<string>,
): void {
  if (!rescuedBlockIds.has(row.inference.blockId)) return;
  const state = states.get(row.inference.blockId);
  if (
    state?.mode !== "local_visual_variant" ||
    state.dohyeonMorphologyVeto !== true
  ) {
    return;
  }
  states.set(row.inference.blockId, {
    ...state,
    dohyeonMorphologyVeto: false,
    dohyeonDominanceClusterRescue: true,
  });
}

function groupDominantRows(
  rows: readonly PageEvidenceRow[],
): Map<string, PageEvidenceRow[]> {
  const groups = new Map<string, PageEvidenceRow[]>();
  for (const row of rows) {
    if (!hasDominantRawWinner(row.inference)) continue;
    const direction =
      row.item?.direction ?? row.inference.treatment.orientation;
    const key = `${row.inference.pageId}:${direction}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function hasDominantRawWinner(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): boolean {
  const ranked = renderedCandidates(inference).sort(comparePixelCandidates);
  const winner = ranked[0];
  if (winner?.fontId !== DOHYEON_FONT_ID) return false;
  const winnerScore = candidatePixelScore(winner);
  return (
    winnerScore >= MINIMUM_TOP1_SCORE &&
    winnerScore - candidatePixelScore(ranked[1] ?? null) >= MINIMUM_TOP1_MARGIN
  );
}

function collectSeedNeighborhood(
  rows: readonly PageEvidenceRow[],
): Set<string> {
  const rescuedBlockIds = new Set<string>();
  for (const seed of rows.filter(isVerifiedSeed)) {
    const neighborhood = rows.filter(
      (row) =>
        rawTopFiveCosineDistance(seed.inference, row.inference) <=
        MAXIMUM_COSINE_DISTANCE,
    );
    if (neighborhood.length < MINIMUM_NEIGHBORHOOD_SIZE) continue;
    for (const row of neighborhood) {
      rescuedBlockIds.add(row.inference.blockId);
    }
  }
  return rescuedBlockIds;
}

function isVerifiedSeed(row: PageEvidenceRow): boolean {
  return (
    !row.dohyeonMorphologyVeto &&
    resolveAutomaticFontCalibratedPixelWinner(row.inference)?.fontId ===
      DOHYEON_FONT_ID
  );
}

function rawTopFiveCosineDistance(
  left: VerifiedAutomaticFontPixelInferenceV2,
  right: VerifiedAutomaticFontPixelInferenceV2,
): number {
  const leftScores = rawTopFiveScoreMap(left);
  const rightScores = rawTopFiveScoreMap(right);
  const fontIds = new Set([...leftScores.keys(), ...rightScores.keys()]);
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (const fontId of fontIds) {
    const leftScore = leftScores.get(fontId) ?? 0;
    const rightScore = rightScores.get(fontId) ?? 0;
    dot += leftScore * rightScore;
    leftSquared += leftScore * leftScore;
    rightSquared += rightScore * rightScore;
  }
  if (leftSquared <= 0 || rightSquared <= 0) return Number.POSITIVE_INFINITY;
  const similarity = dot / Math.sqrt(leftSquared * rightSquared);
  return 1 - Math.min(1, Math.max(-1, similarity));
}

function rawTopFiveScoreMap(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): Map<string, number> {
  return new Map(
    renderedCandidates(inference)
      .filter((candidate) => isRawRankInRange(candidate.rawPixelRank))
      .map((candidate) => [candidate.fontId, candidatePixelScore(candidate)]),
  );
}

function renderedCandidates(inference: VerifiedAutomaticFontPixelInferenceV2) {
  return inference.localEvidence.rankedCandidates.filter(
    (candidate) => candidate.renderStatus === "rendered",
  );
}

function isRawRankInRange(rawRank: number | undefined): boolean {
  return Boolean(
    Number.isInteger(rawRank) &&
    Number(rawRank) >= 1 &&
    Number(rawRank) <= MAXIMUM_RAW_RANK,
  );
}
