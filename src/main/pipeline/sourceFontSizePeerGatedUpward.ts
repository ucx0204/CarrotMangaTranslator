import type {
  SourceFontSizeHypothesisCandidate,
  SourceFontSizeHypothesisTrial,
} from "./sourceFontSizePeerGatedTypes";
import {
  clamp,
  maximumLineCount,
  mean,
  SOURCE_FONT_FACE_SCALE,
  valuePairRatio,
} from "./sourceFontSizePeerGatedMath";

const UPWARD_MODE_RADIUS_RATIO = 1.14;
const UPWARD_MINIMUM_COMPONENT_MASS_SHARE = 0.5;
const UPWARD_MINIMUM_BASELINE_TO_PEER_RATIO = 1.12;
const UPWARD_MINIMUM_RATIO = 1.08;
const UPWARD_MAXIMUM_RATIO = 1.25;
const UPWARD_MINIMUM_MODE_TO_PEER_RATIO = 0.82;
const UPWARD_MAXIMUM_MODE_TO_PEER_RATIO = 1.16;
const UPWARD_MAXIMUM_PROJECTION_LINE_FILL = 0.55;
const UPWARD_MINIMUM_MODE_WEIGHT = 2.8;
const UPWARD_MINIMUM_MAJOR_TRIAL_COUNT = 2;

type UpwardHypothesisPoint = Readonly<{
  confidence: number;
  face: number;
  lineCount: number;
  source: "component" | "major-band";
  weight: number;
}>;

type UpwardFaceMode = Readonly<{
  confidence: number;
  facePx: number;
  logDispersion: number;
  score: number;
  totalWeight: number;
}>;

export function selectUpwardFaceMode(
  candidate: SourceFontSizeHypothesisCandidate,
  peerCenter: number | null,
): UpwardFaceMode | null {
  if (
    !Number.isFinite(peerCenter) ||
    candidate.glyphCount < 8 ||
    Number(peerCenter) / candidate.baseline.facePx <
      UPWARD_MINIMUM_BASELINE_TO_PEER_RATIO
  ) {
    return null;
  }
  const projectionLineFill =
    candidate.baseline.facePx /
    Math.max(1, candidate.bboxCross / Math.max(1, candidate.formulaLineCount));
  if (projectionLineFill >= UPWARD_MAXIMUM_PROJECTION_LINE_FILL) return null;
  const points = collectUpwardHypothesisPoints(candidate);
  const modes = points.flatMap((center) => {
    const mode = describeUpwardFaceMode(
      candidate,
      Number(peerCenter),
      points,
      center,
    );
    return mode ? [mode] : [];
  });
  return modes.sort(compareUpwardFaceModes)[0] ?? null;
}

function collectUpwardHypothesisPoints(
  candidate: SourceFontSizeHypothesisCandidate,
): UpwardHypothesisPoint[] {
  const minimum = Math.max(1, candidate.formulaLineCount - 1);
  const maximum = Math.min(
    maximumLineCount(candidate.glyphCount),
    candidate.formulaLineCount + 2,
  );
  const points: UpwardHypothesisPoint[] = [];
  for (let lineCount = minimum; lineCount <= maximum; lineCount += 1) {
    const trial = candidate.trialAt(lineCount);
    if (!trial) continue;
    if (
      trial.component &&
      trial.component.primaryMassShare >= UPWARD_MINIMUM_COMPONENT_MASS_SHARE
    ) {
      const massWeight = Math.min(1, 0.5 + trial.component.primaryMassShare);
      points.push({
        confidence: trial.component.confidence,
        face: trial.component.primaryFace * SOURCE_FONT_FACE_SCALE,
        lineCount,
        source: "component",
        weight: trial.component.confidence * massWeight,
      });
    }
    points.push(...majorBandPoints(trial));
  }
  return points.filter(
    (point) =>
      Number.isFinite(point.face) && point.face >= 4 && point.face <= 512,
  );
}

function describeUpwardFaceMode(
  candidate: SourceFontSizeHypothesisCandidate,
  peerCenter: number,
  points: readonly UpwardHypothesisPoint[],
  center: UpwardHypothesisPoint,
): UpwardFaceMode | null {
  const members = points.filter(
    (point) =>
      valuePairRatio(point.face, center.face) <= UPWARD_MODE_RADIUS_RATIO,
  );
  const componentTrials = new Set(
    members
      .filter((point) => point.source === "component")
      .map((point) => point.lineCount),
  );
  const majorTrials = new Set(
    members
      .filter((point) => point.source === "major-band")
      .map((point) => point.lineCount),
  );
  if (
    componentTrials.size < 1 ||
    majorTrials.size < UPWARD_MINIMUM_MAJOR_TRIAL_COUNT
  ) {
    return null;
  }
  const facePx = weightedMedian(members);
  if (facePx === null) return null;
  const upwardRatio = facePx / candidate.baseline.facePx;
  const modeToPeer = facePx / peerCenter;
  const totalWeight = members.reduce((sum, point) => sum + point.weight, 0);
  if (
    upwardRatio < UPWARD_MINIMUM_RATIO ||
    upwardRatio > UPWARD_MAXIMUM_RATIO ||
    modeToPeer < UPWARD_MINIMUM_MODE_TO_PEER_RATIO ||
    modeToPeer > UPWARD_MAXIMUM_MODE_TO_PEER_RATIO ||
    totalWeight < UPWARD_MINIMUM_MODE_WEIGHT
  ) {
    return null;
  }
  const logDispersion = mean(
    members.map((point) => Math.abs(Math.log(point.face / facePx))),
  );
  return {
    confidence: clamp(
      mean(members.map((point) => point.confidence)) - logDispersion * 0.25,
      0.5,
      0.9,
    ),
    facePx,
    logDispersion,
    score:
      totalWeight +
      majorTrials.size * 0.12 +
      componentTrials.size * 0.08 -
      logDispersion,
    totalWeight,
  };
}

function majorBandPoints(
  trial: SourceFontSizeHypothesisTrial,
): UpwardHypothesisPoint[] {
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

function weightedMedian(
  points: readonly UpwardHypothesisPoint[],
): number | null {
  const sorted = [...points].sort((left, right) => left.face - right.face);
  const totalWeight = sorted.reduce((sum, point) => sum + point.weight, 0);
  let running = 0;
  for (const point of sorted) {
    running += point.weight;
    if (running >= totalWeight / 2) return point.face;
  }
  return sorted.at(-1)?.face ?? null;
}

function compareUpwardFaceModes(
  left: UpwardFaceMode,
  right: UpwardFaceMode,
): number {
  return (
    right.score - left.score ||
    left.logDispersion - right.logDispersion ||
    left.facePx - right.facePx
  );
}
