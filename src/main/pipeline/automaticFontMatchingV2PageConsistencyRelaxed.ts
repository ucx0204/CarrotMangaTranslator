import {
  isAutomaticFontPageTransferEligible,
  isStableAutomaticFontBodyCandidate,
  resolveAutomaticFontCalibratedBodyFamily,
  resolveAutomaticFontCalibratedPixelWinner,
  selectAutomaticFontPageAnchor,
  type AutomaticFontPrintedFamily,
} from "./automaticFontMatchingV2PageFamily";
import { hasVariantGeometry } from "./automaticFontMatchingV2PageConsistencyGeometryMetrics";
import {
  type AutomaticFontPageConsistencyState,
  candidatePixelScore,
  comparePixelCandidates,
  normalizeBbox,
  resolveBestEligibleBodyCandidate,
  resolveVariantMass,
  type PageEvidenceRow,
} from "./automaticFontMatchingV2PageConsistencyShared";

const MAXIMUM_GLOBAL_DISTANCE_DELTA = 0.28;
const MAXIMUM_COMPONENT_DISTANCE_DELTA = 0.3;
const MAXIMUM_COMPONENT_FILL_DELTA = 0.18;
const RELAXED_MAXIMUM_FOREGROUND_LUMA_DELTA = 20;
const MINIMUM_GEOMETRIC_VARIANT_BODY_MASS = 0.15;
const MINIMUM_SINGLE_RECOVERED_BODY_MASS = 0.5;
const MINIMUM_LONG_VARIANT_COMPONENTS = 15;
const MINIMUM_LONG_VARIANT_TOP_TWO_MARGIN = 0.32;
const MAXIMUM_SHORT_DOMINANT_VARIANT_COMPONENTS = 10;
const MINIMUM_SHORT_DOMINANT_VARIANT_TOP_TWO_MARGIN = 0.35;
const MINIMUM_EMPHASIS_GLOBAL_DISTANCE = 1.35;
const MAXIMUM_EMPHASIS_FOREGROUND_LUMA = 40;
const MINIMUM_EXTREME_WIDE_CAPTION_ASPECT_RATIO = 8;

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

type RelaxedBodyAnchor = Readonly<{
  anchor: PageBodyAnchor;
  seedRows: readonly PageEvidenceRow[];
  seedBodyMass: number;
}>;

/**
 * Handle pages where neutral R5 heads leave too few strict seeds or split one
 * printed family between several Korean body faces. Geometry guards keep
 * captions, handwriting, SFX, and compact emphasis local.
 */
export function applyRelaxedNeutralGlyphConsensus(
  states: Map<string, AutomaticFontPageConsistencyState>,
  rows: readonly PageEvidenceRow[],
): void {
  const resolved = resolveRelaxedBodyAnchor(rows);
  if (!resolved) return;
  const baseline = resolveGlyphBaseline(resolved.seedRows);
  if (!baseline) return;
  const eligibleRows = rows.filter((row) =>
    isRelaxedConsensusEligible(row, resolved.anchor, baseline),
  );
  const minimumRows =
    resolved.seedRows.length === 1 && resolved.seedBodyMass < 0.5 ? 3 : 2;
  if (eligibleRows.length < minimumRows) return;

  for (const row of eligibleRows) {
    states.set(row.inference.blockId, {
      ...states.get(row.inference.blockId),
      mode: "page_anchor",
      anchorFontId: resolved.anchor.fontId,
      anchorEvidenceCount: resolved.anchor.evidenceCount,
      anchorSupportShare: resolved.anchor.supportShare,
      printedFamily: resolved.anchor.family,
      recoveredBody: true,
      ordinaryMorphologyConsensus: true,
    });
  }
}

