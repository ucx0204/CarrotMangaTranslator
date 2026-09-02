import type {
  SourceFontSizeHypothesisCandidate,
  SourceFontSizeHypothesisTrial,
} from "./sourceFontSizePeerGatedTypes";
import {
  clamp,
  maximumLineCount,
  mean,
  median,
  SOURCE_FONT_FACE_SCALE,
  valuePairRatio,
} from "./sourceFontSizePeerGatedMath";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometryTypes";

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
const NARROW_MINIMUM_GLYPHS = 8;
const NARROW_MAXIMUM_GLYPHS = 48;
const NARROW_MINIMUM_ASPECT_RATIO = 2.5;
const NARROW_MINIMUM_FORMULA_LINES = 2;
const NARROW_MAXIMUM_FORMULA_LINES = 4;
const NARROW_MAXIMUM_BASELINE_CONFIDENCE = 0.75;
const NARROW_MINIMUM_PROJECTION_CONFIDENCE = 0.8;
const NARROW_MINIMUM_MAJOR_CONFIDENCE = 0.69;
const NARROW_MAXIMUM_PROJECTION_MAJOR_RATIO = 1.1;
const NARROW_MINIMUM_CONNECTED_MASS_SHARE = 0.9;
const NARROW_MINIMUM_CONNECTED_COLUMN_RATIO = 1.35;
const NARROW_MAXIMUM_CONNECTED_COLUMN_RATIO = 2.05;
const NARROW_MINIMUM_UPWARD_RATIO = 1.3;
const NARROW_MAXIMUM_UPWARD_RATIO = 1.7;
const NARROW_MINIMUM_PEER_CONFIDENCE = 0.65;
const NARROW_MINIMUM_PEER_GLYPHS = 4;
const NARROW_MINIMUM_SUPPORTING_PEERS = 2;
const NARROW_MAXIMUM_SUPPORTING_PEER_RATIO = 1.35;
const NARROW_MINIMUM_PROPOSAL_TO_PEER_RATIO = 0.75;
const NARROW_MAXIMUM_PROPOSAL_TO_PEER_RATIO = 1.2;

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

type PageCandidateEstimate = Readonly<{
  candidate: SourceFontSizeHypothesisCandidate;
  estimate: SourceFontSizeEstimate;
  index: number;
}>;

/**
 * Recover a low-confidence narrow vertical item only when reducing the
 * formula line count by exactly one makes the candidate's own projection and
 * writing-axis pitch agree. A dominant connected span is treated as evidence
 * that several joined glyphs were mistaken for one glyph face, not as the
 * replacement value. Nearby page estimates only accept the tier.
 */
export function refineNarrowVerticalLineCountRecoveries(
  candidates: readonly SourceFontSizeHypothesisCandidate[],
  estimates: readonly SourceFontSizeEstimate[],
): readonly SourceFontSizeEstimate[] {
  const page = candidates.map((candidate, index) => ({
    candidate,
    estimate: estimates[index] ?? candidate.baseline,
    index,
  }));
  return page.map(
    (entry) => selectNarrowVerticalLineRecovery(entry, page) ?? entry.estimate,
  );
}

