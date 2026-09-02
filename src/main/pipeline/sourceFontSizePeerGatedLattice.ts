import type { SourceTextDirection } from "../../shared/textTypes";
import { measureComponentAffinity } from "./sourceFontSizeComponentAffinity";
import { estimateSourceFontFace } from "./sourceFontSizeGeometry";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";
import {
  clamp,
  estimateLineCount,
  isPlausibleLineCount,
  maximumLineCount,
  maximumValueRatio,
  mean,
  SOURCE_FONT_FACE_SCALE,
  valuePairRatio,
} from "./sourceFontSizePeerGatedMath";
import {
  isStablePeerCandidate,
  isStableUpwardPeerCandidate,
  selectPagePeerCenter,
} from "./sourceFontSizePeerGatedPeers";
import type {
  SourceFontSizeHypothesisCandidate,
  SourceFontSizeHypothesisTrial,
} from "./sourceFontSizePeerGatedTypes";
import {
  refineNarrowVerticalLineCountRecoveries,
  selectUpwardFaceMode,
} from "./sourceFontSizePeerGatedUpward";
import { measureMajorAxisPitch } from "./sourceFontSizeMajorPitch";
import type { SourceFontCoreMask } from "./sourceFontSizeRaster";

const MAXIMUM_LINE_DISTANCE = 2;
const MODE_RADIUS_RATIO = 1.18;
const MINIMUM_COMPONENT_MASS_SHARE = 0.18;
const MINIMUM_DOWNWARD_RATIO = 1.22;
const MINIMUM_MODE_WEIGHT = 1.45;

type HypothesisPoint = Readonly<{
  confidence: number;
  face: number;
  lineCount: number;
  source: "component" | "major-band" | "projection";
  weight: number;
}>;

type RepeatedFaceMode = Readonly<{
  confidence: number;
  facePx: number;
  logDispersion: number;
  score: number;
  sources: ReadonlySet<HypothesisPoint["source"]>;
  totalWeight: number;
  trialSourceCount: number;
}>;

/**
 * Build one lazily evaluated line-count lattice. The formula trial is shared
 * by peer selection and correction, while neighboring trials are only opened
 * for a structurally suspect high outlier.
 */
export function createSourceFontSizeHypothesisCandidate(input: {
  baseline: SourceFontSizeEstimate;
  core: SourceFontCoreMask;
  direction: SourceTextDirection;
  glyphCount: number;
}): SourceFontSizeHypothesisCandidate {
  const { baseline, core, direction, glyphCount } = input;
  const bboxCross = direction === "vertical" ? core.width : core.height;
  const bboxMajor = direction === "vertical" ? core.height : core.width;
  const formulaLineCount = estimateLineCount(glyphCount, bboxCross, bboxMajor);
  const trialCache = new Map<number, SourceFontSizeHypothesisTrial>();
  return {
    baseline,
    bboxCross,
    bboxMajor,
    direction,
    formulaLineCount,
    glyphCount,
    trialAt: (lineCount) => {
      if (!isPlausibleLineCount(lineCount, glyphCount)) return null;
      const cached = trialCache.get(lineCount);
      if (cached) return cached;
      const trial = measureHypothesisTrial(
        core,
        direction,
        glyphCount,
        lineCount,
      );
      trialCache.set(lineCount, trial);
      return trial;
    },
  };
}

/**
 * Correct only candidates whose own repeated geometry mode agrees with a
 * stable page-body peer cluster. The peer center is an acceptance gate and is
 * never copied into the result.
 */
export function refinePageSourceFontSizeHypotheses(
  candidates: readonly SourceFontSizeHypothesisCandidate[],
): readonly SourceFontSizeEstimate[] {
  const peerCenter = selectPagePeerCenter(candidates, isStablePeerCandidate);
  const upwardPeerCenter = selectPagePeerCenter(
    candidates,
    isStableUpwardPeerCandidate,
  );
  const refined = candidates.map((candidate) =>
    resolvePeerGatedCandidate(candidate, peerCenter, upwardPeerCenter),
  );
  return refineNarrowVerticalLineCountRecoveries(candidates, refined);
}