function resolveRelaxedBodyAnchor(
  rows: readonly PageEvidenceRow[],
): RelaxedBodyAnchor | null {
  const calibratedSeeds = rows.filter(
    (row) =>
      row.strongBodySeed &&
      resolveAutomaticFontCalibratedBodyFamily(row.inference) !== null &&
      !hasExtremeWideCaptionGeometry(row),
  );
  // Two body winners are too little evidence to decide whether they are a
  // regular/emphasis pair. One clean exemplar may repair noisy non-body rows,
  // while three or more repeated body crops can safely resolve font scatter.
  if (calibratedSeeds.length === 2) return null;
  const calibrated = resolveRelaxedAnchorFromSeedGroups(calibratedSeeds, false);
  if (calibrated) return calibrated;

  const recoveredSeeds = rows.filter(
    (row) =>
      row.recoveredBody &&
      row.family !== null &&
      !hasExtremeWideCaptionGeometry(row),
  );
  return resolveRelaxedAnchorFromSeedGroups(recoveredSeeds, true);
}

function resolveRelaxedAnchorFromSeedGroups(
  rows: readonly PageEvidenceRow[],
  requireRecoveredSupport: boolean,
): RelaxedBodyAnchor | null {
  const groups = (["serif", "sans"] as const)
    .map((family) => ({
      family,
      rows: rows.filter((row) => row.family === family),
    }))
    .filter((group) => group.rows.length > 0)
    .sort(
      (left, right) =>
        right.rows.length - left.rows.length ||
        left.family.localeCompare(right.family),
    );
  const winner = groups[0];
  const runner = groups[1];
  if (!winner || (runner && runner.rows.length === winner.rows.length)) {
    return null;
  }
  const seedBodyMass = median(
    winner.rows.map((row) => 1 - resolveVariantMass(row.inference)),
  );
  if (
    requireRecoveredSupport &&
    winner.rows.length < 2 &&
    seedBodyMass < MINIMUM_SINGLE_RECOVERED_BODY_MASS
  ) {
    return null;
  }
  const anchor = resolveRelaxedFontAnchor(winner.rows, winner.family);
  return anchor ? { anchor, seedRows: winner.rows, seedBodyMass } : null;
}

function resolveRelaxedFontAnchor(
  rows: readonly PageEvidenceRow[],
  family: AutomaticFontPrintedFamily,
): PageBodyAnchor | null {
  if (rows.length === 1) {
    const row = rows[0];
    if (!row) return null;
    const candidate =
      resolveAutomaticFontCalibratedBodyFamily(row.inference) === family
        ? resolveAutomaticFontCalibratedPixelWinner(row.inference)
        : resolveBestEligibleBodyCandidate(row.inference, family);
    return candidate
      ? {
          fontId: candidate.fontId,
          family,
          evidenceCount: 1,
          supportShare: 1,
          seedCount: 1,
        }
      : null;
  }
  const selected = selectAutomaticFontPageAnchor(
    rows.map(({ inference }) => inference),
    family,
    0,
  );
  return selected ? { ...selected, family, seedCount: rows.length } : null;
}

function isRelaxedConsensusEligible(
  row: PageEvidenceRow,
  anchor: PageBodyAnchor,
  baseline: GlyphBaseline,
): boolean {
  const morphology = row.inference.glyphMorphology;
  if (
    !morphology ||
    row.inference.treatment.distortion !== "none" ||
    hasExtremeWideCaptionGeometry(row)
  ) {
    return false;
  }
  const target = row.inference.localEvidence.rankedCandidates.find(
    (candidate) =>
      candidate.fontId === anchor.fontId &&
      isStableAutomaticFontBodyCandidate(candidate, anchor.family),
  );
  if (
    !target ||
    hasLongDominantVariant(row) ||
    hasShortDominantHeavyVariant(row)
  ) {
    return false;
  }
  if (
    row.strongBodySeed &&
    row.family === anchor.family &&
    isAutomaticFontPageTransferEligible(target)
  ) {
    return true;
  }
  if (hasLowBodyMassVariantEvidence(row, morphology)) return false;
  return isNearRelaxedGlyphBaseline(morphology, baseline);
}

