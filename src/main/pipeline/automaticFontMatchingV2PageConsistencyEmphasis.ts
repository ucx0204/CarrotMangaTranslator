import {
  isStableAutomaticFontBodyCandidate,
  resolveAutomaticFontCalibratedPixelWinner,
} from "./automaticFontMatchingV2PageFamily";
import {
  type AutomaticFontPageConsistencyState,
  candidatePixelScore,
  DOHYEON_FONT_ID,
  normalizeBbox,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";

const MAXIMUM_NEUTRAL_ROLE_CONFIDENCE = 0.08;
const NEUTRAL_HEAD_TOLERANCE = 0.005;
const MINIMUM_EMPHASIS_DOHYEON_SCORE = 0.45;
const MINIMUM_EMPHASIS_GLOBAL_DISTANCE = 1.35;
const MAXIMUM_EMPHASIS_FOREGROUND_LUMA = 40;
const MAXIMUM_EMPHASIS_GLOBAL_DISTANCE_DELTA = 0.25;
const MAXIMUM_EMPHASIS_COMPONENT_DISTANCE_DELTA = 0.35;
const MAXIMUM_EMPHASIS_COMPONENT_FILL_DELTA = 0.22;
const MAXIMUM_EMPHASIS_FOREGROUND_LUMA_DELTA = 12;
const MINIMUM_EMPHASIS_BBOX_AREA_RATIO = 0.5;

/**
 * Coordinate only unmistakably repeated heavy glyphs. This runs after the
 * ordinary-body and Dohyeon-veto passes so a compact emphasis pair can share
 * Dohyeon without leaking that display face into the chapter body prior.
 */
export function applyNeutralHeadEmphasisConsensus(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  for (const directionRows of groupNeutralRowsByDirection(rows).values()) {
    const anchors = directionRows.filter(isStrongDohyeonEmphasisAnchor);
    for (const anchorRow of anchors) {
      const cluster = directionRows.filter((row) =>
        isMatchingEmphasisGlyphRow(anchorRow, row),
      );
      if (cluster.length < 2) continue;
      for (const row of cluster) {
        states.set(row.inference.blockId, {
          ...states.get(row.inference.blockId),
          mode: "page_anchor",
          anchorFontId: DOHYEON_FONT_ID,
          anchorEvidenceCount: cluster.length,
          anchorSupportShare: 1,
          printedFamily: undefined,
          recoveredBody: false,
          geometryComponentForced: false,
          ordinaryMorphologyConsensus: false,
          emphasisMorphologyConsensus: true,
          dohyeonMorphologyVeto: false,
        });
      }
    }
  }
}

function isStrongDohyeonEmphasisAnchor(row: PageEvidenceRow): boolean {
  const winner = resolveAutomaticFontCalibratedPixelWinner(row.inference);
  return (
    winner?.fontId === DOHYEON_FONT_ID &&
    candidatePixelScore(winner) >= MINIMUM_EMPHASIS_DOHYEON_SCORE &&
    hasEmphasisGlyphRange(row)
  );
}

function isMatchingEmphasisGlyphRow(
  anchor: PageEvidenceRow,
  candidate: PageEvidenceRow,
): boolean {
  if (!hasEmphasisGlyphRange(candidate)) return false;
  const winner = resolveAutomaticFontCalibratedPixelWinner(candidate.inference);
  if (
    !winner ||
    (winner.fontId !== DOHYEON_FONT_ID &&
      !isStableAutomaticFontBodyCandidate(winner, null))
  ) {
    return false;
  }
  const target = candidate.inference.localEvidence.rankedCandidates.find(
    (entry) =>
      entry.fontId === DOHYEON_FONT_ID && entry.renderStatus === "rendered",
  );
  if (!target || !haveComparableEmphasisGeometry(anchor, candidate)) {
    return false;
  }
  const left = anchor.inference.glyphMorphology;
  const right = candidate.inference.glyphMorphology;
  if (!left || !right) return false;
  return (
    Math.abs(
      left.globalForegroundDistanceMean - right.globalForegroundDistanceMean,
    ) <= MAXIMUM_EMPHASIS_GLOBAL_DISTANCE_DELTA &&
    Math.abs(
      left.medianComponentDistanceMean - right.medianComponentDistanceMean,
    ) <= MAXIMUM_EMPHASIS_COMPONENT_DISTANCE_DELTA &&
    Math.abs(left.medianComponentFill - right.medianComponentFill) <=
      MAXIMUM_EMPHASIS_COMPONENT_FILL_DELTA &&
    Math.abs(left.foregroundMeanLuma - right.foregroundMeanLuma) <=
      MAXIMUM_EMPHASIS_FOREGROUND_LUMA_DELTA
  );
}

function hasEmphasisGlyphRange(row: PageEvidenceRow): boolean {
  const morphology = row.inference.glyphMorphology;
  return Boolean(
    morphology &&
    morphology.globalForegroundDistanceMean >=
      MINIMUM_EMPHASIS_GLOBAL_DISTANCE &&
    morphology.foregroundMeanLuma <= MAXIMUM_EMPHASIS_FOREGROUND_LUMA,
  );
}

function haveComparableEmphasisGeometry(
  leftRow: PageEvidenceRow,
  rightRow: PageEvidenceRow,
): boolean {
  const left = normalizeBbox(leftRow.item?.bbox);
  const right = normalizeBbox(rightRow.item?.bbox);
  if (!left || !right) return false;
  const leftArea = left.w * left.h;
  const rightArea = right.w * right.h;
  return (
    Math.min(leftArea, rightArea) / Math.max(leftArea, rightArea) >=
    MINIMUM_EMPHASIS_BBOX_AREA_RATIO
  );
}

function groupNeutralRowsByDirection(
  rows: readonly PageEvidenceRow[],
): Map<string, PageEvidenceRow[]> {
  const groups = new Map<string, PageEvidenceRow[]>();
  for (const row of rows) {
    if (!hasNeutralAuxiliaryHeads(row)) continue;
    const direction =
      row.item?.direction ?? row.inference.treatment.orientation;
    const group = groups.get(direction) ?? [];
    group.push(row);
    groups.set(direction, group);
  }
  return groups;
}

function hasNeutralAuxiliaryHeads(row: PageEvidenceRow): boolean {
  const style = row.inference.sourceStyle;
  return (
    row.inference.selectionCalibration.operatingFamily === "body" &&
    row.inference.rolePrediction.confidence <=
      MAXIMUM_NEUTRAL_ROLE_CONFIDENCE &&
    [
      style.serifness,
      style.weight,
      style.width,
      style.roundness,
      style.strokeContrast,
      style.handwritten,
      style.angularity,
      style.irregularity,
      style.slant,
      style.energy,
    ].every(
      (value) =>
        typeof value === "number" &&
        Math.abs(value - 0.5) <= NEUTRAL_HEAD_TOLERANCE,
    )
  );
}