function measureHypothesisTrial(
  core: SourceFontCoreMask,
  direction: SourceTextDirection,
  glyphCount: number,
  lineCount: number,
): SourceFontSizeHypothesisTrial {
  return {
    component: measureComponentAffinity(core, direction, lineCount),
    lineCount,
    majorPitch: measureMajorAxisPitch(core, direction, glyphCount, lineCount),
    projection: estimateSourceFontFace(core, direction, glyphCount, {
      componentAffinity: false,
      lineCountOverride: lineCount,
    }),
  };
}

function resolvePeerGatedCandidate(
  candidate: SourceFontSizeHypothesisCandidate,
  peerCenter: number | null,
  upwardPeerCenter: number | null,
): SourceFontSizeEstimate {
  if (canOpenNeighboringTrials(candidate, peerCenter)) {
    const mode = selectRepeatedFaceMode(candidate);
    if (mode && peerGateAccepts(candidate, mode, Number(peerCenter))) {
      return {
        confidence: mode.confidence,
        facePx: mode.facePx,
        method: "raster-core-v1",
      };
    }
  }
  const upwardMode = selectUpwardFaceMode(candidate, upwardPeerCenter);
  if (upwardMode) {
    return {
      confidence: upwardMode.confidence,
      facePx: upwardMode.facePx,
      method: "raster-core-v1",
    };
  }
  return candidate.baseline;
}

function canOpenNeighboringTrials(
  candidate: SourceFontSizeHypothesisCandidate,
  peerCenter: number | null,
): boolean {
  if (
    !Number.isFinite(peerCenter) ||
    candidate.glyphCount < 8 ||
    candidate.baseline.facePx / Math.max(1, Number(peerCenter)) < 1.24
  ) {
    return false;
  }
  const suspicion = formulaSuspicion(candidate);
  return suspicion.geometryRatio >= 1.3 || suspicion.bandRatio > 2;
}

function selectRepeatedFaceMode(
  candidate: SourceFontSizeHypothesisCandidate,
): RepeatedFaceMode | null {
  const points = collectHypothesisPoints(candidate);
  const modes = points.flatMap((center) =>
    describeRepeatedFaceMode(candidate, points, center),
  );
  return modes.sort(compareRepeatedFaceModes)[0] ?? null;
}

function collectHypothesisPoints(
  candidate: SourceFontSizeHypothesisCandidate,
): HypothesisPoint[] {
  const minimum = Math.max(
    1,
    candidate.formulaLineCount - MAXIMUM_LINE_DISTANCE,
  );
  const maximum = Math.min(
    maximumLineCount(candidate.glyphCount),
    candidate.formulaLineCount + MAXIMUM_LINE_DISTANCE,
  );
  const points: HypothesisPoint[] = [];
  for (let lineCount = minimum; lineCount <= maximum; lineCount += 1) {
    const trial = candidate.trialAt(lineCount);
    if (trial) points.push(...hypothesisPointsFromTrial(trial));
  }
  return points.filter(
    (point) =>
      Number.isFinite(point.face) && point.face >= 4 && point.face <= 512,
  );
}

function hypothesisPointsFromTrial(
  trial: SourceFontSizeHypothesisTrial,
): HypothesisPoint[] {
  const points: HypothesisPoint[] = [];
  if (trial.projection) {
    points.push({
      confidence: trial.projection.confidence,
      face: trial.projection.facePx,
      lineCount: trial.lineCount,
      source: "projection",
      weight: trial.projection.confidence,
    });
  }
  if (
    trial.component &&
    trial.component.primaryMassShare >= MINIMUM_COMPONENT_MASS_SHARE
  ) {
    const massWeight = Math.min(1, 0.5 + trial.component.primaryMassShare);
    points.push({
      confidence: trial.component.confidence,
      face: trial.component.primaryFace * SOURCE_FONT_FACE_SCALE,
      lineCount: trial.lineCount,
      source: "component",
      weight: trial.component.confidence * massWeight,
    });
  }
  points.push(...majorBandPoints(trial));
  return points;
}