function selectNarrowVerticalLineRecovery(
  entry: PageCandidateEstimate,
  page: readonly PageCandidateEstimate[],
): SourceFontSizeEstimate | null {
  const { candidate, estimate } = entry;
  if (!isNarrowVerticalRecoveryCandidate(candidate)) return null;
  const trial = candidate.trialAt(candidate.formulaLineCount - 1);
  if (!hasNarrowVerticalRecoveryGeometry(trial)) return null;
  const projectionFace = trial.projection.facePx;
  const majorFace = trial.majorPitch.face * SOURCE_FONT_FACE_SCALE;
  if (
    valuePairRatio(projectionFace, majorFace) >
    NARROW_MAXIMUM_PROJECTION_MAJOR_RATIO
  ) {
    return null;
  }
  const facePx = Math.sqrt(projectionFace * majorFace);
  const connectedFace = trial.component.primaryFace * SOURCE_FONT_FACE_SCALE;
  const connectedColumnRatio = connectedFace / Math.max(1, facePx);
  const upwardRatio = facePx / Math.max(1, estimate.facePx);
  if (
    connectedColumnRatio < NARROW_MINIMUM_CONNECTED_COLUMN_RATIO ||
    connectedColumnRatio > NARROW_MAXIMUM_CONNECTED_COLUMN_RATIO ||
    upwardRatio < NARROW_MINIMUM_UPWARD_RATIO ||
    upwardRatio > NARROW_MAXIMUM_UPWARD_RATIO
  ) {
    return null;
  }
  const peers = page.filter(
    (peer) =>
      peer.index !== entry.index &&
      peer.candidate.glyphCount >= NARROW_MINIMUM_PEER_GLYPHS &&
      peer.estimate.confidence >= NARROW_MINIMUM_PEER_CONFIDENCE &&
      peer.estimate.facePx >= 6 &&
      peer.estimate.facePx <= 96 &&
      valuePairRatio(peer.estimate.facePx, facePx) <=
        NARROW_MAXIMUM_SUPPORTING_PEER_RATIO,
  );
  if (peers.length < NARROW_MINIMUM_SUPPORTING_PEERS) return null;
  const peerCenter = median(peers.map((peer) => peer.estimate.facePx));
  const proposalToPeer = facePx / Math.max(1, peerCenter);
  if (
    proposalToPeer < NARROW_MINIMUM_PROPOSAL_TO_PEER_RATIO ||
    proposalToPeer > NARROW_MAXIMUM_PROPOSAL_TO_PEER_RATIO
  ) {
    return null;
  }
  const geometryDisagreement = Math.abs(
    Math.log(projectionFace / Math.max(1, majorFace)),
  );
  return {
    confidence: clamp(
      Math.min(trial.projection.confidence, trial.majorPitch.confidence) -
        geometryDisagreement * 0.12,
      0.5,
      0.9,
    ),
    facePx,
    method: "raster-core-v1",
  };
}

function isNarrowVerticalRecoveryCandidate(
  candidate: SourceFontSizeHypothesisCandidate,
): boolean {
  return Boolean(
    candidate.direction === "vertical" &&
    candidate.glyphCount >= NARROW_MINIMUM_GLYPHS &&
    candidate.glyphCount <= NARROW_MAXIMUM_GLYPHS &&
    candidate.bboxMajor / Math.max(1, candidate.bboxCross) >=
      NARROW_MINIMUM_ASPECT_RATIO &&
    candidate.formulaLineCount >= NARROW_MINIMUM_FORMULA_LINES &&
    candidate.formulaLineCount <= NARROW_MAXIMUM_FORMULA_LINES &&
    candidate.baseline.confidence < NARROW_MAXIMUM_BASELINE_CONFIDENCE,
  );
}

function hasNarrowVerticalRecoveryGeometry(
  trial: SourceFontSizeHypothesisTrial | null,
): trial is SourceFontSizeHypothesisTrial & {
  component: NonNullable<SourceFontSizeHypothesisTrial["component"]>;
  majorPitch: NonNullable<SourceFontSizeHypothesisTrial["majorPitch"]>;
  projection: NonNullable<SourceFontSizeHypothesisTrial["projection"]>;
} {
  return Boolean(
    trial?.projection &&
    trial.projection.confidence >= NARROW_MINIMUM_PROJECTION_CONFIDENCE &&
    trial.majorPitch &&
    trial.majorPitch.confidence >= NARROW_MINIMUM_MAJOR_CONFIDENCE &&
    trial.component &&
    trial.component.primaryMassShare >= NARROW_MINIMUM_CONNECTED_MASS_SHARE,
  );
}

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