function hasLowBodyMassVariantEvidence(
  row: PageEvidenceRow,
  morphology: NonNullable<PageEvidenceRow["inference"]["glyphMorphology"]>,
): boolean {
  if (
    1 - resolveVariantMass(row.inference) >=
    MINIMUM_GEOMETRIC_VARIANT_BODY_MASS
  ) {
    return false;
  }
  if (hasEmphasisGlyphRange(row)) return true;
  return (
    hasVariantGeometry(row.item) &&
    morphology.globalForegroundDistanceMean >= MINIMUM_EMPHASIS_GLOBAL_DISTANCE
  );
}

function hasShortDominantHeavyVariant(row: PageEvidenceRow): boolean {
  if (row.dohyeonMorphologyVeto) return false;
  const morphology = row.inference.glyphMorphology;
  if (
    !morphology ||
    morphology.connectedComponentCount >
      MAXIMUM_SHORT_DOMINANT_VARIANT_COMPONENTS ||
    morphology.globalForegroundDistanceMean < MINIMUM_EMPHASIS_GLOBAL_DISTANCE
  ) {
    return false;
  }
  const ordered = [...row.inference.localEvidence.rankedCandidates].sort(
    comparePixelCandidates,
  );
  const winner = ordered[0];
  if (!winner || isStableAutomaticFontBodyCandidate(winner, null)) return false;
  return (
    candidatePixelScore(winner) - candidatePixelScore(ordered[1] ?? null) >=
    MINIMUM_SHORT_DOMINANT_VARIANT_TOP_TWO_MARGIN
  );
}

function hasLongDominantVariant(row: PageEvidenceRow): boolean {
  if (row.dohyeonMorphologyVeto) return false;
  const morphology = row.inference.glyphMorphology;
  if (
    !morphology ||
    morphology.connectedComponentCount < MINIMUM_LONG_VARIANT_COMPONENTS
  ) {
    return false;
  }
  const ordered = [...row.inference.localEvidence.rankedCandidates].sort(
    comparePixelCandidates,
  );
  const winner = ordered[0];
  if (!winner || isStableAutomaticFontBodyCandidate(winner, null)) return false;
  return (
    candidatePixelScore(winner) - candidatePixelScore(ordered[1] ?? null) >=
    MINIMUM_LONG_VARIANT_TOP_TWO_MARGIN
  );
}

function hasExtremeWideCaptionGeometry(row: PageEvidenceRow): boolean {
  const bbox = normalizeBbox(row.item?.bbox);
  return Boolean(
    bbox &&
    row.item?.direction === "horizontal" &&
    bbox.w / bbox.h >= MINIMUM_EXTREME_WIDE_CAPTION_ASPECT_RATIO,
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

function resolveGlyphBaseline(
  rows: readonly PageEvidenceRow[],
): GlyphBaseline | null {
  const morphologies = rows.flatMap(({ inference }) =>
    inference.glyphMorphology ? [inference.glyphMorphology] : [],
  );
  if (morphologies.length < 1) return null;
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

function isNearRelaxedGlyphBaseline(
  morphology: NonNullable<PageEvidenceRow["inference"]["glyphMorphology"]>,
  baseline: GlyphBaseline,
): boolean {
  return (
    Math.abs(
      morphology.globalForegroundDistanceMean - baseline.globalDistance,
    ) <= MAXIMUM_GLOBAL_DISTANCE_DELTA &&
    Math.abs(
      morphology.medianComponentDistanceMean - baseline.componentDistance,
    ) <= MAXIMUM_COMPONENT_DISTANCE_DELTA &&
    Math.abs(morphology.medianComponentFill - baseline.componentFill) <=
      MAXIMUM_COMPONENT_FILL_DELTA &&
    Math.abs(morphology.foregroundMeanLuma - baseline.foregroundLuma) <=
      RELAXED_MAXIMUM_FOREGROUND_LUMA_DELTA
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
