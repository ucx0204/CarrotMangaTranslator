import {
  isStableAutomaticFontBodyCandidate,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import { hasVariantGeometry } from "./automaticFontMatchingV2PageConsistencyGeometryMetrics";
import {
  type AutomaticFontPageConsistencyState,
  candidatePixelScore,
  comparePixelCandidates,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";
import { FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION } from "./fontMatchingPagePixelPreprocessing";

const MINIMUM_ANCHOR_COUNT = 3;
const MINIMUM_ANCHOR_SUPPORT_SHARE = 0.6;
const NEUTRAL_HEAD_TOLERANCE = 0.005;
const MINIMUM_COMPONENT_COUNT = 12;
const MAXIMUM_GLOBAL_DISTANCE = 3;
const MAXIMUM_FOREGROUND_LUMA = 180;
const MAXIMUM_FOREGROUND_LUMA_DELTA = 65;
const MAXIMUM_STRICT_TOP_TWO_MARGIN = 0.5;
const MAXIMUM_STRICT_GLOBAL_DELTA = 0.24;
const MAXIMUM_STRICT_COMPONENT_DELTA = 0.4;
const MAXIMUM_STRICT_FILL_DELTA = 0.25;
const MINIMUM_CONTAMINATION_ANCHOR_COUNT = 4;
const MINIMUM_CONTAMINATION_COMPONENT_COUNT = 30;
const MINIMUM_CONTAMINATION_LUMA = 40;
const MAXIMUM_CONTAMINATION_GLOBAL_DELTA = 0.95;
const MAXIMUM_CONTAMINATION_COMPONENT_DELTA = 0.16;
const MAXIMUM_CONTAMINATION_FILL_DELTA = 0.12;

type GlyphMorphology = NonNullable<
  PageEvidenceRow["inference"]["glyphMorphology"]
>;

type AnchoredRow = Readonly<{
  row: PageEvidenceRow;
  fontId: string;
  family: AutomaticFontPrintedFamily;
}>;

type DominantAnchor = Readonly<{
  fontId: string;
  family: AutomaticFontPrintedFamily;
  evidenceCount: number;
  supportShare: number;
  rows: readonly PageEvidenceRow[];
}>;

type GlyphBaseline = Readonly<{
  globalDistance: number;
  componentDistance: number;
  componentFill: number;
  foregroundLuma: number;
}>;

/**
 * Recover only structurally substantial vertical rows that the pixel model
 * left local despite a unique, repeated stable-body page anchor. This pass is
 * deliberately last so previously recognized emphasis clusters remain local.
 */
export function applyDominantOrdinaryRecoveries(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  const anchor = resolveDominantAnchor(states, rows);
  if (!anchor) return;
  const baseline = resolveGlyphBaseline(anchor.rows);
  if (!baseline) return;
  for (const row of rows) {
    const state = states.get(row.inference.blockId);
    if (!isRecoverableRow(row, state, anchor, baseline)) continue;
    states.set(row.inference.blockId, {
      ...state,
      mode: "page_anchor",
      anchorFontId: anchor.fontId,
      anchorEvidenceCount: anchor.evidenceCount,
      anchorSupportShare: anchor.supportShare,
      printedFamily: anchor.family,
      recoveredBody: true,
      ordinaryMorphologyConsensus: true,
    });
  }
}

function resolveDominantAnchor(
  states: ReadonlyMap<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): DominantAnchor | null {
  const anchoredRows = collectAnchoredRows(states, rows);
  const counts = new Map<string, number>();
  for (const anchored of anchoredRows) {
    counts.set(anchored.fontId, (counts.get(anchored.fontId) ?? 0) + 1);
  }
  const ranked = [...counts].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (
    !winner ||
    !isQualifyingWinner(winner, runnerUp, anchoredRows, states, rows)
  ) {
    return null;
  }
  const winnerRows = anchoredRows.filter(
    (anchored) => anchored.fontId === winner[0],
  );
  const families = new Set(winnerRows.map((anchored) => anchored.family));
  const family = winnerRows[0]?.family;
  if (!family || families.size !== 1) return null;
  return {
    fontId: winner[0],
    family,
    evidenceCount: winner[1],
    supportShare: winner[1] / anchoredRows.length,
    rows: winnerRows.map((anchored) => anchored.row),
  };
}

function collectAnchoredRows(
  states: ReadonlyMap<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): AnchoredRow[] {
  return rows.flatMap((row) => {
    const state = states.get(row.inference.blockId);
    if (!state?.anchorFontId || !state.printedFamily) return [];
    if (state.emphasisMorphologyConsensus) return [];
    const candidate = row.inference.localEvidence.rankedCandidates.find(
      (entry) => entry.fontId === state.anchorFontId,
    );
    if (!candidate) return [];
    if (!isStableAutomaticFontBodyCandidate(candidate, state.printedFamily)) {
      return [];
    }
    return [{ row, fontId: state.anchorFontId, family: state.printedFamily }];
  });
}

function isQualifyingWinner(
  winner: readonly [string, number],
  runnerUp: readonly [string, number] | undefined,
  anchoredRows: readonly AnchoredRow[],
  states: ReadonlyMap<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): boolean {
  const hasStandardAnchor = winner[1] >= MINIMUM_ANCHOR_COUNT;
  const hasEmphasisSeparatedTwoAnchor =
    winner[1] === 2 &&
    anchoredRows.length === 2 &&
    hasRecognizedEmphasisPair(states, rows);
  return (
    (hasStandardAnchor || hasEmphasisSeparatedTwoAnchor) &&
    winner[1] / anchoredRows.length >= MINIMUM_ANCHOR_SUPPORT_SHARE &&
    runnerUp?.[1] !== winner[1]
  );
}

function hasRecognizedEmphasisPair(
  states: ReadonlyMap<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): boolean {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const state = states.get(row.inference.blockId);
    if (!isRecognizedEmphasisState(state)) continue;
    const fontId = state.anchorFontId;
    counts.set(fontId, (counts.get(fontId) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= 2);
}

function isRecognizedEmphasisState(
  state: AutomaticFontPageConsistencyState | undefined,
): state is AutomaticFontPageConsistencyState & { anchorFontId: string } {
  return Boolean(
    state?.mode === "page_anchor" &&
    state.anchorFontId &&
    state.anchorEvidenceCount >= 2 &&
    state.anchorSupportShare === 1 &&
    state.emphasisMorphologyConsensus === true &&
    state.ordinaryMorphologyConsensus !== true &&
    state.recoveredBody !== true,
  );
}

function isRecoverableRow(
  row: PageEvidenceRow,
  state: AutomaticFontPageConsistencyState | undefined,
  anchor: DominantAnchor,
  baseline: GlyphBaseline,
): boolean {
  const morphology = row.inference.glyphMorphology;
  if (state?.mode !== "local_visual_variant") return false;
  if (!passesCommonStructuralGate(row, anchor.fontId)) return false;
  if (!isValidMorphology(morphology)) return false;
  if (!passesCommonMorphologyGate(morphology, baseline)) {
    return false;
  }
  return (
    passesStrictRoute(row, morphology, baseline) ||
    passesContaminationRoute(morphology, anchor, baseline)
  );
}

function passesCommonStructuralGate(
  row: PageEvidenceRow,
  anchorFontId: string,
): boolean {
  return (
    hasNeutralSourceHeads(row) &&
    row.inference.selectionCalibration.operatingFamily === "body" &&
    row.inference.treatment.distortion === "none" &&
    row.item?.direction === "vertical" &&
    (row.item.candidateIds?.length ?? 0) >= 2 &&
    !hasVariantGeometry(row.item) &&
    hasRenderedAnchorCandidate(row, anchorFontId)
  );
}

function passesCommonMorphologyGate(
  morphology: GlyphMorphology,
  baseline: GlyphBaseline,
): boolean {
  return (
    morphology.connectedComponentCount >= MINIMUM_COMPONENT_COUNT &&
    morphology.globalForegroundDistanceMean <= MAXIMUM_GLOBAL_DISTANCE &&
    morphology.foregroundMeanLuma < MAXIMUM_FOREGROUND_LUMA &&
    Math.abs(morphology.foregroundMeanLuma - baseline.foregroundLuma) <=
      MAXIMUM_FOREGROUND_LUMA_DELTA
  );
}

function hasNeutralSourceHeads(row: PageEvidenceRow): boolean {
  const numericHeads = Object.values(row.inference.sourceStyle).filter(
    (value): value is number => typeof value === "number",
  );
  return (
    numericHeads.length > 0 &&
    numericHeads.every(
      (value) =>
        Number.isFinite(value) &&
        Math.abs(value - 0.5) <= NEUTRAL_HEAD_TOLERANCE,
    )
  );
}

function hasRenderedAnchorCandidate(
  row: PageEvidenceRow,
  anchorFontId: string,
): boolean {
  return row.inference.localEvidence.rankedCandidates.some(
    (candidate) =>
      candidate.fontId === anchorFontId &&
      candidate.renderStatus === "rendered",
  );
}

function passesStrictRoute(
  row: PageEvidenceRow,
  morphology: GlyphMorphology,
  baseline: GlyphBaseline,
): boolean {
  const candidates = [...row.inference.localEvidence.rankedCandidates]
    .filter((candidate) => candidate.renderStatus === "rendered")
    .sort(comparePixelCandidates);
  if (candidates.length < 2) return false;
  const margin =
    candidatePixelScore(candidates[0] ?? null) -
    candidatePixelScore(candidates[1] ?? null);
  return (
    margin < MAXIMUM_STRICT_TOP_TWO_MARGIN &&
    Math.abs(
      morphology.globalForegroundDistanceMean - baseline.globalDistance,
    ) <= MAXIMUM_STRICT_GLOBAL_DELTA &&
    Math.abs(
      morphology.medianComponentDistanceMean - baseline.componentDistance,
    ) <= MAXIMUM_STRICT_COMPONENT_DELTA &&
    Math.abs(morphology.medianComponentFill - baseline.componentFill) <=
      MAXIMUM_STRICT_FILL_DELTA
  );
}

function passesContaminationRoute(
  morphology: GlyphMorphology,
  anchor: DominantAnchor,
  baseline: GlyphBaseline,
): boolean {
  const globalDelta = Math.abs(
    morphology.globalForegroundDistanceMean - baseline.globalDistance,
  );
  return (
    anchor.evidenceCount >= MINIMUM_CONTAMINATION_ANCHOR_COUNT &&
    morphology.connectedComponentCount >=
      MINIMUM_CONTAMINATION_COMPONENT_COUNT &&
    morphology.foregroundMeanLuma >= MINIMUM_CONTAMINATION_LUMA &&
    globalDelta > MAXIMUM_STRICT_GLOBAL_DELTA &&
    globalDelta <= MAXIMUM_CONTAMINATION_GLOBAL_DELTA &&
    Math.abs(
      morphology.medianComponentDistanceMean - baseline.componentDistance,
    ) <= MAXIMUM_CONTAMINATION_COMPONENT_DELTA &&
    Math.abs(morphology.medianComponentFill - baseline.componentFill) <=
      MAXIMUM_CONTAMINATION_FILL_DELTA
  );
}

function resolveGlyphBaseline(
  rows: readonly PageEvidenceRow[],
): GlyphBaseline | null {
  const morphologies = rows.map((row) => row.inference.glyphMorphology);
  if (!morphologies.every(isValidMorphology)) return null;
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

function isValidMorphology(
  morphology: GlyphMorphology | undefined,
): morphology is GlyphMorphology {
  return Boolean(
    morphology &&
    morphology.contractVersion ===
      FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION &&
    morphology.maskSource === "raw_grayscale_otsu_minority_area3" &&
    morphology.distanceTransform === "opencv_dist_l2_mask5" &&
    morphology.connectivity === 8 &&
    Number.isInteger(morphology.connectedComponentCount) &&
    [
      morphology.globalForegroundDistanceMean,
      morphology.medianComponentDistanceMean,
      morphology.medianComponentFill,
      morphology.foregroundMeanLuma,
    ].every(Number.isFinite),
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