function majorBandPoints(
  trial: SourceFontSizeHypothesisTrial,
): HypothesisPoint[] {
  const measurement = trial.majorPitch;
  if (!measurement?.bandFaces.length) return [];
  const weight =
    measurement.confidence / Math.sqrt(measurement.bandFaces.length);
  return measurement.bandFaces.map((face) => ({
    confidence: measurement.confidence,
    face: face * SOURCE_FONT_FACE_SCALE,
    lineCount: trial.lineCount,
    source: "major-band",
    weight,
  }));
}

function describeRepeatedFaceMode(
  candidate: SourceFontSizeHypothesisCandidate,
  points: readonly HypothesisPoint[],
  center: HypothesisPoint,
): RepeatedFaceMode[] {
  const members = points.filter(
    (point) => valuePairRatio(point.face, center.face) <= MODE_RADIUS_RATIO,
  );
  const sources = new Set(members.map((point) => point.source));
  const trialSources = new Set(
    members.map((point) => `${point.lineCount}:${point.source}`),
  );
  if (!sources.has("projection") || sources.size < 2 || trialSources.size < 3) {
    return [];
  }
  const facePx = weightedMedian(members);
  const totalWeight = members.reduce((sum, point) => sum + point.weight, 0);
  if (
    facePx === null ||
    candidate.baseline.facePx / facePx < MINIMUM_DOWNWARD_RATIO ||
    totalWeight < MINIMUM_MODE_WEIGHT
  ) {
    return [];
  }
  const logDispersion = mean(
    members.map((point) => Math.abs(Math.log(point.face / facePx))),
  );
  const confidence = clamp(
    mean(members.map((point) => point.confidence)) - logDispersion * 0.25,
    0.5,
    0.9,
  );
  return [
    {
      confidence,
      facePx,
      logDispersion,
      score:
        totalWeight +
        sources.size * 0.22 +
        trialSources.size * 0.035 -
        logDispersion,
      sources,
      totalWeight,
      trialSourceCount: trialSources.size,
    },
  ];
}

function compareRepeatedFaceModes(
  left: RepeatedFaceMode,
  right: RepeatedFaceMode,
): number {
  return (
    right.score - left.score ||
    left.logDispersion - right.logDispersion ||
    right.facePx - left.facePx
  );
}

function peerGateAccepts(
  candidate: SourceFontSizeHypothesisCandidate,
  mode: RepeatedFaceMode,
  peerCenter: number,
): boolean {
  const suspicion = formulaSuspicion(candidate);
  const hasAllGeometrySources =
    mode.sources.has("projection") &&
    mode.sources.has("component") &&
    mode.sources.has("major-band");
  const partialEvidenceAllowed =
    suspicion.geometryRatio >= 2 && mode.totalWeight >= 2.4;
  const modeToPeer = mode.facePx / peerCenter;
  return Boolean(
    candidate.baseline.facePx / peerCenter >= 1.24 &&
    modeToPeer >= 0.82 &&
    modeToPeer <= 1.32 &&
    (suspicion.geometryRatio >= 1.3 || suspicion.bandRatio > 2) &&
    (hasAllGeometrySources || partialEvidenceAllowed),
  );
}

function formulaSuspicion(candidate: SourceFontSizeHypothesisCandidate): {
  bandRatio: number;
  geometryRatio: number;
} {
  const trial = candidate.trialAt(candidate.formulaLineCount);
  if (!trial) return { bandRatio: 1, geometryRatio: 1 };
  const values = [
    trial.projection?.facePx,
    trial.component?.primaryFace
      ? trial.component.primaryFace * SOURCE_FONT_FACE_SCALE
      : null,
    trial.majorPitch?.face
      ? trial.majorPitch.face * SOURCE_FONT_FACE_SCALE
      : null,
  ].filter((value): value is number => Number.isFinite(value));
  return {
    bandRatio: maximumValueRatio(trial.majorPitch?.bandFaces ?? []),
    geometryRatio: maximumValueRatio(values),
  };
}

function weightedMedian(points: readonly HypothesisPoint[]): number | null {
  const sorted = [...points].sort((left, right) => left.face - right.face);
  const totalWeight = sorted.reduce((sum, point) => sum + point.weight, 0);
  let running = 0;
  for (const point of sorted) {
    running += point.weight;
    if (running >= totalWeight / 2) return point.face;
  }
  return sorted.at(-1)?.face ?? null;
}
