import {
  isAutomaticFontPageTransferEligible,
  isStableAutomaticFontBodyCandidate,
  selectAutomaticFontPageAnchor,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import { hasVariantGeometry } from "./automaticFontMatchingV2PageConsistencyGeometryMetrics";
import { applyRelaxedNeutralGlyphConsensus } from "./automaticFontMatchingV2PageConsistencyRelaxed";
import {
  type AutomaticFontPageConsistencyState,
  candidatePixelScore,
  comparePixelCandidates,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";

const MINIMUM_BODY_SEEDS = 3;
const MAXIMUM_NEUTRAL_ROLE_CONFIDENCE = 0.08;
const NEUTRAL_HEAD_TOLERANCE = 0.005;
const MAXIMUM_SHORT_ROW_COMPONENTS = 10;
const MAXIMUM_AMBIGUOUS_WINNER_MARGIN = 0.1;
const MAXIMUM_GLOBAL_DISTANCE_DELTA = 0.28;
const MAXIMUM_COMPONENT_DISTANCE_DELTA = 0.3;
const MAXIMUM_COMPONENT_FILL_DELTA = 0.18;
const MAXIMUM_SHORT_COMPONENT_FILL_DELTA = 0.3;
const MAXIMUM_FOREGROUND_LUMA_DELTA = 16.5;

type PageBodyAnchor = Readonly<{
  fontId: string;
  family: AutomaticFontPrintedFamily;
  evidenceCount: number;
  supportShare: number;
  seedCount: number;
}>;

type GlyphBaseline = Readonly<{
  globalDistance: number;
  componentDistance: number;
  componentFill: number;
  foregroundLuma: number;
}>;

/**
 * R5 intentionally emits neutral auxiliary heads. In that narrow case, use
 * repeated page glyphs to repair short/ambiguous body crops without allowing
 * semantic text or a single noisy crop to flatten genuine display lettering.
 */
export function applyNeutralHeadOrdinaryConsensus(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  for (const directionRows of groupNeutralRowsByDirection(rows).values()) {
    const strongSeeds = directionRows.filter(
      (row) => row.strongBodySeed && row.directBodyFamily,
    );
    const anchor = resolvePageBodyAnchor(strongSeeds);
    const baseline = resolveGlyphBaseline(strongSeeds);
    if (anchor && baseline) {
      for (const row of directionRows) {
        applyPrimaryNeutralGlyphConsensus(states, row, anchor, baseline);
      }
    }
    applyRelaxedNeutralGlyphConsensus(states, directionRows);
  }
}

function applyPrimaryNeutralGlyphConsensus(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  anchor: PageBodyAnchor,
  baseline: GlyphBaseline,
): void {
  if (row.family) {
    applyCrossFamilyAnchor(states, row, anchor, baseline);
    return;
  }
  if (!isRecoverableOrdinaryRow(row, anchor, baseline)) return;
  states.set(row.inference.blockId, {
    ...states.get(row.inference.blockId),
    mode: "page_anchor",
    anchorFontId: anchor.fontId,
    anchorEvidenceCount: anchor.evidenceCount,
    anchorSupportShare: anchor.supportShare,
    printedFamily: anchor.family,
    recoveredBody: true,
    ordinaryMorphologyConsensus: true,
  });
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

function resolvePageBodyAnchor(
  rows: readonly PageEvidenceRow[],
): PageBodyAnchor | null {
  const candidates = (["serif", "sans"] as const).flatMap((family) => {
    const familyRows = rows.filter((row) => row.directBodyFamily === family);
    if (familyRows.length < MINIMUM_BODY_SEEDS) return [];
    const anchor = selectAutomaticFontPageAnchor(
      familyRows.map(({ inference }) => inference),
      family,
    );
    return anchor ? [{ ...anchor, family, seedCount: familyRows.length }] : [];
  });
  candidates.sort(
    (left, right) =>
      right.seedCount - left.seedCount ||
      right.evidenceCount - left.evidenceCount ||
      right.supportShare - left.supportShare ||
      left.fontId.localeCompare(right.fontId),
  );
  const winner = candidates[0];
  const runner = candidates[1];
  if (!winner || (runner && runner.seedCount === winner.seedCount)) return null;
  return winner;
}

function applyCrossFamilyAnchor(
  states: Map<string, AutomaticFontPageConsistencyState>,
  row: PageEvidenceRow,
  anchor: PageBodyAnchor,
  baseline: GlyphBaseline,
): void {
  const target = row.inference.localEvidence.rankedCandidates.find(
    (candidate) =>
      candidate.fontId === anchor.fontId &&
      isStableAutomaticFontBodyCandidate(candidate, anchor.family) &&
      (isAutomaticFontPageTransferEligible(candidate) || row.recoveredBody),
  );
  if (!target) return;
  const crossFamily = row.family !== anchor.family;
  const morphology = row.inference.glyphMorphology;
  if (
    crossFamily &&
    (!morphology ||
      !isNearGlyphBaseline(
        morphology,
        baseline,
        morphology.connectedComponentCount <= MAXIMUM_SHORT_ROW_COMPONENTS,
      ))
  ) {
    return;
  }
  states.set(row.inference.blockId, {
    ...states.get(row.inference.blockId),
    mode: "page_anchor",
    anchorFontId: anchor.fontId,
    anchorEvidenceCount: anchor.evidenceCount,
    anchorSupportShare: anchor.supportShare,
    printedFamily: anchor.family,
    ...(crossFamily ? { ordinaryMorphologyConsensus: true } : {}),
  });
}

function isRecoverableOrdinaryRow(
  row: PageEvidenceRow,
  anchor: PageBodyAnchor,
  baseline: GlyphBaseline,
): boolean {
  const morphology = row.inference.glyphMorphology;
  if (!morphology || row.inference.treatment.distortion !== "none")
    return false;
  const shortRow =
    morphology.connectedComponentCount <= MAXIMUM_SHORT_ROW_COMPONENTS;
  if (hasVariantGeometry(row.item) && !shortRow) return false;
  const ordered = [...row.inference.localEvidence.rankedCandidates].sort(
    comparePixelCandidates,
  );
  const winnerMargin =
    candidatePixelScore(ordered[0] ?? null) -
    candidatePixelScore(ordered[1] ?? null);
  if (!shortRow && winnerMargin > MAXIMUM_AMBIGUOUS_WINNER_MARGIN) {
    return false;
  }
  const target = ordered.find(
    (candidate) =>
      candidate.fontId === anchor.fontId &&
      isStableAutomaticFontBodyCandidate(candidate, anchor.family),
  );
  return Boolean(target) && isNearGlyphBaseline(morphology, baseline, shortRow);
}

function resolveGlyphBaseline(
  rows: readonly PageEvidenceRow[],
  minimumSamples = MINIMUM_BODY_SEEDS,
): GlyphBaseline | null {
  const morphologies = rows.flatMap(({ inference }) =>
    inference.glyphMorphology ? [inference.glyphMorphology] : [],
  );
  if (morphologies.length < minimumSamples) return null;
  return {
    globalDistance: median(
      morphologies.map((entry) => entry.globalForegroundDistanceMean),
    ),
    componentDistance: median(
      morphologies.map((entry) => entry.medianComponentDistanceMean),
    ),
    componentFill: median(
      morphologies.map((entry) => entry.medianComponentFill),
    ),
    foregroundLuma: median(
      morphologies.map((entry) => entry.foregroundMeanLuma),
    ),
  };
}

function isNearGlyphBaseline(
  morphology: NonNullable<PageEvidenceRow["inference"]["glyphMorphology"]>,
  baseline: GlyphBaseline,
  shortRow: boolean,
): boolean {
  return (
    Math.abs(
      morphology.globalForegroundDistanceMean - baseline.globalDistance,
    ) <= MAXIMUM_GLOBAL_DISTANCE_DELTA &&
    Math.abs(
      morphology.medianComponentDistanceMean - baseline.componentDistance,
    ) <= MAXIMUM_COMPONENT_DISTANCE_DELTA &&
    Math.abs(morphology.medianComponentFill - baseline.componentFill) <=
      (shortRow
        ? MAXIMUM_SHORT_COMPONENT_FILL_DELTA
        : MAXIMUM_COMPONENT_FILL_DELTA) &&
    Math.abs(morphology.foregroundMeanLuma - baseline.foregroundLuma) <=
      MAXIMUM_FOREGROUND_LUMA_DELTA
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
